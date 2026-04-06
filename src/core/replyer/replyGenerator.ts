import type { ChatStream, MessageInfo, PersonalityConfig, ActionInfo, ActionPlannerInfo } from "../config.js";
import { buildPersonalityPrompt, buildReplyStylePrompt } from "../config.js";
import {
  callWithModelRotation,
  getModelTaskConfig,
  getProviders,
  type ModelCallOptions,
} from "../modelCaller.js";

export interface ReplyResult {
  success: boolean;
  text: string;
  thinking?: string;
  model?: string;
  provider?: string;
  timing?: {
    promptMs?: number;
    llmMs?: number;
    overallMs?: number;
  };
}

export interface LLMGenerationResult {
  success: boolean;
  content?: string;
  reasoning?: string;
  model?: string;
  provider?: string;
  prompt?: string;
  timing?: Record<string, number>;
}

interface PromptBuildContext {
  chatHistory: string;
  senderName: string;
  targetMessage: string;
  replyReason: string;
  thinkLevel: number;
  unknownWords?: string[];
  extraInfo?: string;
  toolInfo?: string;
  memoryInfo?: string;
  knowledgeInfo?: string;
  expressionHabits?: string;
  keywordsReaction?: string;
}

export class ReplyGenerator {
  private chatId: string;
  private chatStream: ChatStream;
  private personalityConfig?: PersonalityConfig;
  private config: any;

  constructor(chatId: string, chatStream: ChatStream, personalityConfig?: PersonalityConfig, config?: any) {
    this.chatId = chatId;
    this.chatStream = chatStream;
    this.personalityConfig = personalityConfig;
    this.config = config || {};
  }

  async generateReply(
    message: MessageInfo | undefined,
    reasoning: string,
    thinkLevel: number = 0,
    unknownWords?: string[]
  ): Promise<ReplyResult> {
    const overallStart = Date.now();
    
    try {
      const promptStart = Date.now();
      const promptContext = await this.buildPromptContext(message, reasoning, thinkLevel, unknownWords);
      const prompt = this.buildReplyPrompt(promptContext);
      const promptDuration = Date.now() - promptStart;

      console.log(`[ReplyGenerator] 生成回复: ${message?.content?.substring(0, 50)}...`);

      const llmStart = Date.now();
      const llmResult = await this.callLLM(prompt, "replyer");
      const llmDuration = Date.now() - llmStart;

      if (!llmResult.success || !llmResult.content) {
        return {
          success: false,
          text: "",
          timing: {
            promptMs: promptDuration,
            llmMs: llmDuration,
            overallMs: Date.now() - overallStart,
          },
        };
      }

      return {
        success: true,
        text: llmResult.content,
        thinking: llmResult.reasoning,
        model: llmResult.model,
        provider: llmResult.provider,
        timing: {
          promptMs: promptDuration,
          llmMs: llmDuration,
          overallMs: Date.now() - overallStart,
        },
      };
    } catch (error) {
      console.error("[ReplyGenerator] 生成回复失败:", error);
      return {
        success: false,
        text: "",
        timing: {
          overallMs: Date.now() - overallStart,
        },
      };
    }
  }

  async generateReplyWithContext(
    replyMessage: MessageInfo | undefined,
    replyReason: string,
    availableActions: Record<string, ActionInfo> = {},
    chosenActions: ActionPlannerInfo[] = [],
    options: {
      enableTool?: boolean;
      thinkLevel?: number;
      unknownWords?: string[];
      extraInfo?: string;
    } = {}
  ): Promise<LLMGenerationResult> {
    const overallStart = Date.now();
    const { enableTool = true, thinkLevel = 1, unknownWords, extraInfo } = options;

    try {
      const promptStart = Date.now();
      const prompt = await this.buildFullPrompt({
        replyMessage,
        replyReason,
        availableActions,
        chosenActions,
        enableTool,
        thinkLevel,
        unknownWords,
        extraInfo,
      });
      const promptDuration = Date.now() - promptStart;

      if (!prompt) {
        console.warn("[ReplyGenerator] 构建prompt失败");
        return {
          success: false,
          timing: { promptMs: promptDuration, overallMs: Date.now() - overallStart },
        };
      }

      const llmStart = Date.now();
      const llmResult = await this.callLLM(prompt, "replyer");
      const llmDuration = Date.now() - llmStart;

      return {
        success: llmResult.success,
        content: llmResult.content,
        reasoning: llmResult.reasoning,
        model: llmResult.model,
        provider: llmResult.provider,
        prompt,
        timing: {
          promptMs: promptDuration,
          llmMs: llmDuration,
          overallMs: Date.now() - overallStart,
        },
      };
    } catch (error) {
      console.error("[ReplyGenerator] 生成回复失败:", error);
      return {
        success: false,
        timing: { overallMs: Date.now() - overallStart },
      };
    }
  }

