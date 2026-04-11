export * from "./actionPlanner.js";
export * from "./chatObserver.js";
export * from "./conversationInfo.js";

import { PFCActionPlanner, type GoalInfo, type ActionHistory } from "./actionPlanner.js";
import { createObservationInfo, type ObservationInfo } from "./chatObserver.js";
import { createConversationInfo, addGoal, addDoneAction, type ConversationInfo } from "./conversationInfo.js";
import type { ChatConfig, MessageInfo, PersonalityConfig } from "../../config.js";

export interface ConversationType {
  type: 'public' | 'private' | 'hybrid';
  confidence: number;
  reason: string;
}

export class PFC {
  private chatId: string;
  private chatName: string;
  private actionPlanner: PFCActionPlanner;
  private conversationInfo: ConversationInfo;
  private observationInfo: ObservationInfo | null = null;
  private conversationType: ConversationType = { type: 'public', confidence: 0.5, reason: '默认公共对话' };
  private privateKeywords: Set<string> = new Set([
    '私聊', '私信', '悄悄话', '秘密', '只有我们', '别告诉', '保密',
    '单独', '个人', '私事', '不想让别人知道', '只有你', '我们两个'
  ]);
  private publicKeywords: Set<string> = new Set([
    '大家', '所有人', '群里', '公开', '一起', '各位', '群友',
    '公告', '通知', '分享', '讨论', '投票', '活动'
  ]);

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
    
    if (unprocessedMessages.length > 0) {
      this.updateConversationType(unprocessedMessages);
    }
    
    return this.observationInfo;
  }

  private updateConversationType(messages: MessageInfo[]): void {
    const recentText = messages.map(m => m.content).join(' ');
    
    let privateScore = 0;
    let publicScore = 0;
    
    for (const keyword of this.privateKeywords) {
      if (recentText.includes(keyword)) {
        privateScore += 2;
      }
    }
    
    for (const keyword of this.publicKeywords) {
      if (recentText.includes(keyword)) {
        publicScore += 1;
      }
    }
    
    const mentionedUsers = messages.filter(m => m.isAt).length;
    if (mentionedUsers === 1 && messages.length <= 2) {
      privateScore += 3;
    } else if (mentionedUsers > 1) {
      publicScore += 2;
    }
    
    const totalScore = privateScore + publicScore + 1;
    
    if (privateScore > publicScore * 1.5) {
      this.conversationType = {
        type: 'private',
        confidence: privateScore / totalScore,
        reason: '检测到私密对话关键词或单人互动'
      };
    } else if (publicScore > privateScore * 1.5) {
      this.conversationType = {
        type: 'public',
        confidence: publicScore / totalScore,
        reason: '检测到公共对话关键词或多人互动'
      };
    } else {
      this.conversationType = {
        type: 'hybrid',
        confidence: 0.5,
        reason: '混合对话模式，需要根据上下文判断'
      };
    }
    
    console.log(`[PFC] 对话类型判断: ${this.conversationType.type} (${(this.conversationType.confidence * 100).toFixed(0)}%) - ${this.conversationType.reason}`);
  }

  getConversationType(): ConversationType {
    return this.conversationType;
  }

  shouldCreatePrivateSession(): boolean {
    return this.conversationType.type === 'private' && this.conversationType.confidence > 0.7;
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
