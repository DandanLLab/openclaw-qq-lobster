import type { PluginContext, PluginResult } from './index.js';

interface Memory {
  id: string;
  content: string;
  level: number;
  tags: string[];
  importance: number;
  createdAt: number;
  lastAccessed: number;
  accessCount: number;
  source: string;
  metadata?: Record<string, any>;
}

interface MemoryLevel {
  name: string;
  maxItems: number;
  compressThreshold: number;
  retentionDays: number;
}

export class MemoryManager {
  private enabled: boolean = true;
  private maxMemories: number = 1000;
  private shortTermTTL: number = 86400000;
  private longTermTTL: number = 2592000000;
  private memories: Map<string, Memory[]> = new Map();
  private globalMemories: Memory[] = [];
  private autoDiaryThreshold: number = 30;
  private onAutoDiary?: (chatId: string) => Promise<void>;
  private onContextCompress?: (chatId: string, summary: string) => void;
  
  private levels: MemoryLevel[] = [
    { name: 'daily', maxItems: 100, compressThreshold: 50, retentionDays: 7 },
    { name: 'weekly', maxItems: 200, compressThreshold: 100, retentionDays: 30 },
    { name: 'monthly', maxItems: 300, compressThreshold: 150, retentionDays: 90 },
    { name: 'forever', maxItems: 500, compressThreshold: 250, retentionDays: 365 }
  ];

  async initialize(config: any): Promise<void> {
    this.enabled = config.enableMemory ?? true;
    this.maxMemories = config.maxMemories ?? 1000;
    this.shortTermTTL = (config.memoryShortTermTTL ?? 1) * 86400000;
    this.longTermTTL = (config.memoryLongTermTTL ?? 30) * 86400000;
    this.autoDiaryThreshold = config.autoDiaryThreshold ?? 30;
    console.log('[MemoryManager] 初始化完成, 最大记忆数:', this.maxMemories, ', 自动日记阈值:', this.autoDiaryThreshold);
  }

  setOnAutoDiary(callback: (chatId: string) => Promise<void>): void {
    this.onAutoDiary = callback;
  }

  setOnContextCompress(callback: (chatId: string, summary: string) => void): void {
    this.onContextCompress = callback;
  }

  async handle(ctx: PluginContext): Promise<PluginResult> {
    if (!this.enabled) {
      return { handled: false };
    }

    const { text, groupId, userId } = ctx;

    if (text.match(/\/memory\s+list/i) || text.includes('/记忆 列表')) {
      return this.listMemories(groupId, userId);
    }

    if (text.match(/\/memory\s+add\s+(.+)/i)) {
      const match = text.match(/\/memory\s+add\s+(.+)/i);
      if (match) {
        return this.addMemory(groupId, userId, match[1].trim());
      }
    }

    if (text.match(/\/memory\s+search\s+(.+)/i)) {
      const match = text.match(/\/memory\s+search\s+(.+)/i);
      if (match) {
        return this.searchMemories(groupId, userId, match[1].trim());
      }
    }

    if (text.match(/\/memory\s+clear/i)) {
      return this.clearMemories(groupId, userId);
    }

    if (text.match(/\/memory\s+stats/i) || text.includes('/记忆 统计')) {
      return this.getStats(groupId);
    }

    if (text.match(/\/memory\s+share/i) || text.includes('/记忆 共享')) {
      return this.shareMemory(ctx);
    }

    if (text.match(/\/memory/i) || text.includes('/记忆')) {
      return this.showHelp();
    }

    return { handled: false };
  }

