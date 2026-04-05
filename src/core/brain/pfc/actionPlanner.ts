import type { ActionType, ActionPlannerInfo, ChatConfig, MessageInfo, PersonalityConfig } from "../../config.js";
import { buildPersonalityPrompt, buildReplyStylePrompt } from "../../config.js";

const PROMPT_INITIAL_REPLY = `{persona_text}。现在你在参与一场聊天，请根据以下【所有信息】审慎且灵活的决策下一步行动：

【当前对话目标】
{goals_str}

【最近行动历史概要】
{action_history_summary}

【上一次行动的详细情况和结果】
{last_action_context}

【时间和超时提示】
{time_since_last_bot_message_info}

【最近的对话记录】
{chat_history_text}

------
可选行动类型以及解释：
direct_reply: 直接回复对方
no_reply: 不回复，保持沉默
wait: 暂时不说话，等待对方继续发言
listening: 倾听对方发言，当对方在倾诉或表达情感时选择
end_conversation: 结束对话

请以JSON格式输出你的决策：
{{
    "action": "选择的行动类型",
    "reason": "选择该行动的详细原因"
}}

注意：请严格按照JSON格式输出，不要包含任何其他内容。`;

const PROMPT_FOLLOW_UP = `{persona_text}。刚刚你已经回复了对方，请根据以下【所有信息】审慎且灵活的决策下一步行动：

【当前对话目标】
{goals_str}

【最近行动历史概要】
{action_history_summary}

【上一次行动的详细情况和结果】
{last_action_context}

【时间和超时提示】
{time_since_last_bot_message_info}

【最近的对话记录】
{chat_history_text}

------
可选行动类型以及解释：
wait: 暂时不说话，留给对方交互空间
send_new_message: 发送一条新消息继续对话
listening: 倾听对方发言
end_conversation: 结束对话

请以JSON格式输出你的决策：
{{
    "action": "选择的行动类型",
    "reason": "选择该行动的详细原因"
}}

注意：请严格按照JSON格式输出，不要包含任何其他内容。`;

export interface GoalInfo {
  goal: string;
  reasoning: string;
}

export interface ActionHistory {
  action: string;
  planReason: string;
  status: "done" | "recall" | "pending";
  finalReason?: string;
  time: string;
}

export class PFCActionPlanner {
  private chatId: string;
  private chatName: string;
  private chatConfig: ChatConfig;
  private personalityConfig: PersonalityConfig;
  private botName: string;
  private goals: GoalInfo[] = [];
  private actionHistory: ActionHistory[] = [];
  private lastSuccessfulReplyAction: string | null = null;

  constructor(
    chatId: string,
    chatName: string,
    chatConfig: ChatConfig,
    personalityConfig: PersonalityConfig,
    botName: string = "助手"
  ) {
    this.chatId = chatId;
    this.chatName = chatName;
    this.chatConfig = chatConfig;
    this.personalityConfig = personalityConfig;
    this.botName = botName;
  }

  async plan(
    messages: MessageInfo[],
    forceReply: boolean = false,
    llmCall?: (prompt: string) => Promise<string>
  ): Promise<ActionPlannerInfo> {
    const logPrefix = `[${this.chatName}]`;

    if (forceReply) {
      console.log(`${logPrefix} 强制回复模式`);
      return this.createReplyAction(messages[messages.length - 1], "用户@或回复了机器人");
    }

    const prompt = this.buildPrompt(messages);

    if (llmCall) {
      try {
        const response = await llmCall(prompt);
        return this.parseResponse(response, messages);
      } catch (error) {
        console.error(`${logPrefix} LLM调用失败:`, error);
        return this.createNoReplyAction("LLM调用失败");
      }
    }

    return this.createNoReplyAction("未配置LLM调用");
  }

  private buildPrompt(messages: MessageInfo[]): string {
    const personaText = buildPersonalityPrompt(this.personalityConfig);
    const replyStyleText = buildReplyStylePrompt(this.personalityConfig);
    const goalsStr = this.buildGoalsStr();
    const actionHistorySummary = this.buildActionHistorySummary();
    const lastActionContext = this.buildLastActionContext();
    const timeInfo = this.buildTimeInfo(messages);
    const chatHistoryText = this.buildChatHistoryText(messages);

    const template = this.lastSuccessfulReplyAction ? PROMPT_FOLLOW_UP : PROMPT_INITIAL_REPLY;

    return template
      .replace("{persona_text}", personaText + (replyStyleText ? "\n" + replyStyleText : ""))
      .replace("{goals_str}", goalsStr)
      .replace("{action_history_summary}", actionHistorySummary)
      .replace("{last_action_context}", lastActionContext)
      .replace("{time_since_last_bot_message_info}", timeInfo)
      .replace("{chat_history_text}", chatHistoryText);
  }

