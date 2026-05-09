import * as fs from "fs";
import * as path from "path";
import {
  computeImageHash,
  getCachedDescription,
  cacheDescription,
  processImage,
  formatImageDescription,
  type ImageProcessResult,
} from "../image/imageManager.js";
import {
  callWithModelRotation,
  getModelTaskConfig,
  getProviders,
  type ModelCallOptions,
} from "../modelCaller.js";

interface EmojiRecord {
  hash: string;
  fullPath: string;
  filename: string;
  description: string;
  emotion: string[];
  usageCount: number;
  lastUsedTime: number;
  registerTime: number;
  format: string;
  isDeleted: boolean;
}

const EMOJI_EMOTION_PROMPT = `你是一个表情包情感分析器。你必须且只能输出一个合法的JSON对象，不要输出任何其他文字、解释或markdown。

表情包描述：'{description}'

从互联网梗、meme角度分析其情感，输出JSON：

{"emotions":["情感1","情感2"]}

规则：
1. 必须填写1-3个简短情感词，每个不超过6字
2. 参考词汇："害羞""得意""无语""暴怒""撒娇""尴尬""震惊""委屈""傲娇""憨笑""困惑""疲惫""自嘲""无奈""呆萌""开心""悲伤""愤怒""恐惧""兴奋"
3. 只输出JSON，不要输出任何其他内容`;

export class EmojiManager {
  private static instance: EmojiManager | null = null;

  private config: any;
  private emojiDir: string;
  private registeredDir: string;
  private emojiObjects: EmojiRecord[] = [];
  private emojiNum: number = 0;
  private maxEmojiNum: number = 100;

  private constructor(config?: any) {
    this.config = config || {};
    const qqEmoji = config?.channels?.qq || config?.emoji || {};
    const openclawRoot = path.resolve(process.cwd(), ".openclaw");
    this.emojiDir = qqEmoji.emojiDir || config?.emoji?.emojiDir || path.join(openclawRoot, "data", "emoji");
    this.registeredDir = qqEmoji.registeredDir || config?.emoji?.registeredDir || path.join(openclawRoot, "data", "emoji_registered");
    this.maxEmojiNum = qqEmoji.maxRegNum || config?.emoji?.maxRegNum || 100;
  }

  static getInstance(config?: any): EmojiManager {
    if (!EmojiManager.instance) {
      EmojiManager.instance = new EmojiManager(config);
    }
    return EmojiManager.instance;
  }

