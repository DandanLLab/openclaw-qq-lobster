import type { MessageInfo, ChatStream, ChatConfig, ActionInfo, ActionPlannerInfo } from "../config.js";
import { ActionManager } from "../planner/actionManager.js";
import { ActionPlanner } from "../planner/actionPlanner.js";
import { ReplyGenerator } from "../replyer/replyGenerator.js";
import {
  callWithModelRotation,
  getModelTaskConfig,
  getProviders,
  type ModelCallOptions,
} from "../modelCaller.js";

interface ThinkingBackResult {
  success: boolean;
  thinking?: string;
  content?: string;
}

const THINKING_BACK_PROMPT = `你是一个深度思考助手。请根据以下聊天内容，进行深度思考和反思。

聊天内容：
{chat_content}

请从以下几个角度进行思考：
1. 话题的主要内容和走向
2. 参与者的情绪和态度
3. 是否有需要记住的重要信息
4. 是否有需要后续跟进的话题

请输出你的思考结果，格式如下：
思考：[你的思考内容]
总结：[一句话总结]`;

export class HeartFCChat {
  private chatId: string;
  private chatStream: ChatStream;
  private chatConfig: ChatConfig;
  private config: any;
  private actionManager: ActionManager;
  private actionPlanner: ActionPlanner;
  private replyGenerator: ReplyGenerator;
  private messageHistory: MessageInfo[] = [];
  private lastProcessTime: number = 0;

  constructor(
    chatId: string,
    chatStream: ChatStream,
    chatConfig: ChatConfig,
    config?: any
  ) {
    this.chatId = chatId;
    this.chatStream = chatStream;
    this.chatConfig = chatConfig;
    this.config = config || {};

    this.actionManager = new ActionManager();
    this.actionPlanner = new ActionPlanner(chatId, this.actionManager, chatConfig, config);
    this.replyGenerator = new ReplyGenerator(chatId, chatStream, undefined, config);

    this.registerDefaultActions();
  }

  private registerDefaultActions(): void {
    this.actionManager.registerAction({
      name: "reply",
      description: "回复消息",
      actionRequire: [
        "有人@了你或者叫了你的名字",
        "有人向你提问",
        "话题与你相关",
        "你想主动参与讨论",
      ],
      actionParameters: {
        think_level: "思考等级(0或1)",
        unknown_words: "不理解的词语列表",
        question: "需要查询的问题",
      },
      parallelAction: true,
      activationType: "always",
    });

    this.actionManager.registerAction({
      name: "no_reply",
      description: "保持沉默，不回复",
      actionRequire: [
        "没有需要你参与的话题",
        "别人在讨论与你无关的内容",
        "你刚刚回复过，需要控制频率",
      ],
      parallelAction: false,
      activationType: "always",
    });

    this.actionManager.registerAction({
      name: "emoji",
      description: "发送表情包",
      actionRequire: [
        "有合适的表情包可以发送",
        "表情包能表达当前情绪",
      ],
      parallelAction: true,
      activationType: "random",
      priority: 0.3,
    });
  }

  async processMessage(message: MessageInfo): Promise<ActionPlannerInfo[]> {
    this.messageHistory.push(message);
    if (this.messageHistory.length > 50) {
      this.messageHistory.shift();
    }

    const recentMessages = this.messageHistory.slice(-10);
    const historyMessages = this.messageHistory.slice(-20);

    const availableActions = this.actionManager.getAllActions();

    const actions = await this.actionPlanner.plan(
      availableActions,
      Date.now(),
      undefined,
      recentMessages,
      historyMessages
    );

    this.lastProcessTime = Date.now();

    return actions;
  }

  async executeAction(action: ActionPlannerInfo): Promise<string> {
    switch (action.actionType) {
      case "reply":
        return await this.executeReplyAction(action);
      case "no_reply":
        return "保持沉默";
      case "emoji":
        return await this.executeEmojiAction(action);
      default:
        return `未知动作: ${action.actionType}`;
    }
  }

  private async executeReplyAction(action: ActionPlannerInfo): Promise<string> {
    const message = action.actionMessage as MessageInfo | undefined;
    const reasoning = action.reasoning || "";
    const thinkLevel = (action.actionData?.thinkLevel as number) || 0;
    const unknownWords = action.actionData?.unknownWords as string[] | undefined;

    const result = await this.replyGenerator.generateReply(
      message,
      reasoning,
      thinkLevel,
      unknownWords
    );

    if (result.success && result.text) {
      console.log(`[HeartFCChat] 生成回复: ${result.text.substring(0, 50)}...`);
      return result.text;
    }

    return "生成回复失败";
  }

  private async executeEmojiAction(action: ActionPlannerInfo): Promise<string> {
    return "[表情包]";
  }

  async thinkingBack(): Promise<ThinkingBackResult> {
    if (this.messageHistory.length === 0) {
      return { success: false };
    }

    const recentMessages = this.messageHistory.slice(-10);
    const chatContent = recentMessages
      .map(m => `${m.senderName}: ${m.content}`)
      .join("\n");

    const prompt = THINKING_BACK_PROMPT.replace("{chat_content}", chatContent);

    const result = await this.callLLM(prompt, "thinking", 0.5);

    if (!result.success || !result.content) {
      return { success: false };
    }

    return {
      success: true,
      thinking: result.content,
      content: result.content,
    };
  }

  private async callLLM(
    prompt: string,
    taskName: string,
    temperature: number = 0.7
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
      const providers = getProviders(this.config);
      const taskConfig = getModelTaskConfig(this.config, taskName);

      if (!taskConfig || !taskConfig.models?.length) {
        return { success: false, error: `未配置${taskName}模型任务` };
      }

      const options: ModelCallOptions = {
        messages: [{ role: "user", content: prompt }],
        maxTokens: taskConfig.maxTokens || 1024,
        temperature: temperature ?? taskConfig.temperature ?? 0.7,
        timeout: 60000,
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

  getMessageHistory(): MessageInfo[] {
    return [...this.messageHistory];
  }

  getLastProcessTime(): number {
    return this.lastProcessTime;
  }

  clearHistory(): void {
    this.messageHistory = [];
  }

  setConfig(config: any): void {
    this.config = config;
    this.actionPlanner.setConfig(config);
    this.replyGenerator.setConfig(config);
  }
}

export class HeartFCChatManager {
  private chats: Map<string, HeartFCChat> = new Map();
  private config: any;

  constructor(config?: any) {
    this.config = config;
  }

  getChat(chatId: string, chatStream: ChatStream, chatConfig: ChatConfig): HeartFCChat {
    if (!this.chats.has(chatId)) {
      this.chats.set(chatId, new HeartFCChat(chatId, chatStream, chatConfig, this.config));
    }
    return this.chats.get(chatId)!;
  }

  hasChat(chatId: string): boolean {
    return this.chats.has(chatId);
  }

  removeChat(chatId: string): void {
    this.chats.delete(chatId);
  }

  getAllChatIds(): string[] {
    return Array.from(this.chats.keys());
  }
}