  private buildGoalsStr(): string {
    if (this.goals.length === 0) {
      return "- 目前没有明确对话目标";
    }
    return this.goals.map(g => `- 目标：${g.goal}\n  原因：${g.reasoning}`).join("\n");
  }

  private buildActionHistorySummary(): string {
    if (this.actionHistory.length === 0) {
      return "你最近执行的行动历史：\n- 还没有执行过行动。";
    }
    const recent = this.actionHistory.slice(-5);
    const lines = recent.map(a => {
      const reasonText = a.finalReason ? `, 失败原因: ${a.finalReason}` : "";
      return `- 时间:${a.time}, 尝试行动:'${a.action}', 状态:${a.status}${reasonText}`;
    });
    return "你最近执行的行动历史：\n" + lines.join("\n");
  }

  private buildLastActionContext(): string {
    if (this.actionHistory.length === 0) {
      return "关于你【上一次尝试】的行动：\n- 这是你规划的第一个行动。";
    }
    const last = this.actionHistory[this.actionHistory.length - 1];
    let context = `关于你【上一次尝试】的行动：\n`;
    context += `- 上次【规划】的行动是: '${last.action}'\n`;
    context += `- 当时规划的【原因】是: ${last.planReason}\n`;
    if (last.status === "done") {
      context += "- 该行动已【成功执行】。\n";
    } else if (last.status === "recall") {
      context += "- 但该行动最终【未能执行/被取消】。\n";
      if (last.finalReason) {
        context += `- 【重要】失败/取消的具体原因是: "${last.finalReason}"\n`;
      }
    }
    return context;
  }

  private buildTimeInfo(messages: MessageInfo[]): string {
    if (messages.length === 0) return "";
    const lastMsg = messages[messages.length - 1];
    const now = Date.now();
    const diff = (now - lastMsg.timestamp) / 1000;
    if (diff < 60) {
      return `提示：最后一条消息是在 ${diff.toFixed(1)} 秒前。`;
    } else if (diff < 3600) {
      return `提示：最后一条消息是在 ${(diff / 60).toFixed(1)} 分钟前。`;
    }
    return `提示：最后一条消息是在 ${(diff / 3600).toFixed(1)} 小时前。`;
  }

  private buildChatHistoryText(messages: MessageInfo[]): string {
    if (messages.length === 0) {
      return "还没有聊天记录。";
    }
    const recent = messages.slice(-10);
    return recent.map(m => {
      const time = new Date(m.timestamp).toLocaleTimeString();
      const source = m.isGroup ? `[群聊]` : `[私聊]`;
      return `${time} ${source} ${m.userName}: ${m.content}`;
    }).join("\n");
  }

  private parseResponse(response: string, messages: MessageInfo[]): ActionPlannerInfo {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return this.createNoReplyAction("未找到JSON响应");
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const action = this.validateAction(parsed.action);
      const reason = parsed.reason || "未提供原因";

      if (action === "direct_reply" || action === "send_new_message") {
        return this.createReplyAction(messages[messages.length - 1], reason);
      }

      return {
        actionType: action,
        reasoning: reason,
        actionData: {},
        actionMessage: undefined,
        availableActions: [],
      };
    } catch (error) {
      console.error("解析响应失败:", error);
      return this.createNoReplyAction("JSON解析失败");
    }
  }

  private validateAction(action: string): ActionType {
    const validActions: ActionType[] = [
      "direct_reply",
      "no_reply",
      "wait",
      "listening",
      "send_new_message",
      "end_conversation",
    ];
    return validActions.includes(action as ActionType) ? (action as ActionType) : "no_reply";
  }

  private createReplyAction(message: MessageInfo | undefined, reason: string): ActionPlannerInfo {
    return {
      actionType: "reply",
      reasoning: reason,
      actionData: {
        thinkLevel: this.chatConfig.thinkMode === "deep" ? 1 : 0,
      },
      actionMessage: message,
      availableActions: [],
    };
  }

  private createNoReplyAction(reason: string): ActionPlannerInfo {
    return {
      actionType: "no_reply",
      reasoning: reason,
      actionData: {},
      actionMessage: undefined,
      availableActions: [],
    };
  }

  addGoal(goal: GoalInfo): void {
    this.goals.unshift(goal);
    if (this.goals.length > 3) {
      this.goals.pop();
    }
  }

  clearGoals(): void {
    this.goals = [];
  }

  recordAction(action: ActionHistory): void {
    this.actionHistory.push(action);
    if (this.actionHistory.length > 20) {
      this.actionHistory = this.actionHistory.slice(-10);
    }

    if ((action.action === "direct_reply" || action.action === "send_new_message") && action.status === "done") {
      this.lastSuccessfulReplyAction = action.action;
    } else if (action.status === "recall") {
      this.lastSuccessfulReplyAction = null;
    }
  }
}
