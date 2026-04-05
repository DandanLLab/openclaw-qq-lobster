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

export const QQConfigSchema = z.object({
  wsUrl: z.string().url().describe("The WebSocket URL of the OneBot v11 server (e.g. ws://localhost:3001)"),
  accessToken: z.string().optional().describe("The access token for the OneBot server"),
  admins: z.array(z.number()).optional().describe("List of admin QQ numbers"),
  requireMention: z.boolean().optional().default(true).describe("Require @mention or reply to bot in group chats"),
  systemPrompt: z.string().optional().describe("Custom system prompt to inject into the context"),
  enableDeduplication: z.boolean().optional().default(true).describe("Enable message deduplication to prevent double replies"),
  enableErrorNotify: z.boolean().optional().default(true).describe("Notify admins or users when errors occur"),
  autoApproveRequests: z.boolean().optional().default(false).describe("Automatically approve friend/group add requests"),
  maxMessageLength: z.number().optional().default(4000).describe("Maximum length of a single message before splitting"),
  formatMarkdown: z.boolean().optional().default(false).describe("Format markdown to plain text for better readability"),
  antiRiskMode: z.boolean().optional().default(false).describe("Enable anti-risk processing (e.g. modify URLs)"),
  allowedGroups: z.array(z.number()).optional().describe("Whitelist of group IDs allowed to interact with"),
  blockedUsers: z.array(z.number()).optional().describe("Blacklist of user IDs to ignore"),
  historyLimit: z.number().optional().default(5).describe("Number of history messages to include in context"),
  keywordTriggers: z.array(z.string()).optional().describe("List of keywords that trigger the bot (without @)"),
  enableTTS: z.boolean().optional().default(false).describe("Experimental: Convert AI text replies to voice (TTS)"),
  enableGuilds: z.boolean().optional().default(true).describe("Enable QQ Guild (Channel) support"),
  rateLimitMs: z.number().optional().default(1000).describe("Delay in ms between sent messages to avoid risk"),
  enableImageRecognition: z.boolean().optional().default(true).describe("Enable VLM-based image content recognition"),
  imageRecognitionPrompt: z.string().optional().default("请简洁描述这张图片的内容，如果是表情包请描述表达的情感。").describe("Custom prompt for image recognition"),
  talkValue: z.number().optional().default(0.5).describe("Probability of auto-reply in group chats when not mentioned (0.0-1.0)"),
  enableModeration: z.boolean().optional().default(true).describe("Enable AI-based content moderation"),
  autoMuteMaxDuration: z.number().optional().default(60).describe("Maximum auto-mute duration in seconds (default: 60s)"),
  requireAdminApprovalForKick: z.boolean().optional().default(true).describe("Require admin approval for kick actions"),
  requireAdminApprovalForLongMute: z.boolean().optional().default(true).describe("Require admin approval for mutes longer than autoMuteMaxDuration"),
  moderationExemptUsers: z.array(z.number()).optional().describe("User IDs exempt from moderation"),
  moderationExemptGroups: z.array(z.number()).optional().describe("Group IDs where moderation is disabled"),
  moderationGroups: z.array(z.number()).optional().describe("Group IDs where moderation is enabled (whitelist)"),
  useCustomModelCaller: z.boolean().optional().default(false).describe("Use custom model rotation for reply generation (default: false, use core)"),
  primaryGroup: z.number().optional().describe("主群号（核心群聊，机器人主要负责的群）"),
  groupChannels: z.record(z.string(), GroupChannelConfigSchema).optional().describe("各群聊的独立配置（key为群号字符串）"),
  enableUrlSummary: z.boolean().optional().default(true).describe("Enable automatic URL summary when detecting URLs in messages"),
  enableSmartSegmentationLLM: z.boolean().optional().default(false).describe("Use LLM for smart message segmentation (more natural but slower)"),
  autoSendEmoji: z.boolean().optional().default(false).describe("Automatically send emoji based on detected emotion"),
  autoSendEmojiProbability: z.number().optional().default(0.3).describe("Probability of auto-sending emoji when emotion detected (0.0-1.0)"),
  autoSendEmojiMinIntensity: z.number().optional().default(0.5).describe("Minimum emotion intensity to trigger auto emoji (0.0-1.0)"),
});

export type QQConfig = z.infer<typeof QQConfigSchema>;

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
