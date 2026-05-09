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

const VLM_IMAGE_PROMPT = `你是一个图片分析器。你必须且只能输出一个合法的JSON对象，不要输出任何其他文字、解释或markdown。

判断这张图片是否为表情包，然后输出JSON：

【表情包(isEmoji=true)】卡通/动漫/Q版形象、表情包风格、搞笑吐槽、萌系可爱、简洁配图表情、有情感表达的梗图
【非表情包(isEmoji=false)】手机/电脑截图、真人照片、风景照、文档/大量文字、新闻资讯、海报/广告、商品展示、代码截图、聊天记录截图、APP界面截图

输出格式（严格遵守）：
{"isEmoji":true,"description":"图片内容描述","emotions":["情感1","情感2"]}
或
{"isEmoji":false,"description":"图片内容描述","emotions":[]}

规则：
1. isEmoji为true时，emotions必须填写1-3个简短情感词（每个不超过6字），从互联网梗/meme角度分析，如"害羞""得意""无语""暴怒""撒娇""尴尬""震惊""委屈""傲娇""憨笑""困惑""疲惫""自嘲"
2. isEmoji为false时，emotions必须为空数组[]
3. description必须简洁描述图片内容
4. 只输出JSON，不要输出任何其他内容`;

const VLM_EMOJI_PROMPT = `你是一个表情包分析器。你必须且只能输出一个合法的JSON对象，不要输出任何其他文字、解释或markdown。

分析这个表情包并输出JSON：

{"isEmoji":true,"description":"表情包内容描述","emotions":["情感1","情感2","情感3"]}

规则：
1. isEmoji必须为true
2. description：从互联网梗、meme角度描述表情包内容和含义
3. emotions：必须填写1-3个简短情感词（每个不超过6字），从互联网梗/meme角度分析，如"害羞""得意""无语""暴怒""撒娇""尴尬""震惊""委屈""傲娇""憨笑""困惑""疲惫""自嘲""无奈""呆萌"
4. 只输出JSON，不要输出任何其他内容`;

const VLM_PLAIN_IMAGE_PROMPT = `你是一个图片分析器。你必须且只能输出一个合法的JSON对象，不要输出任何其他文字、解释或markdown。

{"isEmoji":true或false,"description":"图片内容简洁描述","emotions":[]}

规则：
1. isEmoji为true时emotions必须填写情感词，为false时必须为空数组[]
2. 只输出JSON，不要输出任何其他内容`;

const EMOTION_KEYWORD_MAP: Record<string, string[]> = {
  "困惑": ["困惑", "迷茫", "懵", "不解", "茫然", "不懂", "什么意思"],
  "震惊": ["震惊", "惊讶", "意外", "难以置信", "吓到", "卧槽"],
  "开心": ["开心", "高兴", "快乐", "愉快", "欢乐", "哈哈", "太好了", "棒"],
  "悲伤": ["悲伤", "难过", "伤心", "哭", "泪", "心痛", "失落"],
  "愤怒": ["愤怒", "生气", "火大", "烦", "讨厌", "可恶", "气死"],
  "尴尬": ["尴尬", "无语", "汗", "忍俊不禁", "哭笑不得"],
  "疲惫": ["疲惫", "累", "困", "无力", "心累", "撑不住", "枯竭"],
  "撒娇": ["撒娇", "害羞", "傲娇", "亲昵", "甜蜜", "脸红", "红晕"],
  "得意": ["得意", "狡黠", "得意洋洋", "自信", "嘚瑟"],
  "自嘲": ["自嘲", "无奈", "苦笑", "勉强", "不情愿"],
  "治愈": ["治愈", "温馨", "温柔", "宠溺", "可爱", "萌"],
  "恐惧": ["恐惧", "害怕", "紧张", "不安", "担心"],
  "兴奋": ["兴奋", "激动", "期待", "迫不及待"],
  "爱": ["爱", "喜欢", "心动", "想念", "亲亲", "抱抱"],
};

function extractEmotionFromDescription(description: string): string[] {
  const emotions: string[] = [];
  for (const [emotion, keywords] of Object.entries(EMOTION_KEYWORD_MAP)) {
    for (const keyword of keywords) {
      if (description.includes(keyword)) {
        if (!emotions.includes(emotion)) {
          emotions.push(emotion);
        }
        break;
      }
    }
    if (emotions.length >= 3) break;
  }
  return emotions;
}

const EMOJI_POSITIVE_KEYWORDS = ["表情包", "emoji", "meme", "梗图"];
const EMOJI_NEGATIVE_KEYWORDS = [
  "截图", "截屏", "屏幕截图", "手机截图", "电脑截图",
  "广告", "海报", "宣传", "推广", "促销", "打折", "优惠",
  "聊天记录", "聊天界面", "对话截图",
  "APP界面", "应用界面", "软件界面",
  "代码", "编程", "源码",
  "文档", "文件", "表格", "报表",
  "新闻", "资讯", "报道",
  "商品", "购物", "购买", "价格",
  "真人照片", "风景照", "自拍照",
];