  private async buildPromptContext(
    message: MessageInfo | undefined,
    reasoning: string,
    thinkLevel: number,
    unknownWords?: string[]
  ): Promise<PromptBuildContext> {
    const senderName = message?.senderName || message?.userName || "用户";
    const targetMessage = message?.content || "";

    return {
      chatHistory: "",
      senderName,
      targetMessage,
      replyReason: reasoning,
      thinkLevel,
      unknownWords,
    };
  }

  private buildReplyPrompt(context: PromptBuildContext): string {
    const personalityText = this.personalityConfig
      ? buildPersonalityPrompt(this.personalityConfig)
      : "你是一个活泼可爱的AI助手";
    const replyStyleText = this.personalityConfig
      ? buildReplyStylePrompt(this.personalityConfig)
      : "自然、友好、简洁地回复";
    const botName = this.personalityConfig?.name || "助手";

    let prompt = `你是${botName}，${personalityText}

表达风格: ${replyStyleText}

`;

    if (this.chatStream.isGroup) {
      prompt += `当前场景: 群聊 (${this.chatStream.groupName || this.chatStream.groupId})
发送者: ${context.senderName}

`;
    } else {
      prompt += `当前场景: 私聊
发送者: ${context.senderName}

`;
    }

    if (context.targetMessage) {
      prompt += `收到的消息: ${context.targetMessage}

`;
    }

    if (context.unknownWords && context.unknownWords.length > 0) {
      prompt += `不理解的词汇: ${context.unknownWords.join(", ")}
请尝试根据上下文理解这些词汇。

`;
    }

    if (context.toolInfo) {
      prompt += `${context.toolInfo}

`;
    }

    if (context.memoryInfo) {
      prompt += `${context.memoryInfo}

`;
    }

    if (context.knowledgeInfo) {
      prompt += `${context.knowledgeInfo}

`;
    }

    if (context.expressionHabits) {
      prompt += `${context.expressionHabits}

`;
    }

    if (context.keywordsReaction) {
      prompt += `${context.keywordsReaction}

`;
    }

    prompt += `决策原因: ${context.replyReason}

当前时间: ${new Date().toLocaleString("zh-CN")}

【输出格式规则】
1. 如果需要进行内部思考、分析、决策，请放在 <思考>...</思考> 标签内
2. 实际发送给用户的回复内容放在标签外面
3. 示例：<思考>用户在开玩笑，我应该幽默回应</思考>哈哈，你真有趣！

请根据以上信息生成回复。回复要自然、简洁，符合你的性格设定。`;

    return prompt;
  }

  private async buildFullPrompt(options: {
    replyMessage: MessageInfo | undefined;
    replyReason: string;
    availableActions: Record<string, ActionInfo>;
    chosenActions: ActionPlannerInfo[];
    enableTool: boolean;
    thinkLevel: number;
    unknownWords?: string[];
    extraInfo?: string;
  }): Promise<string> {
    const {
      replyMessage,
      replyReason,
      availableActions,
      chosenActions,
      enableTool,
      thinkLevel,
      unknownWords,
      extraInfo,
    } = options;

    const [
      personalityPrompt,
      expressionHabits,
      toolInfo,
      memoryInfo,
      knowledgeInfo,
      actionsPrompt,
      keywordsReaction,
    ] = await Promise.all([
      this.buildPersonalityPrompt(),
      this.buildExpressionHabits(replyMessage?.content || "", replyReason, thinkLevel),
      enableTool ? this.buildToolInfo(replyMessage?.content || "") : Promise.resolve(""),
      this.buildMemoryInfo(replyMessage?.content || ""),
      this.buildKnowledgeInfo(replyMessage?.content || ""),
      this.buildActionsPrompt(availableActions, chosenActions),
      this.buildKeywordsReaction(replyMessage?.content || ""),
    ]);

    const context: PromptBuildContext = {
      chatHistory: "",
      senderName: replyMessage?.senderName || "用户",
      targetMessage: replyMessage?.content || "",
      replyReason,
      thinkLevel,
      unknownWords,
      extraInfo,
      toolInfo,
      memoryInfo,
      knowledgeInfo,
      expressionHabits: expressionHabits.block,
      keywordsReaction,
    };

    let prompt = this.buildReplyPrompt(context);

    if (actionsPrompt) {
      prompt += `

${actionsPrompt}`;
    }

    if (extraInfo) {
      prompt += `

额外信息:
${extraInfo}`;
    }

    return prompt;
  }

