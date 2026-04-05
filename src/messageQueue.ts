interface QueuedMessage {
  chatId: string;
  userId: number;
  groupId?: number;
  senderName: string;
  text: string;
  timestamp: number;
  isMentioned: boolean;
  event: any;
  priority: number;
}

interface ChatQueueState {
  messages: QueuedMessage[];
  processing: boolean;
  currentAbortController?: AbortController;
}

interface UserConversationRecord {
  userId: number;
  lastMessageTime: number;
  lastBotReplyTime: number;
  messageCount: number;
  botReplyCount: number;
}

interface ChatConversationState {
  recentUsers: Map<number, UserConversationRecord>;
  lastBotReplyTime: number;
  lastBotReplyToUser: number | null;
}

class MessageQueueManager {
  private static instance: MessageQueueManager | null = null;
  private queues: Map<string, ChatQueueState> = new Map();
  private conversationStates: Map<string, ChatConversationState> = new Map();
  private maxQueueSize: number = 10;
  private messageTimeout: number = 60000;
  private conversationTimeout: number = 300000;

  private constructor() {}

  static getInstance(): MessageQueueManager {
    if (!MessageQueueManager.instance) {
      MessageQueueManager.instance = new MessageQueueManager();
    }
    return MessageQueueManager.instance;
  }

  private getOrCreateConversationState(chatId: string): ChatConversationState {
    let state = this.conversationStates.get(chatId);
    if (!state) {
      state = {
        recentUsers: new Map(),
        lastBotReplyTime: 0,
        lastBotReplyToUser: null
      };
      this.conversationStates.set(chatId, state);
    }
    return state;
  }

  recordUserMessage(chatId: string, userId: number): void {
    const state = this.getOrCreateConversationState(chatId);
    const now = Date.now();
    
    let record = state.recentUsers.get(userId);
    if (!record) {
      record = {
        userId,
        lastMessageTime: now,
        lastBotReplyTime: 0,
        messageCount: 0,
        botReplyCount: 0
      };
    }
    
    record.lastMessageTime = now;
    record.messageCount++;
    state.recentUsers.set(userId, record);
    
    this.cleanOldConversationRecords(chatId);
  }

  recordBotReply(chatId: string, toUserId: number): void {
    const state = this.getOrCreateConversationState(chatId);
    const now = Date.now();
    
    state.lastBotReplyTime = now;
    state.lastBotReplyToUser = toUserId;
    
    let record = state.recentUsers.get(toUserId);
    if (record) {
      record.lastBotReplyTime = now;
      record.botReplyCount++;
      state.recentUsers.set(toUserId, record);
    }
  }

  hasRecentConversationWithUser(chatId: string, userId: number): {
    hasConversation: boolean;
    lastBotReplyToThisUser: boolean;
    recentBotReplyTime: number;
    conversationScore: number;
  } {
    const state = this.conversationStates.get(chatId);
    if (!state) {
      return {
        hasConversation: false,
        lastBotReplyToThisUser: false,
        recentBotReplyTime: 0,
        conversationScore: 0
      };
    }

    const now = Date.now();
    const record = state.recentUsers.get(userId);
    const lastBotReplyToThisUser = state.lastBotReplyToUser === userId;
    const timeSinceLastBotReply = now - state.lastBotReplyTime;
    
    let conversationScore = 0;
    
    if (record) {
      if (record.botReplyCount > 0) {
        conversationScore += 0.3;
      }
      if (record.messageCount > 1) {
        conversationScore += 0.1;
      }
    }
    
    if (lastBotReplyToThisUser && timeSinceLastBotReply < this.conversationTimeout) {
      conversationScore += 0.4;
    }
    
    if (timeSinceLastBotReply < 60000) {
      conversationScore += 0.2;
    } else if (timeSinceLastBotReply < 180000) {
      conversationScore += 0.1;
    }

    return {
      hasConversation: conversationScore > 0,
      lastBotReplyToThisUser,
      recentBotReplyTime: state.lastBotReplyTime,
      conversationScore: Math.min(conversationScore, 1)
    };
  }

