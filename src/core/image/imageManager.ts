import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  callWithModelRotation,
  callVLMWithModelRotation,
  getModelTaskConfig,
  getProviders,
  type ModelCallOptions,
} from "../modelCaller.js";

const IMAGE_CACHE_DIR = "D:\\OpenClaw\\.openclaw\\qq_image_cache";
const DESCRIPTION_CACHE_FILE = path.join(IMAGE_CACHE_DIR, "image_descriptions.json");

interface ImageDescriptionCache {
  [hash: string]: {
    description: string;
    type: "image" | "emoji";
    emotionTags?: string[];
    timestamp: number;
  };
}

let descriptionCache: ImageDescriptionCache = {};
let cacheInitialized = false;

async function ensureCacheDir(): Promise<void> {
  try {
    await fs.mkdir(IMAGE_CACHE_DIR, { recursive: true });
  } catch {}
}

async function loadDescriptionCache(): Promise<void> {
  if (cacheInitialized) return;
  try {
    await ensureCacheDir();
    const data = await fs.readFile(DESCRIPTION_CACHE_FILE, "utf-8");
    descriptionCache = JSON.parse(data);
  } catch {
    descriptionCache = {};
  }
  cacheInitialized = true;
}

async function saveDescriptionCache(): Promise<void> {
  try {
    await ensureCacheDir();
    await fs.writeFile(DESCRIPTION_CACHE_FILE, JSON.stringify(descriptionCache, null, 2));
  } catch (e) {
    console.warn("[QQ] 保存图片描述缓存失败:", e);
  }
}

export function computeImageHash(base64Data: string): string {
  const buffer = Buffer.from(base64Data, "base64");
  return crypto.createHash("md5").update(buffer).digest("hex");
}

export function detectImageFormat(base64Data: string): string {
  try {
    const buffer = Buffer.from(base64Data, "base64");
    if (buffer.length < 12) return "jpeg";

    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
    
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      if (isAPNG(buffer)) {
        return "apng";
      }
      return "png";
    }
    
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return "gif";
    
    if (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    )
      return "webp";

    return "jpeg";
  } catch {
    return "jpeg";
  }
}

function isAPNG(buffer: Buffer): boolean {
  try {
    if (buffer.length < 30) return false;
    
    let offset = 8;
    while (offset < buffer.length - 8) {
      const chunkLength = buffer.readUInt32BE(offset);
      const chunkType = buffer.slice(offset + 4, offset + 8).toString("ascii");
      
      if (chunkType === "acTL") {
        return true;
      }
      
      if (chunkType === "IEND") {
        break;
      }
      
      offset += 12 + chunkLength;
      
      if (offset > 10000) break;
    }
    
    return false;
  } catch {
    return false;
  }
}

export function isAnimatedFormat(format: string): boolean {
  return ["gif", "apng", "webp"].includes(format);
}

export function isEmojiImage(subType: number | undefined): boolean {
  if (subType === undefined) return false;
  return subType !== 0 && subType !== 4 && subType !== 9;
}

const DEFAULT_DESCRIPTIONS = [
  "[图片]",
  "[表情包]",
  "[图片(描述生成失败)]",
  "[图片(处理失败)]",
  "[表情包(GIF处理失败)]",
  "[表情包(VLM描述生成失败)]",
  "[表情包(处理失败)]",
  "[表情包：未知]",
];

function isDefaultDescription(description: string): boolean {
  const trimmed = description.trim();
  if (DEFAULT_DESCRIPTIONS.includes(trimmed)) return true;
  if (trimmed.startsWith("[图片(") && trimmed.endsWith(")]")) return true;
  if (trimmed.startsWith("[表情包(") && trimmed.endsWith(")]")) return true;
  return false;
}

export async function getCachedDescription(
  hash: string
): Promise<{ description: string; type: "image" | "emoji"; emotionTags?: string[] } | null> {
  await loadDescriptionCache();
  const cached = descriptionCache[hash];
  if (cached) {
    if (isDefaultDescription(cached.description)) {
      console.log(`[QQ] 📦 缓存命中但描述为默认值，将重新生成: ${cached.description}`);
      return null;
    }
    return {
      description: cached.description,
      type: cached.type,
      emotionTags: cached.emotionTags,
    };
  }
  return null;
}

export async function cacheDescription(
  hash: string,
  description: string,
  type: "image" | "emoji",
  emotionTags?: string[]
): Promise<void> {
  if (isDefaultDescription(description)) {
    console.log(`[QQ] 📦 跳过缓存默认描述: ${description}`);
    return;
  }
  await loadDescriptionCache();
  descriptionCache[hash] = {
    description,
    type,
    emotionTags,
    timestamp: Date.now(),
  };
  await saveDescriptionCache();
}

const vlmSemaphore = { count: 0, max: 3, queue: [] as (() => void)[] };

