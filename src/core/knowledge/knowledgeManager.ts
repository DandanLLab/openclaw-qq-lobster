import type { MessageInfo } from "../config.js";
import {
  callWithModelRotation,
  getModelTaskConfig,
  getProviders,
  type ModelCallOptions,
} from "../modelCaller.js";

interface KnowledgeRecord {
  id: string;
  theme: string;
  summary: string;
  keywords: string[];
  keyPoints: string[];
  participants: string[];
  startTime: number;
  endTime: number;
  createTime: number;
  chatId: string;
}

interface TripleData {
  subject: string;
  relation: string;
  object: string;
}

const QA_PROMPT_TEMPLATE = `你是一个知识检索助手。请根据以下问题，从给定的知识库中找出最相关的信息。

知识库内容：
{knowledge_content}

用户问题：{question}

请分析以上知识库内容，找出与问题最相关的信息，并给出简洁的回答。如果知识库中没有相关信息，请回答"未找到相关信息"。`;

const IE_PROMPT_TEMPLATE = `请从以下文本中提取实体关系三元组。

文本内容：
{text}

请提取其中的实体和关系，输出为JSON数组格式：
[
  {{"subject": "实体1", "relation": "关系", "object": "实体2"}}
]

只输出JSON数组，不要有其他内容。`;

export class KnowledgeManager {
  private chatId: string;
  private config: any;
  private knowledgeStore: Map<string, KnowledgeRecord> = new Map();
  private embeddingStore: Map<string, number[]> = new Map();

  constructor(chatId: string, config?: any) {
    this.chatId = chatId;
    this.config = config || {};
  }

  async buildKnowledgeInfo(target: string): Promise<string> {
    const relevantKnowledge = await this.searchKnowledge(target);

    if (relevantKnowledge.length === 0) {
      return "";
    }

    const knowledgeLines = relevantKnowledge.map(k =>
      `- 主题: ${k.theme}\n  概要: ${k.summary}\n  关键词: ${k.keywords.join(", ")}`
    );

    return `相关的知识库信息：\n${knowledgeLines.join("\n\n")}`;
  }

  async searchKnowledge(query: string, topK: number = 3): Promise<KnowledgeRecord[]> {
    const allRecords = Array.from(this.knowledgeStore.values());

    if (allRecords.length === 0) {
      return [];
    }

    const scored = allRecords.map(record => {
      const score = this.calculateRelevanceScore(query, record);
      return { record, score };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, topK).map(s => s.record);
  }

  private calculateRelevanceScore(query: string, record: KnowledgeRecord): number {
    const queryLower = query.toLowerCase();
    let score = 0;

    for (const keyword of record.keywords) {
      if (queryLower.includes(keyword.toLowerCase())) {
        score += 2;
      }
    }

    if (record.theme && queryLower.includes(record.theme.toLowerCase())) {
      score += 3;
    }

    if (record.summary) {
      const summaryLower = record.summary.toLowerCase();
      const queryWords = queryLower.split(/\s+/);
      for (const word of queryWords) {
        if (word.length > 1 && summaryLower.includes(word)) {
          score += 1;
        }
      }
    }

    return score;
  }

  async createKnowledgeRecord(
    theme: string,
    summary: string,
    keywords: string[],
    keyPoints: string[],
    participants: string[],
    startTime: number,
    endTime: number
  ): Promise<KnowledgeRecord | null> {
    if (!theme || !summary) {
      return null;
    }

    const id = `${this.chatId}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;

    const record: KnowledgeRecord = {
      id,
      theme,
      summary,
      keywords: keywords || [],
      keyPoints: keyPoints || [],
      participants: participants || [],
      startTime,
      endTime,
      createTime: Date.now(),
      chatId: this.chatId,
    };

    this.knowledgeStore.set(id, record);

    console.log(`[KnowledgeManager] 创建知识记录: ${theme}`);

    return record;
  }

  async updateKnowledgeRecord(
    id: string,
    updates: Partial<KnowledgeRecord>
  ): Promise<boolean> {
    const record = this.knowledgeStore.get(id);

    if (!record) {
      return false;
    }

    Object.assign(record, updates);

    console.log(`[KnowledgeManager] 更新知识记录: ${record.theme}`);

    return true;
  }

  async deleteKnowledgeRecord(id: string): Promise<boolean> {
    const deleted = this.knowledgeStore.delete(id);

    if (deleted) {
      console.log(`[KnowledgeManager] 删除知识记录: ${id}`);
    }

    return deleted;
  }

  async extractTriples(text: string): Promise<TripleData[]> {
    const prompt = IE_PROMPT_TEMPLATE.replace("{text}", text);

    const result = await this.callLLM(prompt, 0.1);

    if (!result.success || !result.content) {
      return [];
    }

    try {
      const jsonMatch = result.content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]);

      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.filter(item =>
        item.subject && item.relation && item.object
      ) as TripleData[];
    } catch {
      return [];
    }
  }

  async answerQuestion(question: string): Promise<string> {
    const relevantKnowledge = await this.searchKnowledge(question, 5);

    if (relevantKnowledge.length === 0) {
      return "";
    }

    const knowledgeContent = relevantKnowledge.map(k =>
      `主题: ${k.theme}\n内容: ${k.summary}\n关键点: ${k.keyPoints.join("; ")}`
    ).join("\n\n");

    const prompt = QA_PROMPT_TEMPLATE
      .replace("{knowledge_content}", knowledgeContent)
      .replace("{question}", question);

    const result = await this.callLLM(prompt, 0.3);

    if (!result.success || !result.content) {
      return "";
    }

    return result.content;
  }

  private async callLLM(prompt: string, temperature: number = 0.3): Promise<{
    success: boolean;
    content?: string;
    error?: string;
  }> {
    try {
      const providers = getProviders(this.config);
      const taskConfig = getModelTaskConfig(this.config, "toolUse");

      if (!taskConfig || !taskConfig.models?.length) {
        return { success: false, error: "未配置toolUse模型任务" };
      }

      const options: ModelCallOptions = {
        messages: [{ role: "user", content: prompt }],
        maxTokens: 1024,
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

  getStats(): { totalRecords: number } {
    return {
      totalRecords: this.knowledgeStore.size,
    };
  }

  getAllRecords(): KnowledgeRecord[] {
    return Array.from(this.knowledgeStore.values());
  }
}

export class KnowledgeManagerFactory {
  private managers: Map<string, KnowledgeManager> = new Map();
  private config: any;

  constructor(config?: any) {
    this.config = config;
  }

  getManager(chatId: string): KnowledgeManager {
    if (!this.managers.has(chatId)) {
      this.managers.set(chatId, new KnowledgeManager(chatId, this.config));
    }
    return this.managers.get(chatId)!;
  }
}
