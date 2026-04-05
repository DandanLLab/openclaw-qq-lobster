import type { MessageInfo } from "../config.js";
import {
  callWithModelRotation,
  getModelTaskConfig,
  getProviders,
  type ModelCallOptions,
} from "../modelCaller.js";

interface MemoryRecord {
  id: string;
  content: string;
  summary: string;
  keywords: string[];
  timestamp: number;
  chatId: string;
  userId?: string;
  userName?: string;
  importance: number;
  accessCount: number;
  lastAccessTime: number;
}

interface RetrievalResult {
  success: boolean;
  memories: MemoryRecord[];
  context?: string;
}

const MEMORY_SUMMARY_PROMPT = `请对以下聊天内容进行概括，提取关键信息。

聊天内容：
{chat_content}

请输出：
1. 一句话概括
2. 关键词（用逗号分隔）
3. 重要程度（1-10分）

格式：
概括：[一句话概括]
关键词：[关键词1, 关键词2, ...]
重要程度：[数字]`;

const MEMORY_RETRIEVAL_PROMPT = `你是一个记忆检索助手。请根据用户的问题，从以下记忆记录中找出最相关的内容。

记忆记录：
{memory_records}

用户问题：{question}

请分析以上记忆记录，找出与问题最相关的内容，并给出简洁的回答。如果没有相关记忆，请回答"未找到相关记忆"。`;

export class MemoryRetrieval {
  private chatId: string;
  private config: any;
  private memoryStore: Map<string, MemoryRecord> = new Map();
  private embeddingCache: Map<string, number[]> = new Map();
  private maxMemories: number = 1000;

  constructor(chatId: string, config?: any) {
    this.chatId = chatId;
    this.config = config || {};
    this.maxMemories = config?.memory?.maxMemories || 1000;
  }

  async buildMemoryInfo(target: string): Promise<string> {
    const result = await this.retrieveMemories(target, 5);

    if (!result.success || result.memories.length === 0) {
      return "";
    }

    const memoryLines = result.memories.map(m =>
      `- [${new Date(m.timestamp).toLocaleDateString()}] ${m.summary || m.content}`
    );

    return `相关的历史记忆：\n${memoryLines.join("\n")}`;
  }

  async retrieveMemories(query: string, topK: number = 5): Promise<RetrievalResult> {
    const allMemories = Array.from(this.memoryStore.values());

    if (allMemories.length === 0) {
      return { success: true, memories: [] };
    }

    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 1);

