import type { ActionInfo, ActionPlannerInfo, ChatConfig, MessageInfo, ActionType } from "../config.js";
import { ActionManager } from "./actionManager.js";
import {
  callWithModelRotation,
  getModelTaskConfig,
  getProviders,
  type ModelCallOptions,
} from "../modelCaller.js";

interface PlanLogEntry {
  reasoning: string;
  timestamp: number;
  content: ActionPlannerInfo[] | string;
}

interface PlannerPromptParams {
  timeBlock: string;
  nameBlock: string;
  chatContextDescription: string;
  chatContentBlock: string;
  actionOptionsText: string;
  actionsBeforeNowBlock: string;
  moderationPrompt: string;
  planStyle: string;
  replyActionExample: string;
}

const PLANNER_PROMPT_TEMPLATE = `{timeBlock}
{nameBlock}
{chatContextDescription}，以下是具体的聊天内容
**聊天内容**
{chatContentBlock}

**可选的action**
reply
动作描述：
1.你可以选择呼叫了你的名字，但是你没有做出回应的消息进行回复
2.你可以自然的顺着正在进行的聊天内容进行回复或自然的提出一个问题
3.最好一次对一个话题进行回复，免得啰嗦或者回复内容太乱。
4.不要选择回复你自己发送的消息
5.不要单独对表情包进行回复
6.将上下文中所有含义不明的，疑似黑话的，缩写词均写入unknown_words中
7.如果你对上下文存在疑问，有需要查询的问题，写入question中
{replyActionExample}

no_reply
动作描述：
保持沉默，不回复直到有新消息
控制聊天频率，不要太过频繁的发言
{{"action":"no_reply"}}

{actionOptionsText}

**你之前的action执行和思考记录**
{actionsBeforeNowBlock}

请选择**可选的**且符合使用条件的action，并说明触发action的消息id(消息id格式:m+数字)
先输出你的简短的选择思考理由，再输出你选择的action，理由不要分点，精简。
**动作选择要求**
请你根据聊天内容,用户的最新消息和以下标准选择合适的动作:
{planStyle}
{moderationPrompt}

target_message_id为必填，表示触发消息的id
请选择所有符合使用要求的action，每个动作最多选择一次，但是可以选择多个动作；
动作用json格式输出，用\`\`\`json包裹，如果输出多个json，每个json都要单独一行放在同一个\`\`\`json代码块内:
**示例**
// 理由文本（简短）
\`\`\`json
{{"action":"动作名", "target_message_id":"m123", .....}}
{{"action":"动作名", "target_message_id":"m456", .....}}
\`\`\``;

const ACTION_PROMPT_TEMPLATE = `{action_name}
动作描述：{action_description}
使用条件{parallel_text}：
{action_require}
{{"action":"{action_name}",{action_parameters}, "target_message_id":"消息id(m+数字)"}}
`;

export class ActionPlanner {
  private chatId: string;
  private actionManager: ActionManager;
  private chatConfig: ChatConfig;
  private config: any;
  private planLog: PlanLogEntry[] = [];
  private lastObsTimeMark: number = 0;

  constructor(chatId: string, actionManager: ActionManager, chatConfig: ChatConfig, config?: any) {
    this.chatId = chatId;
    this.actionManager = actionManager;
    this.chatConfig = chatConfig;
    this.config = config || {};
  }

