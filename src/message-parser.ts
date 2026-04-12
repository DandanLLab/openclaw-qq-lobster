import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { OneBotMessage } from "./types.js";
import { convertSilkToWav } from "./utils/audio-convert.js";

export function escapeCQParam(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/,/g, "&#44;");
}

const CQ_FACE_REGEX = /\[CQ:face,id=(\d+)\]/g;
const CQ_ANY_REGEX = /\[CQ:[^\]]+\]/g;
const CQ_REPLY_REGEX = /\[CQ:reply,id=(\d+)\]/;
const IMAGE_URL_PATTERN = /\[CQ:image,[^\]]*(?:url|file)=([^,\]]+)[^\]]*\]/g;

const MAX_LOCAL_FILE_SIZE = 10 * 1024 * 1024;

export function extractImageUrls(message: OneBotMessage | string | undefined, maxImages = 3): string[] {
  const urls: string[] = [];

  if (Array.isArray(message)) {
    for (const segment of message) {
      if (segment.type === "image") {
        const url =
          segment.data?.url ||
          (typeof segment.data?.file === "string" &&
          (segment.data.file.startsWith("http") || segment.data.file.startsWith("base64://"))
            ? segment.data.file
            : undefined);
        if (url) {
          urls.push(url);
          if (urls.length >= maxImages) break;
        }
      }
    }
  } else if (typeof message === "string") {
    const re = new RegExp(IMAGE_URL_PATTERN.source, "g");
    let match;
    while ((match = re.exec(message)) !== null) {
      const val = match[1].replace(/&amp;/g, "&");
      if (val.startsWith("http") || val.startsWith("base64://")) {
        urls.push(val);
        if (urls.length >= maxImages) break;
      }
    }
  }

  return urls;
}

export function cleanCQCodes(text: string | undefined): string {
  if (!text) return "";

  let result = text;
  const imageUrls: string[] = [];

  const re = new RegExp(IMAGE_URL_PATTERN.source, "g");
  let match;
  while ((match = re.exec(text)) !== null) {
    const val = match[1].replace(/&amp;/g, "&");
    if (val.startsWith("http")) imageUrls.push(val);
  }

  result = result.replace(CQ_FACE_REGEX, "[表情]");
  CQ_ANY_REGEX.lastIndex = 0;
  result = result.replace(CQ_ANY_REGEX, (m) => {
    if (m.startsWith("[CQ:image")) return "[图片]";
    return "";
  });
  result = result.replace(/\s+/g, " ").trim();

  if (imageUrls.length > 0) {
    result = result
      ? `${result} [图片: ${imageUrls.join(", ")}]`
      : `[图片: ${imageUrls.join(", ")}]`;
  }

  return result;
}

export function getReplyMessageId(
  message: OneBotMessage | string | undefined,
  rawMessage?: string,
): string | null {
  if (message && typeof message !== "string") {
    for (const segment of message) {
      if (segment.type === "reply" && segment.data?.id) {
        const id = String(segment.data.id).trim();
        if (id && /^-?\d+$/.test(id)) return id;
      }
    }
  }
  if (rawMessage) {
    const m = rawMessage.match(CQ_REPLY_REGEX);
    if (m) return m[1];
  }
  return null;
}

export function normalizeTarget(raw: string): string {
  return raw.replace(/^(qq:)/i, "");
}

export type TargetType = "private" | "group" | "guild";

export interface ParsedTarget {
  type: TargetType;
  userId?: number;
  groupId?: number;
  guildId?: string;
  channelId?: string;
}

export function parseTarget(to: string): ParsedTarget {
  if (to.startsWith("group:")) {
    const id = parseInt(to.slice(6), 10);
    if (isNaN(id)) throw new Error(`Invalid group target: "${to}" — expected "group:<number>"`);
    return { type: "group", groupId: id };
  }
  if (to.startsWith("guild:")) {
    const parts = to.split(":");
    if (parts.length < 3 || !parts[1] || !parts[2]) {
      throw new Error(
        `Invalid guild target: "${to}" — expected "guild:<guildId>:<channelId>"`,
      );
    }
    return { type: "guild", guildId: parts[1], channelId: parts[2] };
  }
  if (to.startsWith("private:")) {
    const id = parseInt(to.slice(8), 10);
    if (isNaN(id)) throw new Error(`Invalid private target: "${to}" — expected "private:<number>"`);
    return { type: "private", userId: id };
  }
  const id = parseInt(to, 10);
  if (isNaN(id)) {
    throw new Error(
      `Cannot determine target type from "${to}". Use "private:<QQ号>", "group:<群号>", or "guild:<频道ID>:<子频道ID>".`,
    );
  }
  return { type: "private", userId: id };
}

export async function dispatchMessage(
  client: any,
  target: ParsedTarget,
  message: OneBotMessage | string,
): Promise<void> {
  switch (target.type) {
    case "group":
      await client.sendGroupMsg(target.groupId!, message);
      break;
    case "guild":
      await client.sendGuildChannelMsg(target.guildId!, target.channelId!, message);
      break;
    case "private":
      await client.sendPrivateMsg(target.userId!, message);
      break;
  }
}

export function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = text;
  while (current.length > 0) {
    chunks.push(current.slice(0, limit));
    current = current.slice(limit);
  }
  return chunks;
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/```(\w*)\n?([\s\S]*?)```/g, "$2")
    .replace(/`(.*?)`/g, "$1")
    .replace(/#+\s+(.*)/g, "$1")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/^\s*>\s+(.*)/gm, "▎$1")
    .replace(/^\|.*\|$/gm, (m) => m.replace(/\|/g, " ").trim())
    .replace(/^[\-\*]\s+/gm, "• ");
}