    const scored = allMemories.map(memory => {
      let score = 0;

      for (const keyword of memory.keywords) {
        if (queryLower.includes(keyword.toLowerCase())) {
          score += 3;
        }
      }

      for (const word of queryWords) {
        if (memory.content.toLowerCase().includes(word)) {
          score += 1;
        }
        if (memory.summary && memory.summary.toLowerCase().includes(word)) {
          score += 2;
        }
      }

      score += memory.importance * 0.1;

      const ageHours = (Date.now() - memory.timestamp) / (1000 * 60 * 60);
      score *= Math.exp(-ageHours / 168);

      return { memory, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const topMemories = scored.slice(0, topK).map(s => s.memory);

    for (const memory of topMemories) {
      memory.accessCount++;
      memory.lastAccessTime = Date.now();
    }

    return {
      success: true,
      memories: topMemories,
      context: topMemories.map(m => m.summary || m.content).join("\n"),
    };
  }

  async addMemory(
    content: string,
    userId?: string,
    userName?: string
  ): Promise<MemoryRecord | null> {
    if (!content || content.trim().length === 0) {
      return null;
    }

    const summaryResult = await this.summarizeContent(content);

    const id = `${this.chatId}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;

    const record: MemoryRecord = {
      id,
      content,
      summary: summaryResult.summary,
      keywords: summaryResult.keywords,
      timestamp: Date.now(),
      chatId: this.chatId,
      userId,
      userName,
      importance: summaryResult.importance,
      accessCount: 0,
      lastAccessTime: Date.now(),
    };

    this.memoryStore.set(id, record);

    if (this.memoryStore.size > this.maxMemories) {
      this.pruneMemories();
    }

    console.log(`[MemoryRetrieval] 添加记忆: ${record.summary || content.substring(0, 30)}...`);

    return record;
  }

  private async summarizeContent(content: string): Promise<{
    summary: string;
    keywords: string[];
    importance: number;
  }> {
    const prompt = MEMORY_SUMMARY_PROMPT.replace("{chat_content}", content);

    const result = await this.callLLM(prompt, "toolUse", 0.3);

    if (!result.success || !result.content) {
      return {
        summary: content.substring(0, 100),
        keywords: [],
        importance: 5,
      };
    }

    const summaryMatch = result.content.match(/概括[：:]\s*(.+)/);
    const keywordsMatch = result.content.match(/关键词[：:]\s*(.+)/);
    const importanceMatch = result.content.match(/重要程度[：:]\s*(\d+)/);

    return {
      summary: summaryMatch ? summaryMatch[1].trim() : content.substring(0, 100),
      keywords: keywordsMatch
        ? keywordsMatch[1].split(/[,，]/).map(k => k.trim()).filter(k => k)
        : [],
      importance: importanceMatch ? parseInt(importanceMatch[1]) : 5,
    };
  }

  private pruneMemories(): void {
    const allMemories = Array.from(this.memoryStore.values());

    allMemories.sort((a, b) => {
      const scoreA = a.importance * 0.3 + a.accessCount * 0.5 - (Date.now() - a.timestamp) / 1000000;
      const scoreB = b.importance * 0.3 + b.accessCount * 0.5 - (Date.now() - b.timestamp) / 1000000;
      return scoreB - scoreA;
    });

    const toKeep = allMemories.slice(0, Math.floor(this.maxMemories * 0.8));

    this.memoryStore.clear();
    for (const memory of toKeep) {
      this.memoryStore.set(memory.id, memory);
    }

    console.log(`[MemoryRetrieval] 清理记忆，保留 ${toKeep.length} 条`);
  }

  async deleteMemory(id: string): Promise<boolean> {
    return this.memoryStore.delete(id);
  }

  async answerQuestion(question: string): Promise<string> {
    const result = await this.retrieveMemories(question, 10);

    if (!result.success || result.memories.length === 0) {
      return "";
    }

    const memoryRecords = result.memories
      .map(m => `[${new Date(m.timestamp).toLocaleDateString()}] ${m.summary || m.content}`)
      .join("\n");

    const prompt = MEMORY_RETRIEVAL_PROMPT
      .replace("{memory_records}", memoryRecords)
      .replace("{question}", question);

    const llmResult = await this.callLLM(prompt, "toolUse", 0.3);

    return llmResult.content || "";
  }

  private async callLLM(
    prompt: string,
    taskName: string,
    temperature: number = 0.3
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
      const providers = getProviders(this.config);
      const taskConfig = getModelTaskConfig(this.config, taskName);

      if (!taskConfig || !taskConfig.models?.length) {
        return { success: false, error: `未配置${taskName}模型任务` };
      }

      const options: ModelCallOptions = {
        messages: [{ role: "user", content: prompt }],
        maxTokens: 512,
        temperature,
        timeout: 30000,
      };

      const result = await callWithModelRotation(providers, taskConfig, options);

      return {
        success: result.success,
        content: result.content,
        error: result.error,
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  getStats(): { total: number; max: number } {
    return {
      total: this.memoryStore.size,
      max: this.maxMemories,
    };
  }

  getAllMemories(): MemoryRecord[] {
    return Array.from(this.memoryStore.values());
  }
}

export class MemoryManager {
  private retrievals: Map<string, MemoryRetrieval> = new Map();
  private config: any;

  constructor(config?: any) {
    this.config = config;
  }

  getRetrieval(chatId: string): MemoryRetrieval {
    if (!this.retrievals.has(chatId)) {
      this.retrievals.set(chatId, new MemoryRetrieval(chatId, this.config));
    }
    return this.retrievals.get(chatId)!;
  }
}