  async plan(
    availableActions: Record<string, ActionInfo>,
    startTime: number,
    forceReplyMessage?: MessageInfo,
    recentMessages?: MessageInfo[],
    historyMessages?: MessageInfo[]
  ): Promise<ActionPlannerInfo[]> {
    const planStart = Date.now();

    const chatContentBlock = this.buildChatContentBlock(historyMessages || []);
    const messageList = this.buildMessageIdList(historyMessages || []);

    this.lastObsTimeMark = Date.now();

    const filteredActions = this.filterActionsByActivationType(availableActions, chatContentBlock);

    console.log(`[ActionPlanner] 过滤后有${Object.keys(filteredActions).length}个可用动作`);

    const promptStart = Date.now();
    const prompt = await this.buildPlannerPrompt({
      isGroupChat: true,
      currentAvailableActions: filteredActions,
      chatContentBlock,
      messageIdList: messageList,
    });
    const promptDuration = Date.now() - promptStart;

    const { reasoning, actions, llmRawOutput, llmDuration } = await this.executeMainPlanner(
      prompt,
      messageList,
      filteredActions,
      availableActions,
      startTime
    );

    if (forceReplyMessage) {
      const hasReplyToForceMessage = actions.some(
        a => a.actionType === "reply" && 
        a.actionMessage && 
        (a.actionMessage as MessageInfo).id === forceReplyMessage.id
      );

      if (!hasReplyToForceMessage) {
        const noReplyActions = actions.filter(a => a.actionType !== "no_reply");
        noReplyActions.unshift(this.createReplyAction(forceReplyMessage, "用户提及了我，必须回复该消息"));
        console.log(`[ActionPlanner] 检测到强制回复消息，已添加回复动作`);
        return noReplyActions;
      }
    }

    console.log(`[ActionPlanner] ${reasoning}。选择了${actions.length}个动作: ${actions.map(a => a.actionType).join(" ")}`);

    this.addPlanLog(reasoning, actions);

    return actions;
  }