  getDynamicTalkValue(chatId: string, userId: number, baseTalkValue: number): number {
    const convInfo = this.hasRecentConversationWithUser(chatId, userId);
    
    if (!convInfo.hasConversation) {
      return baseTalkValue;
    }
    
    const boost = convInfo.conversationScore * 0.35;
    const dynamicValue = baseTalkValue + boost;
    
    console.log(`[MessageQueue] 用户 ${userId} 对话分数: ${convInfo.conversationScore.toFixed(2)}, 概率提升: ${boost.toFixed(2)}`);
    
    return Math.min(dynamicValue, 0.95);
  }

  private cleanOldConversationRecords(chatId: string): void {
    const state = this.conversationStates.get(chatId);
    if (!state) return;
    
    const now = Date.now();
    const usersToDelete: number[] = [];
    
    state.recentUsers.forEach((record, userId) => {
      if (now - record.lastMessageTime > this.conversationTimeout) {
        usersToDelete.push(userId);
      }
    });
    
    usersToDelete.forEach(userId => state.recentUsers.delete(userId));
  }

  enqueue(chatId: string, msg: Omit<QueuedMessage, 'priority'>): {
    shouldProcess: boolean;
    cancelledMessages: QueuedMessage[];
    contextMessages: QueuedMessage[];
  } {
    let state = this.queues.get(chatId);
    if (!state) {
      state = { messages: [], processing: false };
      this.queues.set(chatId, state);
    }

    this.cleanOldMessages(state);
    this.recordUserMessage(chatId, msg.userId);

    const priority = msg.isMentioned ? 100 : 0;
    const queuedMsg: QueuedMessage = { ...msg, priority };

    if (msg.isMentioned && state.processing) {
      if (state.currentAbortController) {
        state.currentAbortController.abort();
        console.log(`[MessageQueue] 取消当前处理中的任务，优先处理@消息`);
      }
      
      const cancelledMessages = [...state.messages];
      state.messages = [queuedMsg];
      state.processing = false;
      
      return {
        shouldProcess: true,
        cancelledMessages,
        contextMessages: cancelledMessages
      };
    }

    if (state.messages.length >= this.maxQueueSize) {
      state.messages.shift();
    }

    state.messages.push(queuedMsg);

    if (!state.processing) {
      return {
        shouldProcess: true,
        cancelledMessages: [],
        contextMessages: state.messages.slice(0, -1)
      };
    }

    return {
      shouldProcess: false,
      cancelledMessages: [],
      contextMessages: state.messages.slice(0, -1)
    };
  }

  startProcessing(chatId: string): AbortController | null {
    const state = this.queues.get(chatId);
    if (!state) return null;

    state.processing = true;
    state.currentAbortController = new AbortController();
    return state.currentAbortController;
  }

  finishProcessing(chatId: string, repliedToUserId?: number): void {
    const state = this.queues.get(chatId);
    if (!state) return;

    state.processing = false;
    state.currentAbortController = undefined;
    
    if (state.messages.length > 0) {
      state.messages = state.messages.slice(-3);
    }
    
    if (repliedToUserId) {
      this.recordBotReply(chatId, repliedToUserId);
    }
  }

  getQueuedMessages(chatId: string): QueuedMessage[] {
    const state = this.queues.get(chatId);
    return state ? [...state.messages] : [];
  }

  getContextForChat(chatId: string): string {
    const state = this.queues.get(chatId);
    if (!state || state.messages.length === 0) return '';

    const recentMessages = state.messages.slice(-5);
    return recentMessages.map(msg => 
      `[${msg.senderName}(${msg.userId})]: ${msg.text}`
    ).join('\n');
  }

  private cleanOldMessages(state: ChatQueueState): void {
    const now = Date.now();
    state.messages = state.messages.filter(
      msg => now - msg.timestamp < this.messageTimeout
    );
  }

  clearQueue(chatId: string): void {
    this.queues.delete(chatId);
    this.conversationStates.delete(chatId);
  }

  getStats(): { totalQueues: number; totalMessages: number; activeConversations: number } {
    let totalMessages = 0;
    let activeConversations = 0;
    
    this.queues.forEach(state => {
      totalMessages += state.messages.length;
    });
    
    this.conversationStates.forEach(state => {
      if (state.recentUsers.size > 0) activeConversations++;
    });
    
    return {
      totalQueues: this.queues.size,
      totalMessages,
      activeConversations
    };
  }
}

export function getMessageQueueManager(): MessageQueueManager {
  return MessageQueueManager.getInstance();
}

export type { QueuedMessage, ChatQueueState, UserConversationRecord, ChatConversationState };
