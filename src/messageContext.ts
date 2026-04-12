interface MessageContext {
  userId: number;
  groupId?: number;
  senderName: string;
  isGroup: boolean;
  isPrimary: boolean;
  accountId: string;
  timestamp: number;
  messageId?: string | number;
  groupName?: string;
  userRole?: string;
  memberCount?: number;
}

interface GroupContext {
  groupId: number;
  groupName: string;
  memberCount: number;
  lastActiveTime: number;
}

class MessageContextManager {
  private static instance: MessageContextManager | null = null;
  private currentContext: MessageContext | null = null;
  private contextHistory: Map<string, MessageContext> = new Map();
  private groupContextCache: Map<number, GroupContext> = new Map();

  private constructor() {}

  static getInstance(): MessageContextManager {
    if (!MessageContextManager.instance) {
      MessageContextManager.instance = new MessageContextManager();
    }
    return MessageContextManager.instance;
  }

  setContext(context: MessageContext): void {
    this.currentContext = context;
    const key = context.isGroup 
      ? `group:${context.groupId}` 
      : `user:${context.userId}`;
    this.contextHistory.set(key, context);
    
    if (context.isGroup && context.groupId && context.groupName) {
      this.updateGroupContext(context.groupId, context.groupName, context.memberCount);
    }
  }

  getContext(): MessageContext | null {
    return this.currentContext;
  }

  getContextByGroup(groupId: number): MessageContext | undefined {
    return this.contextHistory.get(`group:${groupId}`);
  }

  getContextByUser(userId: number): MessageContext | undefined {
    return this.contextHistory.get(`user:${userId}`);
  }

  updateGroupContext(groupId: number, groupName: string, memberCount?: number): void {
    const existing = this.groupContextCache.get(groupId);
    this.groupContextCache.set(groupId, {
      groupId,
      groupName: groupName || existing?.groupName || '',
      memberCount: memberCount ?? existing?.memberCount ?? 0,
      lastActiveTime: Date.now()
    });
  }

  getGroupContext(groupId: number): GroupContext | undefined {
    return this.groupContextCache.get(groupId);
  }

  getGroupContextCache(): Map<number, GroupContext> {
    return this.groupContextCache;
  }

  clearContext(): void {
    this.currentContext = null;
  }

  clearAllContexts(): void {
    this.currentContext = null;
    this.contextHistory.clear();
  }

  clearGroupContextCache(): void {
    this.groupContextCache.clear();
  }
}

export function getMessageContextManager(): MessageContextManager {
  return MessageContextManager.getInstance();
}

export function setCurrentMessageContext(context: MessageContext): void {
  MessageContextManager.getInstance().setContext(context);
}

export function getCurrentMessageContext(): MessageContext | null {
  return MessageContextManager.getInstance().getContext();
}

export function updateGroupContext(groupId: number, groupName: string, memberCount?: number): void {
  MessageContextManager.getInstance().updateGroupContext(groupId, groupName, memberCount);
}

export function getGroupContext(groupId: number): GroupContext | undefined {
  return MessageContextManager.getInstance().getGroupContext(groupId);
}

export type { MessageContext, GroupContext };