  private async buildPersonalityPrompt(): Promise<string> {
    const botName = this.personalityConfig?.name || "助手";
    const aliasNames = this.config?.bot?.aliasNames || [];
    const botNickname = aliasNames.length > 0 ? `，也有人叫你${aliasNames.join("、")}` : "";

    let personality = this.config?.personality?.personality || "你是一个友好的AI助手";
    const states = this.config?.personality?.states || [];
    const stateProbability = this.config?.personality?.stateProbability || 0;

    if (states.length > 0 && stateProbability > 0 && Math.random() < stateProbability) {
      personality = states[Math.floor(Math.random() * states.length)];
    }

    return `你的名字是${botName}${botNickname}，${personality}`;
  }

  private async buildExpressionHabits(
    target: string,
    replyReason: string,
    thinkLevel: number
  ): Promise<{ block: string; selectedIds: number[] }> {
    const useExpression = this.config?.expression?.useExpression ?? true;
    if (!useExpression) {
      return { block: "", selectedIds: [] };
    }

    const expressionGroups = this.config?.expression?.expressionGroups || {};
    const styleHabits: string[] = [];
    const selectedIds: number[] = [];

    const allExpressions: Array<{ situation: string; style: string; id: number }> = [];
    let id = 0;
    for (const [situation, styles] of Object.entries(expressionGroups)) {
      for (const style of styles as string[]) {
        allExpressions.push({ situation, style, id: id++ });
      }
    }

    if (allExpressions.length === 0) {
      return { block: "", selectedIds: [] };
    }

    const maxNum = Math.min(8, allExpressions.length);
    const shuffled = allExpressions.sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, maxNum);

    for (const expr of selected) {
      styleHabits.push(`当${expr.situation}时：${expr.style}`);
      selectedIds.push(expr.id);
    }

    const styleHabitsStr = styleHabits.join("\n");
    const block = styleHabitsStr.trim()
      ? `在回复时，你可以参考以下的语言习惯，不要生硬使用：\n${styleHabitsStr}`
      : "";