  storeMemory(
    chatId: string,
    content: string,
    importance: number = 0.5,
    tags: string[] = [],
    source: string = 'chat'
  ): string {
    const memory: Memory = {
      id: `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      content,
      level: 0,
      tags,
      importance,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      accessCount: 0,
      source
    };

    if (!this.memories.has(chatId)) {
      this.memories.set(chatId, []);
    }

    const chatMemories = this.memories.get(chatId)!;
    chatMemories.push(memory);

    this.checkAndTriggerAutoActions(chatId);

    if (chatMemories.length > this.maxMemories) {
      this.compressMemories(chatId);
    }

    return memory.id;
  }

  private checkAndTriggerAutoActions(chatId: string): void {
    const chatMemories = this.memories.get(chatId);
    if (!chatMemories) return;

    const todayMemories = chatMemories.filter(m => {
      const today = new Date().toISOString().split('T')[0];
      const memoryDate = new Date(m.createdAt).toISOString().split('T')[0];
      return memoryDate === today;
    });

    if (todayMemories.length >= this.autoDiaryThreshold && this.onAutoDiary) {
      console.log(`[MemoryManager] 📝 达到日记阈值 (${todayMemories.length}/${this.autoDiaryThreshold})，触发自动日记`);
      this.onAutoDiary(chatId).catch(e => {
        console.warn('[MemoryManager] 自动日记生成失败:', e);
      });
    }

    if (chatMemories.length >= this.maxMemories * 0.8) {
      console.log(`[MemoryManager] 🗜️ 记忆接近上限，触发上下文整理`);
      this.autoCompressContext(chatId);
    }
  }

  private autoCompressContext(chatId: string): void {
    const chatMemories = this.memories.get(chatId);
    if (!chatMemories || chatMemories.length === 0) return;

    const importantMemories = chatMemories
      .filter(m => m.importance > 0.6)
      .slice(-20);

    const summary = this.generateContextSummary(importantMemories);
    
    if (this.onContextCompress) {
      this.onContextCompress(chatId, summary);
    }

    const compressedCount = chatMemories.length - importantMemories.length;
    if (compressedCount > 0) {
      this.memories.set(chatId, importantMemories);
      console.log(`[MemoryManager] 🗜️ 已压缩 ${compressedCount} 条记忆，保留 ${importantMemories.length} 条重要记忆`);
    }
  }

  private generateContextSummary(memories: Memory[]): string {
    if (memories.length === 0) return '';

    const topics = new Map<string, number>();
    const entities = new Map<string, number>();

    for (const memory of memories) {
      for (const tag of memory.tags) {
        topics.set(tag, (topics.get(tag) || 0) + 1);
      }

      const entityMatches = memory.content.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
      for (const entity of entityMatches) {
        entities.set(entity, (entities.get(entity) || 0) + 1);
      }
    }

    const topTopics = Array.from(topics.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([topic]) => topic);

    const topEntities = Array.from(entities.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([entity]) => entity);

    let summary = '📊 上下文摘要\n\n';
    if (topTopics.length > 0) {
      summary += `热门话题: ${topTopics.join('、')}\n`;
    }
    if (topEntities.length > 0) {
      summary += `关键实体: ${topEntities.join('、')}\n`;
    }
    summary += `记忆数量: ${memories.length}\n`;

    return summary;
  }

  storeGlobalMemory(
    content: string,
    importance: number = 0.8,
    tags: string[] = [],
    source: string = 'global'
  ): string {
    const memory: Memory = {
      id: `gmem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      content,
      level: 3,
      tags,
      importance,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      accessCount: 0,
      source
    };

    this.globalMemories.push(memory);

    if (this.globalMemories.length > this.levels[3].maxItems) {
      this.compressGlobalMemories();
    }

    return memory.id;
  }

  retrieveMemories(
    chatId: string,
    query: string,
    limit: number = 10
  ): Memory[] {
    const chatMemories = this.memories.get(chatId) || [];
    const allMemories = [...chatMemories, ...this.globalMemories];

    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/);

    const scored = allMemories.map(memory => {
      let score = 0;
      const contentLower = memory.content.toLowerCase();

      for (const word of queryWords) {
        if (contentLower.includes(word)) {
          score += 10;
        }
      }

      for (const tag of memory.tags) {
        if (queryLower.includes(tag.toLowerCase())) {
          score += 5;
        }
      }

      score += memory.importance * 5;
      score += Math.min(memory.accessCount, 10);

      const ageDays = (Date.now() - memory.createdAt) / 86400000;
      if (ageDays < 1) score += 3;
      else if (ageDays < 7) score += 2;
      else if (ageDays < 30) score += 1;

      return { memory, score };
    });

    const sorted = scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    for (const { memory } of sorted) {
      memory.lastAccessed = Date.now();
      memory.accessCount++;
    }