  async initialize(): Promise<void> {
    this.ensureDirectories();
    await this.loadAllEmojiFromDB();
    await this.processPendingEmojis();
    console.log(`[EmojiManager] 初始化完成，共 ${this.emojiNum} 个表情包`);
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.emojiDir)) {
      fs.mkdirSync(this.emojiDir, { recursive: true });
    }
    if (!fs.existsSync(this.registeredDir)) {
      fs.mkdirSync(this.registeredDir, { recursive: true });
    }
  }

  private async processPendingEmojis(): Promise<void> {
    if (!fs.existsSync(this.emojiDir)) {
      return;
    }

    const files = fs.readdirSync(this.emojiDir);
    let processedCount = 0;
    let skippedCount = 0;

    for (const filename of files) {
      const sourcePath = path.join(this.emojiDir, filename);
      if (!fs.statSync(sourcePath).isFile()) continue;

      const ext = path.extname(filename).toLowerCase();
      if (![".jpg", ".jpeg", ".png", ".gif"].includes(ext)) continue;

      const hash = this.calculateFileHash(sourcePath);
      const existing = this.emojiObjects.find(e => e.hash === hash);
      if (existing) {
        fs.unlinkSync(sourcePath);
        skippedCount++;
        continue;
      }

      const newFilename = `${hash}${ext}`;
      const destPath = path.join(this.registeredDir, newFilename);
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }

      fs.renameSync(sourcePath, destPath);

      const imageBuffer = fs.readFileSync(destPath);
      const base64 = imageBuffer.toString("base64");

      try {
        const description = await this.buildEmojiDescription(base64, ext.slice(1));

        const record: EmojiRecord = {
          hash,
          fullPath: destPath,
          filename: newFilename,
          description: description.description,
          emotion: description.emotions,
          usageCount: 0,
          lastUsedTime: Date.now(),
          registerTime: Date.now(),
          format: ext.slice(1),
          isDeleted: false,
        };

        this.emojiObjects.push(record);
        this.emojiNum++;

        await cacheDescription(hash, description.description, "emoji", description.emotions);
        processedCount++;
      } catch (e) {
        console.warn(`[EmojiManager] 处理临时表情包失败: ${filename}`, e);
        fs.unlinkSync(destPath);
      }
    }

    if (processedCount > 0 || skippedCount > 0) {
      console.log(`[EmojiManager] 处理临时表情包: 注册 ${processedCount} 个, 跳过重复 ${skippedCount} 个`);
    }
  }

  private async loadAllEmojiFromDB(): Promise<void> {
    this.emojiObjects = [];
    this.emojiNum = 0;

    if (!fs.existsSync(this.registeredDir)) {
      return;
    }

    const files = fs.readdirSync(this.registeredDir);
    for (const filename of files) {
      const fullPath = path.join(this.registeredDir, filename);
      if (!fs.statSync(fullPath).isFile()) continue;

      const ext = path.extname(filename).toLowerCase();
      if (![".jpg", ".jpeg", ".png", ".gif"].includes(ext)) continue;

      const hash = this.calculateFileHash(fullPath);
      const cached = await getCachedDescription(hash);

      let emotionTags = cached?.emotionTags || [];
      const desc = cached?.description || "";
      if (emotionTags.length === 0 && desc.length > 0) {
        const emotionMap: Record<string, string[]> = {
          "困惑": ["困惑", "迷茫", "懵", "不解", "茫然"],
          "震惊": ["震惊", "惊讶", "意外", "难以置信"],
          "开心": ["开心", "高兴", "快乐", "愉快", "哈哈"],
          "悲伤": ["悲伤", "难过", "伤心", "哭"],
          "愤怒": ["愤怒", "生气", "火大", "烦"],
          "尴尬": ["尴尬", "无语", "汗"],
          "疲惫": ["疲惫", "累", "困", "无力"],
          "撒娇": ["撒娇", "害羞", "傲娇", "亲昵"],
          "得意": ["得意", "狡黠", "自信"],
          "自嘲": ["自嘲", "无奈", "苦笑"],
          "治愈": ["治愈", "温馨", "温柔", "宠溺", "可爱"],
          "恐惧": ["恐惧", "害怕", "紧张"],
          "兴奋": ["兴奋", "激动", "期待"],
          "爱": ["爱", "喜欢", "心动"],
        };
        for (const [emotion, keywords] of Object.entries(emotionMap)) {
          if (keywords.some(kw => desc.includes(kw))) {
            emotionTags.push(emotion);
            if (emotionTags.length >= 3) break;
          }
        }
        if (emotionTags.length > 0) {
          await cacheDescription(hash, desc, "emoji", emotionTags);
        }
      }

      const record: EmojiRecord = {
        hash,
        fullPath,
        filename,
        description: desc || filename.replace(ext, ""),
        emotion: emotionTags,
        usageCount: 0,
        lastUsedTime: Date.now(),
        registerTime: fs.statSync(fullPath).mtimeMs,
        format: ext.slice(1),
        isDeleted: false,
      };

      this.emojiObjects.push(record);
      this.emojiNum++;
    }
  }

  private calculateFileHash(filePath: string): string {
    const content = fs.readFileSync(filePath);
    const crypto = require("crypto");
    return crypto.createHash("md5").update(content).digest("hex");
  }

  async getEmojiForText(textEmotion: string): Promise<{ path: string; description: string; emotion: string } | null> {
    if (this.emojiObjects.length === 0) {
      return null;
    }

    const validEmojis = this.emojiObjects.filter(e => !e.isDeleted);
    if (validEmojis.length === 0) {
      return null;
    }

    const inputWords = textEmotion.split(/[\s,，、]+/).filter(w => w.length > 0);

    const scored = validEmojis.map(emoji => {
      let maxSimilarity = 0;
      let bestEmotion = "";

      if (emoji.emotion.length === 0) {
        const descWords = emoji.description
          .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, "")
          .split(/[\s,，。！？、；：""''（）【】《》]+/)
          .filter(w => w.length > 0);
        for (const inputWord of inputWords) {
          for (const descWord of descWords) {
            if (descWord.includes(inputWord) || inputWord.includes(descWord)) {
              const sim = Math.min(inputWord.length, descWord.length) / Math.max(inputWord.length, descWord.length);
              if (sim > maxSimilarity) {
                maxSimilarity = sim;
                bestEmotion = descWord;
              }
            }
          }
        }
      } else {
        for (const emotion of emoji.emotion) {
          for (const inputWord of inputWords) {
            const similarity = this.calculateSimilarity(inputWord, emotion);
            if (similarity > maxSimilarity) {
              maxSimilarity = similarity;
              bestEmotion = emotion;
            }
          }
          if (maxSimilarity < 0.5) {
            const descWords = emoji.description
              .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, "")
              .split(/[\s,，。！？、；：""''（）【】《》]+/)
              .filter(w => w.length > 0);
            for (const inputWord of inputWords) {
              for (const descWord of descWords) {
                if (descWord.includes(inputWord) || inputWord.includes(descWord)) {
                  const sim = Math.min(inputWord.length, descWord.length) / Math.max(inputWord.length, descWord.length) * 0.8;
                  if (sim > maxSimilarity) {
                    maxSimilarity = sim;
                    bestEmotion = emotion;
                  }
                }
              }
            }
          }
        }
      }

      return { emoji, similarity: maxSimilarity, bestEmotion };
    });

    scored.sort((a, b) => b.similarity - a.similarity);

    const minSimilarity = 0.3;
    const qualified = scored.filter(s => s.similarity >= minSimilarity);
    if (qualified.length === 0) {
      return null;
    }

    const topEmojis = qualified.slice(0, Math.min(5, qualified.length));
    const weights = topEmojis.map((_, i) => Math.max(1, topEmojis.length - i));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let random = Math.random() * totalWeight;
    let selectedIdx = 0;
    for (let i = 0; i < weights.length; i++) {
      random -= weights[i];
      if (random <= 0) {
        selectedIdx = i;
        break;
      }
    }
    const selected = topEmojis[selectedIdx];

    if (selected) {
      selected.emoji.usageCount++;
      selected.emoji.lastUsedTime = Date.now();

      console.log(`[EmojiManager] 为[${textEmotion}]找到表情包: ${selected.emoji.filename} (相似度: ${selected.similarity.toFixed(2)}, 情绪: ${selected.bestEmotion})`);

      return {
        path: selected.emoji.fullPath,
        description: selected.emoji.description,
        emotion: selected.bestEmotion,
      };
    }

    return null;
  }

  private calculateSimilarity(s1: string, s2: string): number {
    const len1 = s1.length;
    const len2 = s2.length;
    const maxLen = Math.max(len1, len2);

    if (maxLen === 0) return 1;

    const distance = this.levenshteinDistance(s1, s2);
    return 1 - distance / maxLen;
  }

  private levenshteinDistance(s1: string, s2: string): number {
    if (s1.length < s2.length) {
      return this.levenshteinDistance(s2, s1);
    }

    if (s2.length === 0) {
      return s1.length;
    }

    const previousRow = Array.from({ length: s2.length + 1 }, (_, i) => i);

    for (let i = 0; i < s1.length; i++) {
      const currentRow = [i + 1];
      for (let j = 0; j < s2.length; j++) {
        const insertions = previousRow[j + 1] + 1;
        const deletions = currentRow[j] + 1;
        const substitutions = previousRow[j] + (s1[i] !== s2[j] ? 1 : 0);
        currentRow.push(Math.min(insertions, deletions, substitutions));
      }
      previousRow.splice(0, previousRow.length, ...currentRow);
    }

    return previousRow[previousRow.length - 1];
  }

  async registerEmoji(filename: string): Promise<boolean> {
    const sourcePath = path.join(this.emojiDir, filename);

    if (!fs.existsSync(sourcePath)) {
      console.error(`[EmojiManager] 文件不存在: ${sourcePath}`);
      return false;
    }

    const ext = path.extname(filename).toLowerCase();
    if (![".jpg", ".jpeg", ".png", ".gif"].includes(ext)) {
      console.error(`[EmojiManager] 不支持的文件格式: ${ext}`);
      return false;
    }

    const hash = this.calculateFileHash(sourcePath);
    const existing = this.emojiObjects.find(e => e.hash === hash);
    if (existing) {
      console.log(`[EmojiManager] 表情包已存在: ${filename}`);
      fs.unlinkSync(sourcePath);
      return false;
    }

    const newFilename = `${hash}${ext}`;
    const destPath = path.join(this.registeredDir, newFilename);
    if (fs.existsSync(destPath)) {
      fs.unlinkSync(destPath);
    }

    fs.renameSync(sourcePath, destPath);

    const imageBuffer = fs.readFileSync(destPath);
    const base64 = imageBuffer.toString("base64");

    const description = await this.buildEmojiDescription(base64, ext.slice(1));

    const record: EmojiRecord = {
      hash,
      fullPath: destPath,
      filename: newFilename,
      description: description.description,
      emotion: description.emotions,
      usageCount: 0,
      lastUsedTime: Date.now(),
      registerTime: Date.now(),
      format: ext.slice(1),
      isDeleted: false,
    };

    this.emojiObjects.push(record);
    this.emojiNum++;

    await cacheDescription(hash, description.description, "emoji", description.emotions);

    console.log(`[EmojiManager] 注册表情包: ${newFilename} (当前: ${this.emojiNum}/${this.maxEmojiNum})`);

    return true;
  }

  async registerEmojiFromBase64(base64: string, ext: string = "png"): Promise<boolean> {
    const hash = computeImageHash(base64);
    const existing = this.emojiObjects.find(e => e.hash === hash);
    if (existing) {
      return false;
    }

    const newFilename = `${hash}.${ext}`;
    const destPath = path.join(this.registeredDir, newFilename);

    const buffer = Buffer.from(base64, "base64");
    fs.writeFileSync(destPath, buffer);

    const description = await this.buildEmojiDescription(base64, ext);

    const record: EmojiRecord = {
      hash,
      fullPath: destPath,
      filename: newFilename,
      description: description.description,
      emotion: description.emotions,
      usageCount: 0,
      lastUsedTime: Date.now(),
      registerTime: Date.now(),
      format: ext,
      isDeleted: false,
    };

    this.emojiObjects.push(record);
    this.emojiNum++;

    await cacheDescription(hash, description.description, "emoji", description.emotions);

    console.log(`[EmojiManager] 从Base64注册表情包: ${newFilename}`);
    return true;
  }

  private async buildEmojiDescription(base64: string, ext: string): Promise<{
    description: string;
    emotions: string[];
  }> {
    try {
      const result = await processImage(base64, { config: { loadConfig: () => this.config } }, 1);
      
      let emotions: string[] = [];
      if (result.emotionTags && result.emotionTags.length > 0) {
        emotions = result.emotionTags;
      } else {
        const emotionPrompt = EMOJI_EMOTION_PROMPT.replace("{description}", result.description);
        const emotionResult = await this.callLLM(emotionPrompt, 0.7);

        if (emotionResult.success && emotionResult.content) {
          try {
            const jsonMatch = emotionResult.content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (Array.isArray(parsed.emotions)) {
                emotions = parsed.emotions
                  .filter((e: any) => typeof e === "string" && e.length > 0 && e.length <= 15)
                  .slice(0, 3);
              }
            }
          } catch {
            emotions = emotionResult.content
              .replace(/，/g, ",")
              .split(",")
              .map(e => e.trim())
              .filter(e => e.length > 0 && e.length <= 6)
              .slice(0, 3);
          }
        }
      }

      return {
        description: result.description,
        emotions,
      };
    } catch (e) {
      console.warn("[EmojiManager] 构建表情包描述失败:", e);
      return {
        description: "[表情包]",
        emotions: [],
      };
    }
  }

  private shuffleArray<T>(array: T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  async deleteEmoji(hash: string): Promise<boolean> {
    const index = this.emojiObjects.findIndex(e => e.hash === hash);

    if (index === -1) {
      return false;
    }

    const emoji = this.emojiObjects[index];

    if (fs.existsSync(emoji.fullPath)) {
      fs.unlinkSync(emoji.fullPath);
    }

    this.emojiObjects.splice(index, 1);
    this.emojiNum--;

    console.log(`[EmojiManager] 删除表情包: ${emoji.filename}`);
    return true;
  }

  private async callLLM(prompt: string, temperature: number = 0.7): Promise<{
    success: boolean;
    content?: string;
    error?: string;
  }> {
    try {
      const providers = getProviders(this.config);
      const taskConfig = getModelTaskConfig(this.config, "toolUse");

      if (!taskConfig || !taskConfig.models?.length) {
        return { success: false, error: "未配置toolUse模型任务" };
      }

      const options: ModelCallOptions = {
        messages: [{ role: "user", content: prompt }],
        maxTokens: 256,
        temperature,
        timeout: 30000,
      };

      const result = await callWithModelRotation(providers, taskConfig, options);

      return {
        success: result.success,
        content: result.content,
        error: result.error,
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  getStats(): { total: number; max: number } {
    return {
      total: this.emojiNum,
      max: this.maxEmojiNum,
    };
  }

  async getCount(): Promise<number> {
    return this.emojiNum;
  }

  async getRandom(count: number = 3): Promise<Array<{ path: string; description: string; emotion: string }>> {
    const validEmojis = this.emojiObjects.filter(e => !e.isDeleted);
    if (validEmojis.length === 0) {
      return [];
    }

    const shuffled = this.shuffleArray(validEmojis);
    const selected = shuffled.slice(0, Math.min(count, shuffled.length));

    return selected.map(emoji => ({
      path: emoji.fullPath,
      description: emoji.description,
      emotion: emoji.emotion.join(", "),
    }));
  }
}

export function getEmojiManager(config?: any): EmojiManager {
  return EmojiManager.getInstance(config);
}