    return { block, selectedIds };
  }

  private async buildToolInfo(target: string): Promise<string> {
    return "";
  }

  private async buildMemoryInfo(target: string): Promise<string> {
    return "";
  }

  private async buildKnowledgeInfo(target: string): Promise<string> {
    return "";
  }

  private async buildActionsPrompt(
    availableActions: Record<string, ActionInfo>,
    chosenActions: ActionPlannerInfo[]
  ): Promise<string> {
    const skipNames = ["emoji", "build_memory", "build_relation", "reply"];

    let actionDescriptions = "";
    if (Object.keys(availableActions).length > 0) {
      actionDescriptions = "除了进行回复之外，你可以做以下这些动作，不过这些动作由另一个模型决定：\n";
      for (const [actionName, actionInfo] of Object.entries(availableActions)) {
        if (skipNames.includes(actionName)) continue;
        actionDescriptions += `- ${actionName}: ${actionInfo.description}\n`;
      }
    }

    let chosenActionDescriptions = "";
    if (chosenActions.length > 0) {
      for (const actionPlanInfo of chosenActions) {
        const actionName = actionPlanInfo.actionType;
        if (skipNames.includes(actionName as string)) continue;

        const actionDescription = availableActions[actionName as string]?.description || "无描述";
        const reasoning = actionPlanInfo.reasoning || "无原因";
        chosenActionDescriptions += `- ${actionName}: ${actionDescription}，原因：${reasoning}\n`;
      }

      if (chosenActionDescriptions) {
        actionDescriptions += "\n根据聊天情况，另一个模型决定在回复的同时做以下这些动作：\n";
        actionDescriptions += chosenActionDescriptions;
      }
    }

    return actionDescriptions;
  }

  private async buildKeywordsReaction(target: string): Promise<string> {
    const keywordRules = this.config?.keywordReaction?.keywordRules || [];
    const regexRules = this.config?.keywordReaction?.regexRules || [];

    const reactions: string[] = [];

    for (const rule of keywordRules) {
      const keywords = rule.keywords || [];
      if (keywords.some((kw: string) => target.includes(kw))) {
        reactions.push(rule.reaction);
      }
    }

    for (const rule of regexRules) {
      const patterns = rule.regex || [];
      for (const patternStr of patterns) {
        try {
          const pattern = new RegExp(patternStr);
          if (pattern.test(target)) {
            reactions.push(rule.reaction);
            break;
          }
        } catch (e) {
          console.warn(`正则表达式编译错误: ${patternStr}`);
        }
      }
    }

    return reactions.length > 0 ? reactions.join("，") : "";
  }

  private async callLLM(prompt: string, taskName: string = "replyer"): Promise<{
    success: boolean;
    content?: string;
    reasoning?: string;
    model?: string;
    provider?: string;
  }> {
    try {
      const providers = getProviders(this.config);
      const taskConfig = getModelTaskConfig(this.config, taskName);

      if (!taskConfig || !taskConfig.models?.length) {
        console.warn(`[ReplyGenerator] 未配置${taskName}模型任务`);
        return { success: false };
      }

      const options: ModelCallOptions = {
        messages: [{ role: "user", content: prompt }],
        maxTokens: taskConfig.maxTokens || 1024,
        temperature: taskConfig.temperature ?? 0.7,
        timeout: 60000,
      };

      const result = await callWithModelRotation(providers, taskConfig, options);

      return {
        success: result.success,
        content: result.content,
        reasoning: undefined,
        model: result.model,
        provider: result.provider,
      };
    } catch (error) {
      console.error("[ReplyGenerator] LLM调用失败:", error);
      return { success: false };
    }
  }

  async rewriteReply(
    rawReply: string,
    reason: string,
    replyTo: string
  ): Promise<LLMGenerationResult> {
    const prompt = await this.buildRewritePrompt(rawReply, reason, replyTo);
    
    if (!prompt) {
      return { success: false };
    }

    const llmResult = await this.callLLM(prompt, "replyer");

    return {
      success: llmResult.success,
      content: llmResult.content,
      reasoning: llmResult.reasoning,
      model: llmResult.model,
      provider: llmResult.provider,
      prompt,
    };
  }

  private async buildRewritePrompt(
    rawReply: string,
    reason: string,
    replyTo: string
  ): Promise<string> {
    const [personalityPrompt, expressionHabits] = await Promise.all([
      this.buildPersonalityPrompt(),
      this.buildExpressionHabits(replyTo, reason, 1),
    ]);

    const timeBlock = `当前时间：${new Date().toLocaleString("zh-CN")}`;
    const moderationPrompt = "请不要输出违法违规内容，不要输出色情，暴力，政治相关内容，如有敏感内容，请规避。";

    const replyTargetBlock = replyTo
      ? `现在${replyTo}引起了你的注意，你想要在群里发言或者回复这条消息。`
      : "现在，你想要在群里发言或者回复消息。";

    const replyStyle = this.config?.personality?.replyStyle || "自然、友好";

    return `你是表达器，负责将原始回复重写为更自然、更符合人设的表达。

${personalityPrompt}

${expressionHabits.block}

${timeBlock}

${replyTargetBlock}

原始回复: ${rawReply}
回复原因: ${reason}

表达风格: ${replyStyle}

${moderationPrompt}

请将原始回复重写为更自然、更符合你人设的表达。只输出重写后的内容，不要解释。`;
  }

  setPersonalityConfig(config: PersonalityConfig): void {
    this.personalityConfig = config;
  }

  setConfig(config: any): void {
    this.config = config;
  }
}
