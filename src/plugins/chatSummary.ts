import type { PluginContext, PluginResult } from './index.js';

interface MessageRecord {
  senderId: string;
  senderName: string;
  content: string;
  timestamp: number;
}

interface SummaryResult {
  summary: string;
  participantCount: number;
  messageCount: number;
  topTopics: string[];
}

export class ChatSummary {
  private enabled: boolean = true;
  private maxMessages: number = 100;
  private summaryLength: number = 300;
  private messageStore: Map<string, MessageRecord[]> = new Map();

  async initialize(config: any): Promise<void> {
    this.enabled = config.enableChatSummary ?? true;
    this.maxMessages = config.summaryMaxMessages ?? 100;
    this.summaryLength = config.summaryLength ?? 300;
    console.log('[ChatSummary] 初始化完成');
  }

  async handle(ctx: PluginContext): Promise<PluginResult> {
    if (!this.enabled) {
      return { handled: false };
    }

    const { text, groupId, isGroup, client } = ctx;

    if (!isGroup || !groupId) {
      return { handled: false, response: '摘要功能只在群聊中可用哦～' };
    }

    const dailyMatch = text.match(/\/summary\s+(today|今日|今天)/i);
    if (dailyMatch) {
      return this.generateDailySummary(groupId, client);
    }

    const userMatch = text.match(/\/summary\s+user\s+(\d+|@(\d+))/i);
    if (userMatch) {
      const targetUserId = userMatch[2] || userMatch[1];
      return this.generateUserSummary(groupId, parseInt(targetUserId), client);
    }

    if (text.match(/\/summary/i) || text.includes('/摘要')) {
      return this.generateRecentSummary(groupId, client);
    }

    return { handled: false };
  }

  recordMessage(chatId: string, senderId: string, senderName: string, content: string): void {
    if (!this.messageStore.has(chatId)) {
      this.messageStore.set(chatId, []);
    }

    const messages = this.messageStore.get(chatId)!;
    messages.push({
      senderId,
      senderName,
      content,
      timestamp: Date.now()
    });

    if (messages.length > this.maxMessages) {
      messages.shift();
    }
  }

  private async generateDailySummary(groupId: number, client: any): Promise<PluginResult> {
    const chatId = `group:${groupId}`;
    const messages = this.messageStore.get(chatId) || [];
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStart = today.getTime();
    
    const todayMessages = messages.filter(m => m.timestamp >= todayStart);

    if (todayMessages.length === 0) {
      return { handled: true, response: '今天还没有聊天记录呢～' };
    }

    const participants = new Set(todayMessages.map(m => m.senderId));
    const summary = this.summarizeMessages(todayMessages);

    const response = `📊 今日聊天摘要\n` +
      `• 消息数: ${todayMessages.length}\n` +
      `• 参与人数: ${participants.size}\n\n` +
      `${summary}`;

    return { handled: true, response };
  }

  private async generateRecentSummary(groupId: number, client: any): Promise<PluginResult> {
    try {
      const history = await client.getGroupMsgHistory?.(groupId);
      if (!history?.messages || history.messages.length === 0) {
        return { handled: true, response: '没有找到聊天记录呢～' };
      }

      const recentMessages = history.messages.slice(-50);
      const messages: MessageRecord[] = recentMessages.map((m: any) => ({
        senderId: String(m.sender?.user_id || m.user_id),
        senderName: m.sender?.nickname || m.sender?.card || '未知用户',
        content: m.raw_message || '',
        timestamp: (m.time || Date.now() / 1000) * 1000
      }));

      const participants = new Set(messages.map(m => m.senderId));
      const summary = this.summarizeMessages(messages);

      const response = `📊 最近聊天摘要\n` +
        `• 消息数: ${messages.length}\n` +
        `• 参与人数: ${participants.size}\n\n` +
        `${summary}`;

      return { handled: true, response };
    } catch (e) {
      console.error('[ChatSummary] 获取历史消息失败:', e);
      return { handled: false, error: String(e) };
    }
  }

  private async generateUserSummary(groupId: number, userId: number, client: any): Promise<PluginResult> {
    try {
      const history = await client.getGroupMsgHistory?.(groupId);
      if (!history?.messages) {
        return { handled: true, response: '没有找到聊天记录呢～' };
      }

      const userMessages = history.messages.filter(
        (m: any) => String(m.sender?.user_id || m.user_id) === String(userId)
      );

      if (userMessages.length === 0) {
        return { handled: true, response: '该用户没有发言记录呢～' };
      }

      const messages: MessageRecord[] = userMessages.slice(-30).map((m: any) => ({
        senderId: String(m.sender?.user_id),
        senderName: m.sender?.nickname || m.sender?.card || '未知用户',
        content: m.raw_message || '',
        timestamp: (m.time || Date.now() / 1000) * 1000
      }));

      const summary = this.summarizeMessages(messages);
      const userName = messages[0]?.senderName || `用户${userId}`;

      const response = `📊 ${userName} 的发言摘要\n` +
        `• 消息数: ${messages.length}\n\n` +
        `${summary}`;

      return { handled: true, response };
    } catch (e) {
      console.error('[ChatSummary] 获取用户消息失败:', e);
      return { handled: false, error: String(e) };
    }
  }

  private summarizeMessages(messages: MessageRecord[]): string {
    if (messages.length === 0) {
      return '暂无内容';
    }

    const wordFreq = new Map<string, number>();
    const stopWords = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '它', '这', '那', '有', '和', '就', '不', '都', '很', '也', '要', '会', '能', '到', '说', '去', '来', '看', '啊', '吧', '呢', '吗', '哦', '哈', '嗯', '呀']);

    for (const msg of messages) {
      const words = msg.content.split(/\s+/).flatMap(w => {
        const result: string[] = [];
        for (let i = 0; i < w.length - 1; i++) {
          const bigram = w.substring(i, i + 2);
          if (!stopWords.has(bigram) && !/^\d+$/.test(bigram)) {
            result.push(bigram);
          }
        }
        return result;
      });

      for (const word of words) {
        wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
      }
    }

    const topWords = Array.from(wordFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);

    const recentContent = messages
      .slice(-10)
      .map(m => `${m.senderName}: ${m.content.substring(0, 50)}`)
      .join('\n');

    let summary = `🔥 热门话题: ${topWords.slice(0, 5).join('、')}\n\n`;
    summary += `📝 最近讨论:\n${recentContent}`;

    return summary;
  }

  async generateSummaryWithLLM(
    messages: MessageRecord[],
    llmCall: (prompt: string) => Promise<string>
  ): Promise<string> {
    const content = messages
      .map(m => `[${m.senderName}]: ${m.content}`)
      .join('\n');

    const prompt = `请总结以下聊天记录的主要内容，用简洁的中文回答（不超过${this.summaryLength}字）：\n\n${content}\n\n总结：`;

    try {
      return await llmCall(prompt);
    } catch (e) {
      console.error('[ChatSummary] LLM总结失败:', e);
      return this.summarizeMessages(messages);
    }
  }

  getStats(chatId: string): { messageCount: number; participantCount: number } {
    const messages = this.messageStore.get(chatId) || [];
    const participants = new Set(messages.map(m => m.senderId));
    return {
      messageCount: messages.length,
      participantCount: participants.size
    };
  }

  clearHistory(chatId?: string): void {
    if (chatId) {
      this.messageStore.delete(chatId);
    } else {
      this.messageStore.clear();
    }
  }
}