    return sorted.map(s => s.memory);
  }

  getRecentMemories(chatId: string, limit: number = 10): Memory[] {
    const chatMemories = this.memories.get(chatId) || [];
    return chatMemories
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  getImportantMemories(chatId: string, limit: number = 10): Memory[] {
    const chatMemories = this.memories.get(chatId) || [];
    return chatMemories
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);
  }

  promoteMemory(memoryId: string): boolean {
    for (const [, memories] of this.memories) {
      const memory = memories.find(m => m.id === memoryId);
      if (memory) {
        memory.level = Math.min(memory.level + 1, 3);
        memory.importance = Math.min(memory.importance + 0.1, 1);
        return true;
      }
    }
    return false;
  }

  private compressMemories(chatId: string): void {
    const memories = this.memories.get(chatId);
    if (!memories) return;

    const now = Date.now();
    const validMemories = memories.filter(m => {
      const age = now - m.createdAt;
      const maxAge = m.level === 0 ? this.shortTermTTL : this.longTermTTL;
      return age < maxAge || m.importance > 0.7;
    });

    const sorted = validMemories.sort((a, b) => {
      if (a.level !== b.level) return b.level - a.level;
      return b.importance - a.importance;
    });

    this.memories.set(chatId, sorted.slice(0, this.maxMemories * 0.8));
  }

  private compressGlobalMemories(): void {
    const sorted = this.globalMemories.sort((a, b) => b.importance - a.importance);
    this.globalMemories = sorted.slice(0, this.levels[3].maxItems * 0.8);
  }

  private listMemories(groupId: number | undefined, userId: number): PluginResult {
    const chatId = groupId ? `group:${groupId}` : `user:${userId}`;
    const memories = this.memories.get(chatId) || [];

    if (memories.length === 0) {
      return { handled: true, response: '还没有记忆呢～' };
    }

    const recent = memories
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10)
      .map(m => {
        const date = new Date(m.createdAt).toLocaleDateString('zh-CN');
        const preview = m.content.length > 30 ? m.content.substring(0, 27) + '...' : m.content;
        return `• [${date}] ${preview}`;
      })
      .join('\n');

    return { handled: true, response: `🧠 记忆列表 (${memories.length}条)\n\n${recent}` };
  }

  private addMemory(groupId: number | undefined, userId: number, content: string): PluginResult {
    const chatId = groupId ? `group:${groupId}` : `user:${userId}`;
    const id = this.storeMemory(chatId, content, 0.7, [], 'manual');
    return { handled: true, response: `已添加记忆: ${id}` };
  }

  private searchMemories(groupId: number | undefined, userId: number, query: string): PluginResult {
    const chatId = groupId ? `group:${groupId}` : `user:${userId}`;
    const results = this.retrieveMemories(chatId, query, 5);

    if (results.length === 0) {
      return { handled: true, response: `没找到关于「${query}」的记忆呢～` };
    }

    const formatted = results
      .map(m => {
        const date = new Date(m.createdAt).toLocaleDateString('zh-CN');
        return `• [${date}] ${m.content}`;
      })
      .join('\n');

    return { handled: true, response: `🔍 找到 ${results.length} 条相关记忆:\n\n${formatted}` };
  }

  private clearMemories(groupId: number | undefined, userId: number): PluginResult {
    const chatId = groupId ? `group:${groupId}` : `user:${userId}`;
    const count = this.memories.get(chatId)?.length || 0;
    this.memories.delete(chatId);
    return { handled: true, response: `已清除 ${count} 条记忆` };
  }

  private getStats(groupId: number | undefined): PluginResult {
    const totalChats = this.memories.size;
    let totalMemories = 0;
    let importantMemories = 0;

    for (const [, memories] of this.memories) {
      totalMemories += memories.length;
      importantMemories += memories.filter(m => m.importance > 0.7).length;
    }

    const globalCount = this.globalMemories.length;

    let response = `📊 记忆统计\n\n`;
    response += `• 会话数: ${totalChats}\n`;
    response += `• 总记忆数: ${totalMemories}\n`;
    response += `• 重要记忆: ${importantMemories}\n`;
    response += `• 全局记忆: ${globalCount}\n`;

    return { handled: true, response };
  }

  private shareMemory(ctx: PluginContext): PluginResult {
    const { text, groupId, userId } = ctx;
    
    const match = text.match(/\/memory\s+share\s+(.+)/i);
    if (!match) {
      return { handled: true, response: '用法: /memory share <记忆内容>\n将记忆共享到全局记忆库' };
    }

    const content = match[1].trim();
    const id = this.storeGlobalMemory(content, 0.8, [], `user:${userId}`);
    
    return { handled: true, response: `已将记忆共享到全局记忆库: ${id}` };
  }

  getRelevantContext(chatId: string, query: string, maxTokens: number = 500): string {
    const memories = this.retrieveMemories(chatId, query, 10);
    
    if (memories.length === 0) return '';

    let context = '';
    let currentLength = 0;

    for (const memory of memories) {
      const entry = `[${new Date(memory.createdAt).toLocaleDateString()}] ${memory.content}\n`;
      if (currentLength + entry.length > maxTokens) break;
      context += entry;
      currentLength += entry.length;
    }

    return context.trim();
  }

  private showHelp(): PluginResult {
    const help = `🧠 记忆功能帮助

/memory list - 查看记忆列表
/memory add <内容> - 添加记忆
/memory search <关键词> - 搜索记忆
/memory clear - 清除记忆
/memory stats - 查看统计
/memory share <内容> - 共享记忆到全局

记忆会自动保存和管理哦～`;
    
    return { handled: true, response: help };
  }

  exportMemories(chatId?: string): string {
    const data = chatId 
      ? this.memories.get(chatId) || []
      : Object.fromEntries(this.memories);
    return JSON.stringify(data, null, 2);
  }

  importMemories(chatId: string, data: string): number {
    try {
      const memories = JSON.parse(data) as Memory[];
      this.memories.set(chatId, memories);
      return memories.length;
    } catch {
      return 0;
    }
  }
}