async function acquireVlmSemaphore(): Promise<void> {
  if (vlmSemaphore.count < vlmSemaphore.max) {
    vlmSemaphore.count++;
    return;
  }
  return new Promise<void>((resolve) => {
    vlmSemaphore.queue.push(resolve);
  });
}

function releaseVlmSemaphore(): void {
  const next = vlmSemaphore.queue.shift();
  if (next) {
    next();
  } else {
    vlmSemaphore.count--;
  }
}

export async function withVlmLimit<T>(fn: () => Promise<T>): Promise<T> {
  await acquireVlmSemaphore();
  try {
    return await fn();
  } finally {
    releaseVlmSemaphore();
  }
}

export async function downloadImageToBase64(url: string, retries: number = 3): Promise<string | null> {
  if (url.startsWith("base64://")) {
    return url.replace("base64://", "");
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "image/*,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`[QQ] 图片下载失败 (HTTP ${response.status}), URL: ${url.substring(0, 60)}...`);
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
          continue;
        }
        return null;
      }

      const arrayBuffer = await response.arrayBuffer();
      if (!arrayBuffer || arrayBuffer.byteLength === 0) {
        console.warn(`[QQ] 图片数据为空, URL: ${url.substring(0, 60)}...`);
        return null;
      }

      return Buffer.from(arrayBuffer).toString("base64");
    } catch (error: any) {
      const errorMsg = error?.name === "AbortError" ? "超时" : error?.message || "未知错误";
      console.warn(`[QQ] 下载图片失败 (尝试 ${attempt}/${retries}): ${errorMsg}`);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
  return null;
}

export interface ImageProcessResult {
  description: string;
  type: "image" | "emoji";
  emotionTags?: string[];
  hash: string;
}

const VLM_IMAGE_PROMPT = `这是一个图片，请详细描述图片的内容。如果是表情包，请描述表情包表达的情感和含义，并用1-2个词概括核心情感。`;