  private buildChatContentBlock(messages: MessageInfo[]): string {
    if (messages.length === 0) return "暂无聊天内容";

    const lines: string[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const timeStr = new Date(msg.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      const msgId = `m${i + 1}`;
      lines.push(`[${timeStr}] ${msgId} ${msg.senderName || msg.userName || "用户"}: ${msg.content}`);
    }
    return lines.join("\n");
  }

  private buildMessageIdList(messages: MessageInfo[]): Array<[string, MessageInfo]> {
    return messages.map((msg, i) => [`m${i + 1}`, msg] as [string, MessageInfo]);
  }

  async buildPlannerPrompt(options: {
    isGroupChat: boolean;
    currentAvailableActions: Record<string, ActionInfo>;
    chatContentBlock: string;
    messageIdList: Array<[string, MessageInfo]>;
    interest?: string;
  }): Promise<string> {
    const { isGroupChat, currentAvailableActions, chatContentBlock, messageIdList, interest } = options;

    const actionsBeforeNowBlock = this.getPlanLogStr();

    const chatContextDescription = "你现在正在一个群聊中";

    const actionOptionsBlock = this.buildActionOptionsBlock(currentAvailableActions);

    const moderationPrompt = "请不要输出违法违规内容，不要输出色情，暴力，政治相关内容，如有敏感内容，请规避。";
    const timeBlock = `当前时间：${new Date().toLocaleString("zh-CN")}`;
    const botName = this.config?.bot?.nickname || "助手";
    const aliasNames = this.config?.bot?.aliasNames || [];
    const botNickname = aliasNames.length > 0 ? `，也有人叫你${aliasNames.join("、")}` : "";
    const nameBlock = `你的名字是${botName}${botNickname}，请注意哪些是你自己的发言。`;

    const thinkMode = this.chatConfig.thinkMode || "classic";
    let replyActionExample = "";
    if (thinkMode === "classic") {
      replyActionExample = '{"action":"reply", "target_message_id":"消息id(m+数字)", "unknown_words":["词语1","词语2"], "question":"需要查询的问题"}';
    } else {
      replyActionExample = `5.think_level表示思考深度，0表示该回复不需要思考和回忆，1表示该回复需要进行回忆和思考
{"action":"reply", "think_level":数值等级(0或1), "target_message_id":"消息id(m+数字)", "unknown_words":["词语1","词语2"], "question":"需要查询的问题"}`;
    }

    const planStyle = this.config?.personality?.planStyle || "根据聊天内容自然地选择合适的动作";

    return PLANNER_PROMPT_TEMPLATE
      .replace("{timeBlock}", timeBlock)
      .replace("{nameBlock}", nameBlock)
      .replace("{chatContextDescription}", chatContextDescription)
      .replace("{chatContentBlock}", chatContentBlock)
      .replace("{actionOptionsText}", actionOptionsBlock)
      .replace("{actionsBeforeNowBlock}", actionsBeforeNowBlock)
      .replace("{moderationPrompt}", moderationPrompt)
      .replace("{planStyle}", planStyle)
      .replace("{replyActionExample}", replyActionExample);
  }

  private buildActionOptionsBlock(currentAvailableActions: Record<string, ActionInfo>): string {
    if (Object.keys(currentAvailableActions).length === 0) return "";

    let block = "";
    for (const [actionName, actionInfo] of Object.entries(currentAvailableActions)) {
      let paramText = "";
      if (actionInfo.actionParameters) {
        paramText = "\n";
        for (const [paramName, paramDesc] of Object.entries(actionInfo.actionParameters)) {
          paramText += `    "${paramName}":"${paramDesc}"\n`;
        }
        paramText = paramText.trimEnd();
      }

      let requireText = "";
      if (actionInfo.actionRequire && actionInfo.actionRequire.length > 0) {
        requireText = actionInfo.actionRequire.map(r => `- ${r}`).join("\n");
      }

      const parallelText = actionInfo.parallelAction ? "" : "(当选择这个动作时，请不要选择其他动作)";

      block += ACTION_PROMPT_TEMPLATE
        .replace("{action_name}", actionName)
        .replace("{action_description}", actionInfo.description)
        .replace("{action_parameters}", paramText)
        .replace("{action_require}", requireText)
        .replace("{parallel_text}", parallelText);
    }

    return block;
  }

  private filterActionsByActivationType(
    availableActions: Record<string, ActionInfo>,
    chatContentBlock: string
  ): Record<string, ActionInfo> {
    const filtered: Record<string, ActionInfo> = {};

    for (const [actionName, actionInfo] of Object.entries(availableActions)) {
      const activationType = actionInfo.activationType || "always";

      switch (activationType) {
        case "never":
          continue;
        case "always":
          filtered[actionName] = actionInfo;
          break;
        case "random":
          if (Math.random() < (actionInfo.priority || 0.5)) {
            filtered[actionName] = actionInfo;
          }
          break;
        case "keyword":
          if (actionInfo.actionRequire) {
            for (const keyword of actionInfo.actionRequire) {
              if (chatContentBlock.includes(keyword)) {
                filtered[actionName] = actionInfo;
                break;
              }
            }
          }
          break;
        default:
          filtered[actionName] = actionInfo;
      }
    }

    return filtered;
  }

  private async executeMainPlanner(
    prompt: string,
    messageIdList: Array<[string, MessageInfo]>,
    filteredActions: Record<string, ActionInfo>,
    availableActions: Record<string, ActionInfo>,
    loopStartTime: number
  ): Promise<{
    reasoning: string;
    actions: ActionPlannerInfo[];
    llmRawOutput?: string;
    llmDuration?: number;
  }> {
    let llmContent: string | undefined;
    const actions: ActionPlannerInfo[] = [];
    let llmDuration: number | undefined;

    try {
      const llmStart = Date.now();
      const llmResult = await this.callPlannerLLM(prompt);
      llmDuration = Date.now() - llmStart;
      llmContent = llmResult.content;

      if (!llmContent) {
        return {
          reasoning: "规划器没有获得LLM响应",
          actions: [this.createNoReplyAction("规划器没有获得LLM响应", availableActions)],
          llmRawOutput: llmContent,
          llmDuration,
        };
      }

      const { jsonObjects, extractedReasoning } = this.extractJsonFromMarkdown(llmContent);
      const reasoning = extractedReasoning || "未提供原因";

      if (jsonObjects.length === 0) {
        console.warn(`[ActionPlanner] LLM没有返回可用动作: ${llmContent}`);
        return {
          reasoning: "LLM没有返回可用动作",
          actions: [this.createNoReplyAction("LLM没有返回可用动作", availableActions)],
          llmRawOutput: llmContent,
          llmDuration,
        };
      }

      const filteredActionsList = Object.entries(filteredActions);
      for (const jsonObj of jsonObjects) {
        const parsedActions = this.parseSingleAction(
          jsonObj,
          messageIdList,
          filteredActionsList,
          reasoning
        );
        actions.push(...parsedActions);
      }

      for (const action of actions) {
        action.actionData = action.actionData || {};
        action.actionData.loopStartTime = loopStartTime;
      }

      const uniqueActions = this.deduplicateActions(actions);

      console.log(`[ActionPlanner] 规划器选择了${uniqueActions.length}个动作: ${uniqueActions.map(a => a.actionType).join(" ")}`);

      return { reasoning, actions: uniqueActions, llmRawOutput: llmContent, llmDuration };

    } catch (error) {
      console.error(`[ActionPlanner] LLM请求执行失败:`, error);
      return {
        reasoning: `LLM请求失败: ${error}`,
        actions: [this.createNoReplyAction(`LLM请求失败: ${error}`, availableActions)],
        llmRawOutput: llmContent,
        llmDuration,
      };
    }
  }

  private async callPlannerLLM(prompt: string): Promise<{ success: boolean; content?: string }> {
    try {
      const providers = getProviders(this.config);
      const taskConfig = getModelTaskConfig(this.config, "planner");

      if (!taskConfig || !taskConfig.models?.length) {
        console.warn("[ActionPlanner] 未配置planner模型任务");
        return { success: false };
      }

      const options: ModelCallOptions = {
        messages: [{ role: "user", content: prompt }],
        maxTokens: taskConfig.maxTokens || 2048,
        temperature: taskConfig.temperature ?? 0.3,
        timeout: 60000,
      };

      const result = await callWithModelRotation(providers, taskConfig, options);

      return {
        success: result.success,
        content: result.content,
      };
    } catch (error) {
      console.error("[ActionPlanner] LLM调用失败:", error);
      return { success: false };
    }
  }

  private extractJsonFromMarkdown(content: string): { jsonObjects: any[]; extractedReasoning: string } {
    const jsonObjects: any[] = [];
    let extractedReasoning = "";

    const jsonPattern = /```json\s*(.*?)\s*```/gs;
    const matches = content.matchAll(jsonPattern);

    let firstJsonPos = content.length;
    const matchesArray = [...matches];
    
    if (matchesArray.length > 0) {
      firstJsonPos = content.indexOf("```json");
      if (firstJsonPos > 0) {
        extractedReasoning = content.substring(0, firstJsonPos).trim();
        extractedReasoning = extractedReasoning.replace(/^\/\/\s*/gm, "").trim();
      }
    }

    for (const match of matchesArray) {
      const jsonStr = match[1].trim();
      if (!jsonStr) continue;

      try {
        const lines = jsonStr.split("\n").filter(line => line.trim());
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line.trim());
            if (typeof parsed === "object" && parsed !== null) {
              if (Array.isArray(parsed)) {
                jsonObjects.push(...parsed.filter(item => typeof item === "object" && item !== null));
              } else {
                jsonObjects.push(parsed);
              }
            }
          } catch {
            // 单行解析失败，尝试整体解析
          }
        }

        if (jsonObjects.length === 0) {
          const parsed = JSON.parse(jsonStr);
          if (Array.isArray(parsed)) {
            jsonObjects.push(...parsed.filter(item => typeof item === "object" && item !== null));
          } else if (typeof parsed === "object" && parsed !== null) {
            jsonObjects.push(parsed);
          }
        }
      } catch (e) {
        console.warn(`[ActionPlanner] 解析JSON块失败:`, e);
      }
    }

    return { jsonObjects, extractedReasoning };
  }

  private parseSingleAction(
    actionJson: any,
    messageIdList: Array<[string, MessageInfo]>,
    currentAvailableActions: Array<[string, ActionInfo]>,
    extractedReasoning: string
  ): ActionPlannerInfo[] {
    const results: ActionPlannerInfo[] = [];

    try {
      const action = actionJson.action || "no_reply";
      const reasoning = extractedReasoning || "未提供原因";
      const actionData: Record<string, unknown> = { ...actionJson };
      delete actionData.action;

      let targetMessage: MessageInfo | undefined;
      const targetMessageId = actionJson.target_message_id;

      if (targetMessageId) {
        targetMessage = this.findMessageById(targetMessageId, messageIdList);
        if (!targetMessage) {
          console.warn(`[ActionPlanner] 无法找到target_message_id '${targetMessageId}' 对应的消息`);
          targetMessage = messageIdList[messageIdList.length - 1]?.[1];
        }
      } else {
        targetMessage = messageIdList[messageIdList.length - 1]?.[1];
      }

      const availableActionNames = currentAvailableActions.map(([name]) => name);
      const internalActionNames = ["no_reply", "reply", "wait_time"];

      if (!internalActionNames.includes(action) && !availableActionNames.includes(action)) {
        console.warn(`[ActionPlanner] LLM返回了不可用的动作: '${action}'，将使用no_reply`);
        return [this.createNoReplyAction(`LLM返回了不可用的动作: ${action}`, Object.fromEntries(currentAvailableActions))];
      }

      results.push({
        actionType: action as ActionType,
        reasoning,
        actionData,
        actionMessage: targetMessage,
        availableActions: availableActionNames as ActionType[],
      });

    } catch (error) {
      console.error(`[ActionPlanner] 解析单个action时出错:`, error);
      results.push(this.createNoReplyAction(`解析action出错: ${error}`, Object.fromEntries(currentAvailableActions)));
    }

    return results;
  }

  private findMessageById(messageId: string, messageIdList: Array<[string, MessageInfo]>): MessageInfo | undefined {
    for (const [id, msg] of messageIdList) {
      if (id === messageId) return msg;
    }
    return undefined;
  }

  private deduplicateActions(actions: ActionPlannerInfo[]): ActionPlannerInfo[] {
    const actionMap = new Map<string, ActionPlannerInfo>();
    const shuffled = [...actions].sort(() => Math.random() - 0.5);
    for (const action of shuffled) {
      actionMap.set(action.actionType as string, action);
    }
    return Array.from(actionMap.values());
  }

  private createNoReplyAction(reasoning: string, availableActions: Record<string, ActionInfo>): ActionPlannerInfo {
    const actionNames = Object.keys(availableActions) as ActionType[];
    return {
      actionType: "no_reply" as ActionType,
      reasoning,
      actionData: {},
      actionMessage: undefined,
      availableActions: actionNames,
    };
  }

  private createReplyAction(message: MessageInfo, reasoning: string): ActionPlannerInfo {
    return {
      actionType: "reply",
      reasoning,
      actionData: {
        thinkLevel: this.chatConfig.thinkMode === "deep" ? 1 : 0,
      },
      actionMessage: message,
      availableActions: [],
    };
  }

  private addPlanLog(reasoning: string, actions: ActionPlannerInfo[]): void {
    this.planLog.push({ reasoning, timestamp: Date.now(), content: actions });
    if (this.planLog.length > 20) {
      this.planLog.shift();
    }
  }

  addPlanExecuteLog(result: string): void {
    this.planLog.push({ reasoning: "", timestamp: Date.now(), content: result });
    if (this.planLog.length > 20) {
      this.planLog.shift();
    }
  }

  getPlanLogStr(maxActionRecords: number = 2, maxExecutionRecords: number = 5): string {
    const actionRecords: PlanLogEntry[] = [];
    const executionRecords: PlanLogEntry[] = [];

    for (const entry of [...this.planLog].reverse()) {
      if (Array.isArray(entry.content)) {
        if (actionRecords.length < maxActionRecords) {
          actionRecords.push(entry);
        }
      } else {
        if (executionRecords.length < maxExecutionRecords) {
          executionRecords.push(entry);
        }
      }
    }

    const allRecords = [...actionRecords, ...executionRecords].sort((a, b) => a.timestamp - b.timestamp);

    let result = "";
    for (const entry of allRecords) {
      const timeStr = new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      if (Array.isArray(entry.content)) {
        result += `${timeStr}:${entry.reasoning}\n`;
      } else {
        result += `${timeStr}:你执行了action:${entry.content}\n`;
      }
    }

    return result;
  }

  getPlanHistory(): ActionPlannerInfo[] {
    return this.planLog.flatMap(entry => Array.isArray(entry.content) ? entry.content : []);
  }

  clearPlanHistory(): void {
    this.planLog = [];
  }

  setConfig(config: any): void {
    this.config = config;
  }
}
