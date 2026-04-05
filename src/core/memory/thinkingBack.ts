interface ThinkingBackRecord {
  id: string;
  chatId: string;
  question: string;
  context: string;
  foundAnswer: boolean;
  answer: string;
  thinkingSteps: Record<string, unknown>[];
  createTime: number;
  updateTime: number;
}

export class ThinkingBackStore {
  private store: Map<string, ThinkingBackRecord> = new Map();
  private chatIndex: Map<string, Set<string>> = new Map();

  private generateId(): string {
    return `tb_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  storeRecord(
    chatId: string,
    question: string,
    context: string,
    foundAnswer: boolean,
    answer: string,
    thinkingSteps: Record<string, unknown>[]
  ): ThinkingBackRecord {
    const now = Date.now();
    const id = this.generateId();

    const record: ThinkingBackRecord = {
      id,
      chatId,
      question,
      context,
      foundAnswer,
      answer,
      thinkingSteps,
      createTime: now,
      updateTime: now,
    };

    this.store.set(id, record);

    if (!this.chatIndex.has(chatId)) {
      this.chatIndex.set(chatId, new Set());
    }
    this.chatIndex.get(chatId)!.add(id);

    return record;
  }

  getRecord(id: string): ThinkingBackRecord | undefined {
    return this.store.get(id);
  }

  getRecordsByChat(chatId: string): ThinkingBackRecord[] {
    const ids = this.chatIndex.get(chatId);
    if (!ids) return [];

    const results: ThinkingBackRecord[] = [];
    for (const id of ids) {
      const record = this.store.get(id);
      if (record) {
        results.push(record);
      }
    }

    return results.sort((a, b) => b.updateTime - a.updateTime);
  }

  getRecentFoundAnswers(chatId: string, timeWindowSeconds: number = 600): ThinkingBackRecord[] {
    const now = Date.now();
    const threshold = now - timeWindowSeconds * 1000;

    const records = this.getRecordsByChat(chatId);
    return records.filter(r => 
      r.foundAnswer && 
      r.answer && 
      r.updateTime >= threshold
    ).slice(0, 5);
  }

  updateRecord(id: string, updates: Partial<ThinkingBackRecord>): boolean {
    const record = this.store.get(id);
    if (!record) return false;

    Object.assign(record, updates, { updateTime: Date.now() });
    return true;
  }

  deleteRecord(id: string): boolean {
    const record = this.store.get(id);
    if (!record) return false;

    this.chatIndex.get(record.chatId)?.delete(id);
    return this.store.delete(id);
  }

  cleanupStaleRecords(maxAgeSeconds: number = 36000): number {
    const now = Date.now();
    const threshold = now - maxAgeSeconds * 1000;
    let deleted = 0;

    for (const [id, record] of this.store) {
      if (!record.foundAnswer && record.updateTime < threshold) {
        this.chatIndex.get(record.chatId)?.delete(id);
        this.store.delete(id);
        deleted++;
      }
    }

    return deleted;
  }

  getStats(): { totalRecords: number; foundAnswers: number } {
    let foundCount = 0;
    for (const record of this.store.values()) {
      if (record.foundAnswer) foundCount++;
    }
    return {
      totalRecords: this.store.size,
      foundAnswers: foundCount,
    };
  }
}

let thinkingBackStoreInstance: ThinkingBackStore | null = null;

export function getThinkingBackStore(): ThinkingBackStore {
  if (!thinkingBackStoreInstance) {
    thinkingBackStoreInstance = new ThinkingBackStore();
  }
  return thinkingBackStoreInstance;
}