export async function processImage(
  base64Data: string,
  runtime: any,
  subType?: number,
  customPrompt?: string
): Promise<ImageProcessResult> {
  const hash = computeImageHash(base64Data);
  const format = detectImageFormat(base64Data);
  const isEmoji = isEmojiImage(subType);
  const type = isEmoji ? "emoji" : "image";

  const cached = await getCachedDescription(hash);
  if (cached) {
    console.log(`[QQ] 图片缓存命中: ${hash.substring(0, 8)}...`);
    return {
      description: cached.description,
      type: cached.type,
      emotionTags: cached.emotionTags,
      hash,
    };
  }

  return withVlmLimit(async () => {
    try {
      const cfg = runtime.config.loadConfig() as any;

      let description: string | undefined;
      let emotionTags: string[] | undefined;

      let prompt = customPrompt;
      if (!prompt) {
        if (isEmoji) {
          prompt = "这是一个表情包，请详细描述表情包所表达的情感和内容，从互联网梗、meme的角度分析。用1-2个词概括核心情感。";
        } else {
          prompt = "请简洁描述这张图片的内容。";
        }
      }

      const providers = getProviders(cfg);
      let vlmTaskConfig = getModelTaskConfig(cfg, "vlm");

      const imageConfig = cfg?.tools?.media?.image;
      if (imageConfig?.useModelTasks) {
        vlmTaskConfig = getModelTaskConfig(cfg, imageConfig.useModelTasks);
        console.log(`[QQ] 图片识别使用 modelTasks.${imageConfig.useModelTasks} 配置`);
      }

      if (vlmTaskConfig && vlmTaskConfig.models?.length) {
        console.log(`[QQ] 使用VLM模型轮播进行图片识别，共 ${vlmTaskConfig.models.length} 个模型`);

        for (let i = 0; i < vlmTaskConfig.models.length; i++) {
          const modelConfig = vlmTaskConfig.models[i];
          const providerName = modelConfig.provider;
          const modelName = modelConfig.model;

          const provider = providers[providerName];
          if (!provider) {
            console.warn(`[QQ] VLM模型 ${providerName}/${modelName} 跳过: Provider未配置`);
            continue;
          }

          const baseUrl = provider.baseUrl || provider.baseURL;
          if (!baseUrl || !provider.apiKey) {
            console.warn(`[QQ] VLM模型 ${providerName}/${modelName} 跳过: baseUrl或apiKey未配置`);
            continue;
          }

          try {
            console.log(`[QQ] 尝试图片识别 (${i + 1}/${vlmTaskConfig.models.length}): ${providerName}/${modelName}`);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 60000);

            const response = await fetch(`${baseUrl}/chat/completions`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${provider.apiKey}`,
              },
              body: JSON.stringify({
                model: modelName,
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "text", text: prompt },
                      {
                        type: "image_url",
                        image_url: {
                          url: `data:image/${format};base64,${base64Data}`,
                        },
                      },
                    ],
                  },
                ],
                max_tokens: vlmTaskConfig.maxTokens || 500,
                temperature: vlmTaskConfig.temperature ?? 0.5,
              }),
              signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
              const errorText = await response.text().catch(() => "");
              throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 100)}`);
            }

            const data = (await response.json()) as any;
            const content = data?.choices?.[0]?.message?.content;

            if (content) {
              description = content;
              console.log(`[QQ] 图片识别成功: ${providerName}/${modelName}`);

              if (isEmoji && description) {
                const emotionMatch = description.match(/情感[：:]\s*([^\n，,。]+)/);
                if (emotionMatch) {
                  emotionTags = emotionMatch[1]
                    .split(/[,，、]/)
                    .map((s) => s.trim())
                    .filter(Boolean);
                }
              }
              break;
            }
          } catch (e: any) {
            const errorMsg = e?.name === "AbortError" ? "超时" : e?.message || String(e);
            console.warn(`[QQ] 模型 ${providerName}/${modelName} 失败: ${errorMsg}`);
            continue;
          }
        }
      }

      if (!description) {
        const imageConfig = cfg?.tools?.media?.image;
        if (imageConfig?.enabled && imageConfig?.models?.length > 0) {
          const models = imageConfig.models;

          for (let i = 0; i < models.length; i++) {
            const modelConfig = models[i];
            try {
              console.log(`[QQ] 尝试图片识别 (备用 ${i + 1}/${models.length}): ${modelConfig.provider}/${modelConfig.model}`);

              const result = await runtime.mediaUnderstanding.describeImageFileWithModel({
                filePath: path.join(os.tmpdir(), `qq_img_${Date.now()}.${format}`),
                cfg: cfg,
                provider: modelConfig.provider,
                model: modelConfig.model,
                prompt: prompt,
                maxTokens: 500,
              });

              if (result?.description) {
                description = result.description;
                console.log(`[QQ] 图片识别成功(备用): ${modelConfig.provider}/${modelConfig.model}`);
                break;
              }
            } catch (e: any) {
              console.warn(`[QQ] 模型 ${modelConfig.provider}/${modelConfig.model} 失败:`, e?.message || e);
              continue;
            }
          }
        }
      }

      if (!description) {
        try {
          const tempDir = os.tmpdir();
          const ext = format === "gif" ? "gif" : format === "png" ? "png" : "jpg";
          const tempPath = path.join(tempDir, `qq_img_${Date.now()}.${ext}`);
          await fs.writeFile(tempPath, Buffer.from(base64Data, "base64"));

          const result = await runtime.mediaUnderstanding.describeImageFile({
            filePath: tempPath,
            cfg: cfg,
          });
          description = result?.text;

          await fs.unlink(tempPath).catch(() => {});
        } catch (e) {
          console.warn("[QQ] describeImageFile 失败:", e);
        }
      }

      if (description) {
        await cacheDescription(hash, description, type, emotionTags);
      }

      return {
        description: description || (isEmoji ? "[表情包]" : "[图片]"),
        type,
        emotionTags,
        hash,
      };
    } catch (error) {
      console.error("[QQ] 图片处理失败:", error);
      return {
        description: isEmoji ? "[表情包]" : "[图片]",
        type,
        hash,
      };
    }
  });
}

export function formatImageDescription(result: ImageProcessResult): string {
  if (result.type === "emoji") {
    if (result.emotionTags && result.emotionTags.length > 0) {
      return `[表情包：${result.emotionTags.join("，")}]`;
    }
    return `[表情包：${result.description}]`;
  }
  return `[图片：${result.description}]`;
}

export class ImageManager {
  async initialize(): Promise<void> {
    await loadDescriptionCache();
  }

  async processImage(
    base64Data: string,
    runtime: any,
    subType?: number,
    customPrompt?: string
  ): Promise<ImageProcessResult> {
    return processImage(base64Data, runtime, subType, customPrompt);
  }

  formatDescription(result: ImageProcessResult): string {
    return formatImageDescription(result);
  }
}

let imageManagerInstance: ImageManager | null = null;

export function getImageManager(): ImageManager {
  if (!imageManagerInstance) {
    imageManagerInstance = new ImageManager();
  }
  return imageManagerInstance;
}

export async function initializeImageManager(): Promise<void> {
  const manager = getImageManager();
  await manager.initialize();
}

const EMOJI_CHECK_PROMPT = `判断这张图片是否适合保存为表情包。

【表情包特征】
- 可爱、萌系的卡通形象
- 表情包风格的图片（有情感表达）
- 搞笑、吐槽类的图片
- 动漫/二次元风格的表情图
- 简洁的配图表情

【不是表情包】
- 手机/电脑截图（有UI元素、界面）
- 真人照片
- 风景照
- 文档/大量文字的图片
- 新闻/资讯类图片
- 复杂的海报/广告

请只回复 JSON 格式：
{
  "isEmoji": true/false,
  "reason": "简短原因"
}`;

