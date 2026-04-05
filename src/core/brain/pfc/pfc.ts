export * from "./actionPlanner.js";
export * from "./chatObserver.js";
export * from "./conversationInfo.js";

import { PFCActionPlanner, type GoalInfo, type ActionHistory } from "./actionPlanner.js";
import { createObservationInfo, type ObservationInfo } from "./chatObserver.js";
import { createConversationInfo, addGoal, addDoneAction, type ConversationInfo } from "./conversationInfo.js";
import type { ChatConfig, MessageInfo, PersonalityConfig } from "../../config.js";

export class PFC {
  private chatId: string;
  private chatName: string;
  private actionPlanner: PFCActionPlanner;
  private conversationInfo: ConversationInfo;
  private observationInfo: ObservationInfo | null = null;

  constructor(
    chatId: string,
    chatName: string,
    chatConfig: ChatConfig,
    personalityConfig: PersonalityConfig,
    botName: string = "助手"
  ) {
    this.chatId = chatId;
    this.chatName = chatName;
    this.actionPlanner = new PFCActionPlanner(
      chatId,
      chatName,
      chatConfig,
      personalityConfig,
      botName
    );
    this.conversationInfo = createConversationInfo();
  }

  observe(messages: MessageInfo[], unprocessedMessages: MessageInfo[]): ObservationInfo {
    this.observationInfo = createObservationInfo(messages, unprocessedMessages);
    return this.observationInfo;
  }

  async plan(
    messages: MessageInfo[],
    forceReply: boolean = false,
    llmCall?: (prompt: string) => Promise<string>
  ) {
    return this.actionPlanner.plan(messages, forceReply, llmCall);
  }

  addGoal(goal: GoalInfo): void {
    addGoal(this.conversationInfo, goal);
  }

  recordAction(action: ActionHistory): void {
    addDoneAction(this.conversationInfo, action);
    this.actionPlanner.recordAction(action);
  }

  getConversationInfo(): ConversationInfo {
    return this.conversationInfo;
  }

  getObservationInfo(): ObservationInfo | null {
    return this.observationInfo;
  }
}
