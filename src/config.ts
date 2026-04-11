import { z } from "zod";

const GroupChannelConfigSchema = z.object({
  groupId: z.number().describe("群号"),
  name: z.string().optional().describe("群名称"),
  isPrimary: z.boolean().optional().default(false).describe("是否为主群（核心群聊）"),
  priority: z.number().optional().default(0).describe("优先级（数值越高越重要）"),
  systemPrompt: z.string().optional().describe("该群专属的系统提示词"),
  talkValue: z.number().optional().describe("该群的自动回复概率"),
  requireMention: z.boolean().optional().describe("该群是否需要@才回复"),
  historyLimit: z.number().optional().describe("该群的历史消息数量"),
  enableModeration: z.boolean().optional().describe("该群是否启用审核"),
  keywordTriggers: z.array(z.string()).optional().describe("该群的关键词触发列表"),
  disabled: z.boolean().optional().default(false).describe("是否禁用该群"),
  tags: z.array(z.string()).optional().describe("群标签（如：核心、测试、闲聊等）"),
});

export type GroupChannelConfig = z.infer<typeof GroupChannelConfigSchema>;

const DeliverDebounceConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  windowMs: z.number().int().min(100).max(30000).optional().default(1500),
  maxWaitMs: z.number().int().min(1000).max(120000).optional().default(8000),
  separator: z.string().optional().default("\n\n---\n\n"),
}).optional();

const ConnectionConfigSchema = z.object({
  mode: z.enum(["forward", "reverse"]).default("reverse").describe("连接模式：forward=正向连接（OpenClaw连接NapCat），reverse=反向连接（NapCat连接OpenClaw）"),
  url: z.string().describe("WebSocket URL，如 ws://127.0.0.1:8082"),
}).optional();

export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>;

export const QQConfigSchema = z.object({
  connection: ConnectionConfigSchema.describe("连接配置（推荐使用）"),
  wsUrl: z.string().url().optional().describe("【旧版】正向 WebSocket URL，如 ws://localhost:3001"),
  httpUrl: z.string().url().optional().describe("HTTP API URL，如 http://localhost:3000"),
  reverseWsPort: z.number().int().min(1).max(65535).optional().describe("【旧版】反向 WebSocket 端口"),
  accessToken: z.string().optional().describe("访问令牌"),
  admins: z.array(z.number().int().positive()).optional().describe("管理员 QQ 号列表"),
  requireMention: z.boolean().optional().default(true).describe("群聊是否需要@才回复"),
  systemPrompt: z.string().optional().describe("自定义系统提示词"),
  enableDeduplication: z.boolean().optional().default(true).describe("启用消息去重"),
  enableErrorNotify: z.boolean().optional().default(true).describe("错误时通知管理员"),
  autoApproveRequests: z.boolean().optional().default(false).describe("自动批准好友/加群请求"),
  maxMessageLength: z.number().int().min(100).max(10000).optional().default(4000).describe("单条消息最大长度"),
  formatMarkdown: z.boolean().optional().default(false).describe("格式化 Markdown"),
  antiRiskMode: z.boolean().optional().default(false).describe("启用防风控处理"),
  allowedGroups: z.array(z.number().int().positive()).optional().describe("允许的群号白名单"),
  blockedUsers: z.array(z.number().int().positive()).optional().describe("屏蔽的用户黑名单"),
  historyLimit: z.number().int().min(0).max(100).optional().default(5).describe("上下文历史消息数量"),
  keywordTriggers: z.array(z.string()).optional().describe("关键词触发列表"),
  enableTTS: z.boolean().optional().default(false).describe("启用 TTS 语音回复"),
  enableGuilds: z.boolean().optional().default(true).describe("启用 QQ 频道支持"),
  rateLimitMs: z.number().int().min(0).max(60000).optional().default(1000).describe("消息发送间隔（毫秒）"),
  reactionEmoji: z.string().optional().describe("自动回应表情 ID"),
  enableReactions: z.boolean().optional().default(true).describe("启用智能表情回应"),
  autoMarkRead: z.boolean().optional().default(false).describe("自动标记已读"),
  aiVoiceId: z.string().optional().describe("NapCat AI 语音角色 ID"),
  enableSTT: z.boolean().optional().default(false).describe("启用语音转文字"),
  markdownMode: z.enum(["strip", "native", "passthrough"]).optional().default("passthrough").describe("Markdown 处理模式"),
  deliverDebounce: DeliverDebounceConfigSchema.describe("出站消息合并配置"),
  enableUpdateCheck: z.boolean().optional().default(true).describe("启动时检查更新"),
  logBufferSize: z.number().int().min(10).max(10000).optional().default(200).describe("日志缓冲区大小"),
  inboundRateLimitMs: z.number().int().min(0).max(60000).optional().default(0).describe("入站频控（毫秒）"),
  silentKeywords: z.array(z.string().min(1)).optional().describe("静默关键词列表"),
  enableImageRecognition: z.boolean().optional().default(true).describe("启用图片识别"),
  imageRecognitionPrompt: z.string().optional().default("请简洁描述这张图片的内容，如果是表情包请描述表达的情感。").describe("图片识别提示词"),
  talkValue: z.number().optional().default(0.2).describe("群聊自动回复概率"),
  enableModeration: z.boolean().optional().default(true).describe("启用内容审核"),
  autoMuteMaxDuration: z.number().optional().default(60).describe("自动禁言最大时长（秒）"),
  requireAdminApprovalForKick: z.boolean().optional().default(true).describe("踢人需要管理员批准"),
  requireAdminApprovalForLongMute: z.boolean().optional().default(true).describe("长时间禁言需要管理员批准"),
  moderationExemptUsers: z.array(z.number()).optional().describe("审核豁免用户"),
  moderationExemptGroups: z.array(z.number()).optional().describe("审核豁免群"),
  moderationGroups: z.array(z.number()).optional().describe("审核启用群"),
  useCustomModelCaller: z.boolean().optional().default(false).describe("使用自定义模型调用器"),
  primaryGroup: z.number().optional().describe("主群号"),
  groupChannels: z.record(z.string(), GroupChannelConfigSchema).optional().describe("各群聊独立配置"),
  enableUrlSummary: z.boolean().optional().default(true).describe("启用 URL 摘要"),
  enableSmartSegmentationLLM: z.boolean().optional().default(false).describe("使用 LLM 智能分段"),
  autoSendEmoji: z.boolean().optional().default(false).describe("自动发送表情"),
  autoSendEmojiProbability: z.number().optional().default(0.3).describe("自动发送表情概率"),
  autoSendEmojiMinIntensity: z.number().optional().default(0.5).describe("自动发送表情最小情感强度"),
});