function isLikelyEmojiBySize(base64Data: string): boolean {
  try {
    const buffer = Buffer.from(base64Data, "base64");
    const sizeKB = buffer.length / 1024;
    
    if (sizeKB > 500) return false;
    if (sizeKB < 5) return false;
    
    return true;
  } catch {
    return true;
  }
}

export async function checkIfEmoji(
  base64Data: string,
  runtime: any,
  skipVLM: boolean = false,
  imageResult?: ImageProcessResult
): Promise<boolean> {
  try {
    const buffer = Buffer.from(base64Data, "base64");
    const sizeKB = buffer.length / 1024;
    
    console.log(`[QQ] 🖼️ 图片大小: ${sizeKB.toFixed(1)} KB`);
    
    if (sizeKB > 10240) {
      console.log(`[QQ] 🎭 表情包检测: ❌ 图片太大 (${(sizeKB / 1024).toFixed(1)} MB > 10 MB)，不是表情包`);
      return false;
    }
    
    if (sizeKB < 5) {
      console.log(`[QQ] 🎭 表情包检测: ❌ 图片太小 (${sizeKB.toFixed(1)} KB < 5 KB)，不是表情包`);
      return false;
    }
    
    if (skipVLM) {
      console.log(`[QQ] 🎭 表情包检测: ✅ 跳过VLM检测，默认保存为表情包`);
      return true;
    }
    
    if (imageResult) {
      if (imageResult.type === "emoji") {
        console.log(`[QQ] 🎭 表情包检测: ✅ 图片识别结果类型为表情包`);
        return true;
      }
      
      const desc = imageResult.description.toLowerCase();
      const emojiKeywords = ['表情包', 'emoji', 'meme', 'q版', '动漫风格', '卡通', '萌', '可爱', '二次元', '插画', '特写'];
      const hasEmojiKeyword = emojiKeywords.some(keyword => desc.includes(keyword));
      
      if (hasEmojiKeyword) {
        console.log(`[QQ] 🎭 表情包检测: ✅ 描述包含表情包关键词`);
        return true;
      }
      
      console.log(`[QQ] 🎭 表情包检测: ❌ 描述不包含表情包关键词`);
      return false;
    }
    
    const cfg = runtime.config.loadConfig() as any;
    const providers = getProviders(cfg);
    const vlmTaskConfig = getModelTaskConfig(cfg, "vlm");

    if (!vlmTaskConfig || !vlmTaskConfig.models?.length) {
      console.log(`[QQ] ⚠️ VLM未配置，默认保存为表情包`);
      return true;
    }

    const hash = computeImageHash(base64Data);
    const cached = await getCachedDescription(hash);
    if (cached && cached.type === "emoji") {
      console.log(`[QQ] 📦 缓存命中: 是表情包`);
      return true;
    }

    const format = detectImageFormat(base64Data);

    console.log(`[QQ] 🎭 使用VLM模型轮播检测表情包，共 ${vlmTaskConfig.models.length} 个模型`);
    
    const result = await callVLMWithModelRotation(providers, vlmTaskConfig, {
      prompt: EMOJI_CHECK_PROMPT,
      imageBase64: base64Data,
      imageFormat: format,
      maxTokens: 100,
      timeout: 60000,
    });

    if (result.success && result.content) {
      console.log(`[QQ] 🎭 VLM检测成功: ${result.provider}/${result.model}`);
      
      try {
        const jsonMatch = result.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const isEmoji = parsed.isEmoji === true;
          console.log(`[QQ] 🎭 表情包检测: ${isEmoji ? '✅ 是表情包' : '❌ 不是表情包'} - ${parsed.reason || ''}`);
          return isEmoji;
        }
      } catch (parseError) {
        const lowerDesc = result.content.toLowerCase();
        if (lowerDesc.includes('"isemoji": true') || lowerDesc.includes('"isEmoji": true')) {
          console.log(`[QQ] 🎭 表情包检测: ✅ 是表情包 (文本匹配)`);
          return true;
        }
        if (lowerDesc.includes('表情包') || lowerDesc.includes('emoji') || lowerDesc.includes('meme')) {
          console.log(`[QQ] 🎭 表情包检测: ✅ 是表情包 (关键词匹配)`);
          return true;
        }
      }
    } else {
      console.warn(`[QQ] ⚠️ VLM检测失败: ${result.error}，默认保存为表情包`);
      return true;
    }

    console.log(`[QQ] 🎭 表情包检测: ❌ 不是表情包`);
    return false;
  } catch (error) {
    console.error("[QQ] 表情包检测出错，默认保存:", error);
    return true;
  }
}