export function processAntiRisk(text: string): string {
  return text.replace(/(https?:\/\/)/gi, "$1 ");
}

export async function resolveMediaUrl(url: string): Promise<string> {
  if (url.startsWith("file:")) {
    try {
      const filePath = fileURLToPath(url);
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_LOCAL_FILE_SIZE) {
        console.warn(`[QQ] File too large to base64 encode (${stat.size} bytes), passing as-is: ${url}`);
        return url;
      }
      const data = await fs.readFile(filePath);
      return `base64://${data.toString("base64")}`;
    } catch (e) {
      console.warn(`[QQ] Failed to convert local file to base64: ${e}`);
      return url;
    }
  }
  if (url.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(url)) {
    try {
      const stat = await fs.stat(url);
      if (stat.size > MAX_LOCAL_FILE_SIZE) {
        console.warn(`[QQ] File too large to base64 encode (${stat.size} bytes), passing as-is: ${url}`);
        return url;
      }
      const data = await fs.readFile(url);
      return `base64://${data.toString("base64")}`;
    } catch (e) {
      console.warn(`[QQ] Failed to read local file, passing as-is: ${e}`);
      return url;
    }
  }
  return url;
}

export function isImageFile(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".png") ||
    lower.endsWith(".gif") ||
    lower.endsWith(".webp") ||
    lower.endsWith(".bmp") ||
    lower.endsWith(".svg")
  );
}

export function isVideoFile(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.endsWith(".mp4") ||
    lower.endsWith(".avi") ||
    lower.endsWith(".mov") ||
    lower.endsWith(".mkv") ||
    lower.endsWith(".webm")
  );
}

const TEXT_URL_REGEX = /https?:\/\/[^\s\])<>"]+/gi;
const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?[^\s]*)?$/i;
const VIDEO_EXTENSIONS = /\.(mp4|avi|mov|mkv|webm)(\?[^\s]*)?$/i;
const FILE_EXTENSIONS = /\.([a-zA-Z0-9]{1,10})(\?[^\s]*)?$/i;

export interface ExtractedMedia {
  url: string;
  type: "image" | "video" | "file";
  name: string;
}

export function extractMediaUrlsFromText(text: string): ExtractedMedia[] {
  const results: ExtractedMedia[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(TEXT_URL_REGEX.source, "gi");
  while ((match = re.exec(text)) !== null) {
    let url = match[0];
    url = url.replace(/[.,;!?:)\]}>]+$/, "");
    if (seen.has(url)) continue;

    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      pathname = url.split("?")[0];
    }

    let type: "image" | "video" | "file" | null = null;
    if (IMAGE_EXTENSIONS.test(pathname)) {
      type = "image";
    } else if (VIDEO_EXTENSIONS.test(pathname)) {
      type = "video";
    } else if (FILE_EXTENSIONS.test(pathname) && !/\.(html?|php|asp|aspx|jsp)$/i.test(pathname)) {
      type = "file";
    }

    if (type) {
      seen.add(url);
      const name = decodeURIComponent(pathname.split("/").pop() || "file");
      results.push({ url, type, name });
    }
  }
  return results;
}

interface STTConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function resolveSTTConfig(cfg: Record<string, unknown>): STTConfig | null {
  const c = cfg as any;

  const channelStt = c?.channels?.qq?.stt;
  if (channelStt && channelStt.enabled !== false) {
    const providerId: string = channelStt?.provider || "openai";
    const providerCfg = c?.models?.providers?.[providerId];
    const baseUrl: string | undefined = channelStt?.baseUrl || providerCfg?.baseUrl;
    const apiKey: string | undefined = channelStt?.apiKey || providerCfg?.apiKey;
    const model: string = channelStt?.model || "whisper-1";
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
    }
  }

  const audioModelEntry = c?.tools?.media?.audio?.models?.[0];
  if (audioModelEntry) {
    const providerId: string = audioModelEntry?.provider || "openai";
    const providerCfg = c?.models?.providers?.[providerId];
    const baseUrl: string | undefined = audioModelEntry?.baseUrl || providerCfg?.baseUrl;
    const apiKey: string | undefined = audioModelEntry?.apiKey || providerCfg?.apiKey;
    const model: string = audioModelEntry?.model || "whisper-1";
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
    }
  }

  return null;
}

export async function transcribeAudioForNapcat(
  audioPath: string,
  cfg: Record<string, unknown>,
): Promise<string | null> {
  const sttCfg = resolveSTTConfig(cfg);
  if (!sttCfg) return null;

  const fileBuffer = fsSync.readFileSync(audioPath);
  const fileName = path.basename(audioPath);
  const mime = fileName.endsWith(".wav")
    ? "audio/wav"
    : fileName.endsWith(".mp3")
      ? "audio/mpeg"
      : fileName.endsWith(".ogg")
        ? "audio/ogg"
        : "application/octet-stream";

  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: mime }), fileName);
  form.append("model", sttCfg.model);

  const resp = await fetch(`${sttCfg.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sttCfg.apiKey}` },
    body: form,
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`STT failed (HTTP ${resp.status}): ${detail.slice(0, 300)}`);
  }

  const result = (await resp.json()) as { text?: string };
  return result.text?.trim() || null;
}

export { os, path, fsSync, convertSilkToWav };