export type QQConfig = z.infer<typeof QQConfigSchema>;

export function resolveConnectionConfig(config: QQConfig): {
  mode: "forward" | "reverse";
  wsUrl?: string;
  reverseWsPort?: number;
} {
  if (config.connection) {
    const url = config.connection.url;
    if (config.connection.mode === "reverse") {
      const port = extractPort(url);
      return { mode: "reverse", reverseWsPort: port };
    } else {
      return { mode: "forward", wsUrl: url };
    }
  }
  
  if (config.reverseWsPort) {
    return { mode: "reverse", reverseWsPort: config.reverseWsPort };
  }
  if (config.wsUrl) {
    return { mode: "forward", wsUrl: config.wsUrl };
  }
  
  throw new Error("QQ: 需要配置 connection 或 wsUrl/reverseWsPort");
}

function extractPort(url: string): number {
  const match = url.match(/:(\d+)(?:\/|$)/);
  if (match) {
    return parseInt(match[1], 10);
  }
  throw new Error(`无法从 URL 提取端口: ${url}`);
}

export function getGroupConfig(config: QQConfig, groupId: number): GroupChannelConfig & { inherited: QQConfig } {
  const key = String(groupId);
  const groupConfig = config.groupChannels?.[key];
  const defaults: GroupChannelConfig = {
    groupId,
    isPrimary: config.primaryGroup === groupId,
    priority: config.primaryGroup === groupId ? 100 : 0,
    disabled: false,
  };
  return {
    ...defaults,
    ...(groupConfig || {}),
    groupId,
    isPrimary: config.primaryGroup === groupId || groupConfig?.isPrimary === true,
    priority: groupConfig?.priority ?? (config.primaryGroup === groupId ? 100 : 0),
    inherited: config,
  };
}

export function isPrimaryGroup(config: QQConfig, groupId: number): boolean {
  const key = String(groupId);
  return config.primaryGroup === groupId || config.groupChannels?.[key]?.isPrimary === true;
}

export function shouldRespondToGroup(config: QQConfig, groupId: number): boolean {
  const key = String(groupId);
  const groupConfig = config.groupChannels?.[key];
  if (groupConfig?.disabled === true) return false;
  if (config.allowedGroups && config.allowedGroups.length > 0) {
    return config.allowedGroups.includes(groupId);
  }
  return true;
}
