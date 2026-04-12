interface MessageContext {
  userId: number;
  groupId?: number;
  senderName: string;
  isGroup: boolean;
  isPrimary: boolean;
  accountId: string;
  timestamp: number;
  messageId?: string | number;
}

class MessageContextManager {
  private static instance: MessageContextManager | null = null;
  private currentContext: MessageContext | null = null;
  private contextHistory: Map<string, MessageContext> = new Map();

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

  clearContext(): void {
    this.currentContext = null;
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

export type { MessageContext };
