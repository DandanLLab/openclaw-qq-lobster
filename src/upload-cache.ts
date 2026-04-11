const DEFAULT_TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
  fileId: string;
  expiresAt: number;
}

export class UploadCache {
  private readonly cache = new Map<string, CacheEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly defaultTtlMs = DEFAULT_TTL_MS) {
    this.cleanupTimer = setInterval(() => this.cleanup(), 10 * 60 * 1000);
  }

  buildKey(accountId: string, filePath: string): string {
    return `${accountId}:${filePath}`;
  }

  get(key: string): string | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.fileId;
  }

  set(key: string, fileId: string, ttlMs = this.defaultTtlMs): void {
    this.cache.set(key, { fileId, expiresAt: Date.now() + ttlMs });
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) this.cache.delete(key);
    }
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
