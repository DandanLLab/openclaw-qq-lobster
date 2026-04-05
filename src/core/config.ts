export type ActionType = "direct_reply" | "no_reply" | "wait" | "listening" | "end_conversation" | "reply" | "send_new_message" | "emoji";

export interface MessageInfo {
  id: string;
  messageId?: string;
  content: string;
  senderId: string;
  senderName: string;
  timestamp: number;
  isMentioned?: boolean;
  isAt?: boolean;
  chatId: string;
  chatType: "private" | "group" | "guild";
  groupId?: number;
  userId?: number;
  isGroup?: boolean;
  userName?: string;
}

export interface ChatConfig {
  thinkMode?: "classic" | "deep" | "dynamic";
  plannerSmooth?: number;
  mentionedBotReply?: boolean;
  talkValue?: number;
  maxHistoryLength?: number;
  replyProbability?: number;
}

export interface PersonalityConfig {
  name?: string;
  traits?: string[];
  speakingStyle?: string;
  background?: string;
}

export interface ChatStream {
  chatId: string;
  userName?: string;
  groupName?: string;
  groupId?: string;
  isGroup?: boolean;
  chatType: "private" | "group" | "guild";
  sendMessage: (text: string) => Promise<void>;
}

export interface ActionInfo {
  actionType?: string;
  name?: string;
  description: string;
  priority?: number;
  cooldown?: number;
  actionParameters?: Record<string, unknown>;
  activationType?: string;
  actionRequire?: string[];
  parallelAction?: boolean;
}

export interface ActionPlannerInfo {
  actionType: ActionType;
  actionMessage?: string | MessageInfo;
  reasoning?: string;
  actionData?: Record<string, unknown>;
  availableActions?: ActionType[];
}

export interface ActionTypeConfig {
  type: string;
  name: string;
  description: string;
}

export interface CycleDetail {
  cycleId: number;
  thinkingId: string;
  startTime: number;
  endTime?: number;
  loopInfo?: {
    loopPlanInfo: { actionResult: ActionPlannerInfo[] };
    loopActionInfo: {
      actionTaken: boolean;
      replyText: string;
      command: string;
      takenTime: number;
    };
  };
  timers?: Record<string, number>;
}

export interface MemoryConfig {
  maxEntries?: number;
  retentionDays?: number;
  maxAgentIterations?: number;
  agentTimeoutSeconds?: number;
  globalMemory?: boolean | string;
  globalMemoryBlacklist?: string[];
  plannerQuestion?: string;
}

export interface MessageReceiveConfig {
  maxQueueSize?: number;
  banWords?: string[];
  banMsgsRegex?: string[];
}

export interface ExpressionConfig {
  maxExpressions?: number;
  learningEnabled?: boolean;
  learningList?: string[];
  expressionGroups?: Record<string, string[]>;
  expressionSelfReflect?: boolean;
  expressionManualReflect?: boolean;
  manualReflectOperatorId?: string;
  allowReflect?: boolean;
  allGlobalJargon?: string[];
  enableJargonExplanation?: boolean;
  jargonMode?: string;
  expressionCheckedOnly?: boolean;
  expressionAutoCheckInterval?: number;
  expressionAutoCheckCount?: number;
  expressionAutoCheckCustomCriteria?: string;
}

export function createCycleDetail(cycleId: number): CycleDetail {
  return {
    cycleId,
    thinkingId: `think_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    startTime: Date.now(),
  };
}

export function getTalkValue(config: ChatConfig, chatId: string): number {
  return config.talkValue ?? 0.5;
}

export function buildPersonalityPrompt(config: PersonalityConfig): string {
  const parts: string[] = [];
  if (config.name) parts.push(`你的名字是${config.name}。`);
  if (config.traits?.length) parts.push(`你的性格特点: ${config.traits.join("、")}。`);
  if (config.speakingStyle) parts.push(`说话风格: ${config.speakingStyle}。`);
  if (config.background) parts.push(`背景: ${config.background}。`);
  return parts.join("\n") || "你是一个友好的AI助手。";
}

export function buildReplyStylePrompt(config: PersonalityConfig): string {
  if (config.speakingStyle) {
    return `请用${config.speakingStyle}的风格回复。`;
  }
  return "请用自然、友好的风格回复。";
}

export const AVAILABLE_ACTION_TYPES: ActionTypeConfig[] = [
  { type: "direct_reply", name: "直接回复", description: "直接回复对方" },
  { type: "no_reply", name: "不回复", description: "不回复，保持沉默" },
  { type: "wait", name: "等待", description: "暂时不说话，等待对方继续发言" },
  { type: "listening", name: "倾听", description: "倾听对方发言，当对方在倾诉或表达情感时选择" },
  { type: "end_conversation", name: "结束对话", description: "结束对话" },
  { type: "reply", name: "回复", description: "回复消息" },
  { type: "send_new_message", name: "发送新消息", description: "主动发送新消息" },
];
