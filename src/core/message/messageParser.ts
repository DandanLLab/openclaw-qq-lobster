import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  callWithModelRotation,
  getModelTaskConfig,
  getProviders,
  type ModelCallOptions,
} from "../modelCaller.js";

export interface MessageSegment {
  type: string;
  data: Record<string, unknown>;
}

export interface ParsedMessage {
  text: string;
  images: Array<{ url: string; base64?: string; description?: string }>;
  atUsers: Array<{ userId: string; nickname: string }>;
  reply?: { messageId: string; content: string; senderId: string };
  forward?: { id: string; content: string };
  voice?: { url: string; base64?: string; text?: string; duration?: number };
  video?: { url: string; base64?: string; cover?: string; duration?: number };
  json?: { type: string; data: any; summary: string };
  emoji?: { id: string; url?: string };
  face?: { id: string; name?: string };
  dice?: { value: number };
  rps?: { result: string };
  poke?: { type: string; id: string };
  music?: { type: string; id: string; url?: string; title?: string; author?: string };
  contact?: { type: string; id: string };
  location?: { lat: number; lon: number; title?: string; content?: string };
  file?: { name: string; url: string; size?: number };
}

export interface ParsedImageResult {
  hash: string;
  base64: string;
  format: string;
  description?: string;
  isEmoji: boolean;
}

const IMAGE_CACHE_DIR = path.join(process.cwd(), ".openclaw", "cache", "images");
const VOICE_CACHE_DIR = path.join(process.cwd(), ".openclaw", "cache", "voices");

const VLM_DESCRIPTION_PROMPT = `这是一个图片，请详细描述图片的内容。如果是表情包，请描述表情包表达的情感和含义。`;

const VOICE_TRANSCRIBE_PROMPT = `请将以下语音内容转换为文字。如果无法识别，请回复"[无法识别的语音]"。`;

const JSON_CARD_PROMPTS: Record<string, string> = {
  music: `这是一个音乐分享卡片，请提取歌曲名称、歌手、专辑等信息。`,
  news: `这是一个新闻卡片，请提取标题、摘要、来源等信息。`,
  default: `这是一个JSON卡片消息，请简要描述其内容。`,
};

export class MessageParser {
  private config: any;
  private imageCache: Map<string, ParsedImageResult> = new Map();
  private voiceCache: Map<string, string> = new Map();
  private cacheDir: string;

  constructor(config?: any) {
    this.config = config || {};
    this.cacheDir = config?.cacheDir || path.join(process.cwd(), ".openclaw", "cache");
    this.ensureCacheDirs();
  }