function isDescriptionEmoji(description: string): boolean {
  const lower = description.toLowerCase();
  
  const hasNegative = EMOJI_NEGATIVE_KEYWORDS.some(kw => lower.includes(kw));
  if (hasNegative) {
    return false;
  }

  const hasPositive = EMOJI_POSITIVE_KEYWORDS.some(kw => lower.includes(kw));
  return hasPositive;
}

export async function processImage(
  base64Data: string,
  runtime: any,
  subType?: number,
  customPrompt?: string
): Promise<ImageProcessResult> {
  const hash = computeImageHash(base64Data);
  const format = detectImageFormat(base64Data);
  const isEmoji = isEmojiImage(subType);
  let type: "emoji" | "image" = isEmoji ? "emoji" : "image";

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
          prompt = VLM_EMOJI_PROMPT;
        } else {
          prompt = VLM_IMAGE_PROMPT;
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

              try {
                const jsonMatch = content.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                  const parsed = JSON.parse(jsonMatch[0]);
                  if (typeof parsed.isEmoji === "boolean") {
                    type = parsed.isEmoji ? "emoji" : "image";
                  }
                  if (parsed.description && typeof parsed.description === "string") {
                    description = parsed.description;
                  }
                  if (Array.isArray(parsed.emotions) && parsed.emotions.length > 0) {
                    emotionTags = parsed.emotions.filter((e: any) => typeof e === "string" && e.length <= 15);
                  }
                }
              } catch (parseError) {
                console.log(`[QQ] VLM输出非JSON格式，从描述文本检测表情包`);
              }

              if (type !== "emoji") {
                if (isDescriptionEmoji(content)) {
                  type = "emoji";
                  console.log(`[QQ] 🎭 描述文本检测到表情包关键词，更新类型为emoji`);
                }
              }

              if (type === "emoji" && (!emotionTags || emotionTags.length === 0)) {
                emotionTags = extractEmotionFromDescription(content);
                if (emotionTags.length > 0) {
                  console.log(`[QQ] 🎭 从描述提取情绪标签: [${emotionTags.join(", ")}]`);
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
        if (type !== "emoji") {
          if (isDescriptionEmoji(description)) {
            type = "emoji";
            console.log(`[QQ] 🎭 描述文本检测到表情包关键词，更新类型为emoji`);
          }
        }
        if (type === "emoji" && (!emotionTags || emotionTags.length === 0)) {
          emotionTags = extractEmotionFromDescription(description);
          if (emotionTags.length > 0) {
            console.log(`[QQ] 🎭 从描述提取情绪标签: [${emotionTags.join(", ")}]`);
          }
        }
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
    const parts: string[] = [];
    if (result.emotionTags && result.emotionTags.length > 0) {
      parts.push(`情绪：${result.emotionTags.join("、")}`);
    }
    if (result.description) {
      const shortDesc = result.description.length > 80
        ? result.description.substring(0, 80) + "..."
        : result.description;
      parts.push(shortDesc);
    }
    return parts.length > 0 ? `[表情包：${parts.join(" | ")}]` : "[表情包]";
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

const EMOJI_CHECK_PROMPT = `你是一个表情包检测器。你必须且只能输出一个合法的JSON对象，不要输出任何其他文字、解释或markdown。

判断这张图片是否适合保存为表情包：

{"isEmoji":true,"reason":"简短原因"}
或
{"isEmoji":false,"reason":"简短原因"}

【表情包 isEmoji=true】可爱萌系卡通形象、表情包风格（有情感表达）、搞笑吐槽、动漫/二次元风格表情图、简洁配图表情
【非表情包 isEmoji=false】手机/电脑截图、真人照片、风景照、文档/大量文字、新闻资讯、海报/广告、聊天记录截图、APP界面截图、代码截图

只输出JSON，不要输出任何其他内容`;

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
      
      const desc = imageResult.description || "";
      if (isDescriptionEmoji(desc)) {
        console.log(`[QQ] 🎭 表情包检测: ✅ 描述文本包含表情包关键词`);
        return true;
      }
      
      console.log(`[QQ] 🎭 表情包检测: ❌ 不是表情包`);
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
          const isEmojiResult = parsed.isEmoji === true;
          console.log(`[QQ] 🎭 表情包检测: ${isEmojiResult ? '✅ 是表情包' : '❌ 不是表情包'} - ${parsed.reason || ''}`);
          return isEmojiResult;
        }
      } catch (parseError) {
        console.log(`[QQ] 🎭 VLM输出非JSON格式，无法判定`);
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