  private ensureCacheDirs(): void {
    [IMAGE_CACHE_DIR, VOICE_CACHE_DIR].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  async parseMessageSegments(segments: MessageSegment[]): Promise<ParsedMessage> {
    const result: ParsedMessage = {
      text: "",
      images: [],
      atUsers: [],
    };

    for (const segment of segments) {
      await this.parseSegment(segment, result);
    }

    return result;
  }

  private async parseSegment(segment: MessageSegment, result: ParsedMessage): Promise<void> {
    switch (segment.type) {
      case "text":
        result.text += segment.data.text as string || "";
        break;

      case "image":
        await this.parseImage(segment, result);
        break;

      case "at":
        result.atUsers.push({
          userId: String(segment.data.qq || segment.data.user_id || ""),
          nickname: String(segment.data.name || segment.data.nickname || ""),
        });
        result.text += `@${segment.data.name || segment.data.nickname || "用户"} `;
        break;

      case "reply":
        await this.parseReply(segment, result);
        break;

      case "forward":
        await this.parseForward(segment, result);
        break;

      case "record":
      case "voice":
        await this.parseVoice(segment, result);
        break;

      case "video":
        await this.parseVideo(segment, result);
        break;

      case "json":
        await this.parseJson(segment, result);
        break;

      case "face":
        this.parseFace(segment, result);
        break;

      case "emoji":
      case "mface":
        this.parseEmoji(segment, result);
        break;

      case "dice":
        this.parseDice(segment, result);
        break;

      case "rps":
        this.parseRps(segment, result);
        break;

      case "poke":
        this.parsePoke(segment, result);
        break;

      case "music":
        this.parseMusic(segment, result);
        break;

      case "contact":
        this.parseContact(segment, result);
        break;

      case "location":
        this.parseLocation(segment, result);
        break;

      case "file":
        this.parseFile(segment, result);
        break;

      default:
        console.log(`[MessageParser] 未处理的消息段类型: ${segment.type}`);
    }
  }

  private async parseImage(segment: MessageSegment, result: ParsedMessage): Promise<void> {
    const url = segment.data.url as string;
    const base64 = segment.data.file as string;
    const subType = segment.data.sub_type as number;

    const isEmoji = subType === 1 || subType === 2;

    let imageBase64 = "";
    if (base64 && base64.startsWith("base64://")) {
      imageBase64 = base64.replace("base64://", "");
    } else if (url) {
      imageBase64 = await this.downloadImage(url);
    }

    if (imageBase64) {
      const hash = this.calculateHash(imageBase64);
      const format = this.detectImageFormat(imageBase64);

      let description = "";
      if (this.config?.image?.enableVLM !== false) {
        description = await this.getImageDescription(imageBase64, format);
      }

      result.images.push({
        url: url || "",
        base64: imageBase64,
        description,
      });

      if (isEmoji) {
        result.emoji = { id: hash, url };
        result.text += `[表情包：${description || "图片"}]`;
      } else {
        result.text += `[图片：${description || "图片"}]`;
      }
    }
  }

  private async parseReply(segment: MessageSegment, result: ParsedMessage): Promise<void> {
    const messageId = String(segment.data.id || segment.data.message_id || "");
    const content = segment.data.content as string || "";

    result.reply = {
      messageId,
      content,
      senderId: String(segment.data.user_id || segment.data.sender_id || ""),
    };

    result.text += `[回复消息] `;
  }

  private async parseForward(segment: MessageSegment, result: ParsedMessage): Promise<void> {
    const id = String(segment.data.id || "");

    result.forward = {
      id,
      content: "[转发消息]",
    };

    result.text += `[转发消息] `;
  }

  private async parseVoice(segment: MessageSegment, result: ParsedMessage): Promise<void> {
    const url = segment.data.url as string;
    const file = segment.data.file as string;
    const duration = segment.data.length as number;

    let base64 = "";
    if (file && file.startsWith("base64://")) {
      base64 = file.replace("base64://", "");
    } else if (url) {
      base64 = await this.downloadFile(url);
    }

    const voiceText = base64 ? await this.transcribeVoice(base64) : "";

    result.voice = {
      url: url || "",
      base64,
      text: voiceText,
      duration,
    };

    result.text += `[语音：${voiceText || "语音消息"}] `;
  }

  private async parseVideo(segment: MessageSegment, result: ParsedMessage): Promise<void> {
    const url = segment.data.url as string;
    const cover = segment.data.cover as string;
    const duration = segment.data.length as number;

    result.video = {
      url: url || "",
      cover,
      duration,
    };

    result.text += `[视频：${duration ? Math.floor(duration / 1000) + "秒" : "视频消息"}] `;
  }

  private async parseJson(segment: MessageSegment, result: ParsedMessage): Promise<void> {
    const data = segment.data.data as string;

    try {
      const jsonData = JSON.parse(data);
      const summary = await this.summarizeJsonCard(jsonData);

      result.json = {
        type: this.detectJsonType(jsonData),
        data: jsonData,
        summary,
      };

      result.text += `[卡片：${summary}] `;
    } catch {
      result.text += `[JSON消息] `;
    }
  }

  private parseFace(segment: MessageSegment, result: ParsedMessage): void {
    const id = String(segment.data.id || "");
    const name = segment.data.name || segment.data.text || "";

    result.face = { id, name: String(name) };
    result.text += `[表情：${name || id}] `;
  }

  private parseEmoji(segment: MessageSegment, result: ParsedMessage): void {
    const id = String(segment.data.id || "");
    const url = segment.data.url as string;

    result.emoji = { id, url };
    result.text += `[表情包] `;
  }

  private parseDice(segment: MessageSegment, result: ParsedMessage): void {
    const value = (segment.data.result as number) || Math.floor(Math.random() * 6) + 1;

    result.dice = { value };
    result.text += `[骰子：${value}点] `;
  }

  private parseRps(segment: MessageSegment, result: ParsedMessage): Promise<void> {
    const results = ["石头", "剪刀", "布"];
    const value = (segment.data.result as number) || Math.floor(Math.random() * 3);
    const resultText = results[value] || "未知";

    result.rps = { result: resultText };
    result.text += `[猜拳：${resultText}] `;

    return Promise.resolve();
  }

  private parsePoke(segment: MessageSegment, result: ParsedMessage): void {
    const type = String(segment.data.type || "");
    const id = String(segment.data.id || "");

    result.poke = { type, id };
    result.text += `[戳一戳] `;
  }

  private parseMusic(segment: MessageSegment, result: ParsedMessage): void {
    const type = String(segment.data.type || "");
    const id = String(segment.data.id || "");
    const url = segment.data.url as string;
    const title = segment.data.title as string;
    const author = segment.data.author as string;

    result.music = { type, id, url, title, author };
    result.text += `[音乐：${title || "分享"}${author ? ` - ${author}` : ""}] `;
  }

  private parseContact(segment: MessageSegment, result: ParsedMessage): void {
    const type = String(segment.data.type || "");
    const id = String(segment.data.id || "");

    result.contact = { type, id };
    result.text += `[推荐${type === "qq" ? "好友" : "群"}：${id}] `;
  }

  private parseLocation(segment: MessageSegment, result: ParsedMessage): void {
    const lat = segment.data.lat as number;
    const lon = segment.data.lon as number;
    const title = segment.data.title as string;
    const content = segment.data.content as string;

    result.location = { lat, lon, title, content };
    result.text += `[位置：${title || content || `${lat},${lon}`}] `;
  }

  private parseFile(segment: MessageSegment, result: ParsedMessage): void {
    const name = segment.data.name as string;
    const url = segment.data.url as string;
    const size = segment.data.size as number;

    result.file = { name: name || "文件", url: url || "", size };
    result.text += `[文件：${name || "文件"}${size ? ` (${this.formatFileSize(size)})` : ""}] `;
  }

  private async downloadImage(url: string): Promise<string> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      return Buffer.from(buffer).toString("base64");
    } catch (error) {
      console.error(`[MessageParser] 下载图片失败: ${error}`);
      return "";
    }
  }

  private async downloadFile(url: string): Promise<string> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      return Buffer.from(buffer).toString("base64");
    } catch (error) {
      console.error(`[MessageParser] 下载文件失败: ${error}`);
      return "";
    }
  }

  private calculateHash(base64: string): string {
    return crypto.createHash("md5").update(base64).digest("hex");
  }

  private detectImageFormat(base64: string): string {
    const buffer = Buffer.from(base64, "base64");

    if (buffer[0] === 0xff && buffer[1] === 0xd8) return "jpeg";
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return "png";
    if (buffer[0] === 0x47 && buffer[1] === 0x49) return "gif";
    if (buffer[0] === 0x52 && buffer[1] === 0x49) return "webp";
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) return "bmp";

    return "jpeg";
  }

  private async getImageDescription(base64: string, format: string): Promise<string> {
    const hash = this.calculateHash(base64);

    if (this.imageCache.has(hash)) {
      return this.imageCache.get(hash)?.description || "";
    }

    try {
      const providers = getProviders(this.config);
      const taskConfig = getModelTaskConfig(this.config, "vlm");

      if (!taskConfig || !taskConfig.models?.length) {
        return "";
      }

      const modelConfig = taskConfig.models[0];
      const provider = providers[modelConfig.provider];

      if (!provider?.apiKey) {
        return "";
      }

      const baseUrl = provider.baseUrl || provider.baseURL;

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model: modelConfig.model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: VLM_DESCRIPTION_PROMPT },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:image/${format};base64,${base64}`,
                  },
                },
              ],
            },
          ],
          max_tokens: 256,
          temperature: 0.5,
        }),
      });

      if (!response.ok) {
        return "";
      }

      const data = await response.json() as any;
      const description = data?.choices?.[0]?.message?.content || "";

      this.imageCache.set(hash, {
        hash,
        base64,
        format,
        description,
        isEmoji: false,
      });

      return description;
    } catch (error) {
      console.error(`[MessageParser] VLM识别失败: ${error}`);
      return "";
    }
  }

  private async transcribeVoice(base64: string): Promise<string> {
    const hash = this.calculateHash(base64);

    if (this.voiceCache.has(hash)) {
      return this.voiceCache.get(hash) || "";
    }

    try {
      const providers = getProviders(this.config);
      const taskConfig = getModelTaskConfig(this.config, "toolUse");

      if (!taskConfig || !taskConfig.models?.length) {
        return "";
      }

      const options: ModelCallOptions = {
        messages: [
          {
            role: "user",
            content: `${VOICE_TRANSCRIBE_PROMPT}\n\n语音数据(Base64): ${base64.substring(0, 100)}...`,
          },
        ],
        maxTokens: 256,
        temperature: 0.1,
        timeout: 30000,
      };

      const result = await callWithModelRotation(providers, taskConfig, options);

      if (result.success && result.content) {
        this.voiceCache.set(hash, result.content);
        return result.content;
      }

      return "";
    } catch (error) {
      console.error(`[MessageParser] 语音转文字失败: ${error}`);
      return "";
    }
  }

  private detectJsonType(jsonData: any): string {
    if (jsonData.app === "com.tencent.structmsg" || jsonData.app === "com.tencent.miniapp") {
      const extra = JSON.parse(jsonData.extra || "{}");
      if (extra?.app_type === 4 || jsonData.meta?.news) return "news";
      if (jsonData.meta?.music) return "music";
      return "miniprogram";
    }

    if (jsonData.app === "com.tencent.music") return "music";
    if (jsonData.app === "com.tencent.share") return "share";
    if (jsonData.prompt) return "card";

    return "unknown";
  }

  private async summarizeJsonCard(jsonData: any): Promise<string> {
    const type = this.detectJsonType(jsonData);

    if (jsonData.prompt) {
      return jsonData.prompt;
    }

    if (jsonData.meta?.music?.title) {
      return `音乐：${jsonData.meta.music.title}`;
    }

    if (jsonData.meta?.news?.title) {
      return `新闻：${jsonData.meta.news.title}`;
    }

    if (jsonData.meta?.detail_1?.desc) {
      return jsonData.meta.detail_1.desc;
    }

    return type === "unknown" ? "卡片消息" : `${type}卡片`;
  }

  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  }

  clearCache(): void {
    this.imageCache.clear();
    this.voiceCache.clear();
  }
}

export function createMessageParser(config?: any): MessageParser {
  return new MessageParser(config);
}
