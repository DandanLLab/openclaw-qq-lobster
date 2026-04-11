import fs from "node:fs";
import path from "node:path";
import { getQQBotDataDir } from "./utils/platform.js";

export interface RefEntry {
  msgId: string;
  text: string;
  sender: string;
  senderId?: string;
  timestamp: number;
  accountId?: string;
}

let _storageDir: string | null = null;
let _refIndexFile: string | null = null;

function getStorageDir(): string {
  if (!_storageDir) _storageDir = getQQBotDataDir("data");
  return _storageDir;
}

function getRefIndexFile(): string {
  if (!_refIndexFile) _refIndexFile = path.join(getStorageDir(), "ref-index.jsonl");
  return _refIndexFile;
}

const MAX_ENTRIES = 50_000;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COMPACT_THRESHOLD_RATIO = 2;

interface RefIndexLine {
  k: string;
  v: RefEntry;
  t: number;
}

let cache: Map<string, RefEntry & { _createdAt: number }> | null = null;
let totalLinesOnDisk = 0;
let cacheReady = false;

function loadFromFile(): Map<string, RefEntry & { _createdAt: number }> {
  if (cacheReady && cache !== null) return cache;

  cache = new Map();
  totalLinesOnDisk = 0;

  try {
    if (!fs.existsSync(getRefIndexFile())) {
      cacheReady = true;
      return cache;
    }

    const raw = fs.readFileSync(getRefIndexFile(), "utf-8");
    const lines = raw.split("\n");
    const now = Date.now();
    let expired = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      totalLinesOnDisk++;
      try {
        const entry = JSON.parse(trimmed) as RefIndexLine;
        if (!entry.k || !entry.v || !entry.t) continue;
        if (now - entry.t > TTL_MS) { expired++; continue; }
        cache.set(entry.k, { ...entry.v, _createdAt: entry.t });
      } catch {}
    }

    console.log(
      `[ref-index-store] Loaded ${cache.size} entries from ${totalLinesOnDisk} lines (${expired} expired)`,
    );

    if (shouldCompact()) compactFile();
  } catch (err) {
    console.error(`[ref-index-store] Failed to load: ${err}`);
    cache = new Map();
  }

  cacheReady = true;
  return cache;
}

function appendLine(line: RefIndexLine): void {
  try {
    ensureDir();
    fs.appendFileSync(getRefIndexFile(), JSON.stringify(line) + "\n", "utf-8");
    totalLinesOnDisk++;
  } catch (err) {
    console.error(`[ref-index-store] Failed to append: ${err}`);
  }
}

function ensureDir(): void {
  if (!fs.existsSync(getStorageDir())) {
    fs.mkdirSync(getStorageDir(), { recursive: true });
  }
}

function shouldCompact(): boolean {
  if (!cache) return false;
  return totalLinesOnDisk > cache.size * COMPACT_THRESHOLD_RATIO && totalLinesOnDisk > 1000;
}

function compactFile(): void {
  if (!cache) return;
  const before = totalLinesOnDisk;
  try {
    ensureDir();
    const tmpPath = getRefIndexFile() + ".tmp";
    const lines: string[] = [];
    for (const [key, entry] of cache) {
      const line: RefIndexLine = {
        k: key,
        v: {
          msgId: entry.msgId,
          text: entry.text,
          sender: entry.sender,
          senderId: entry.senderId,
          timestamp: entry.timestamp,
          accountId: entry.accountId,
        },
        t: entry._createdAt,
      };
      lines.push(JSON.stringify(line));
    }
    fs.writeFileSync(tmpPath, lines.join("\n") + "\n", "utf-8");
    fs.renameSync(tmpPath, getRefIndexFile());
    totalLinesOnDisk = cache.size;
    console.log(`[ref-index-store] Compacted: ${before} lines → ${totalLinesOnDisk} lines`);
  } catch (err) {
    console.error(`[ref-index-store] Compact failed: ${err}`);
  }
}

function evictIfNeeded(): void {
  if (!cache || cache.size < MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry._createdAt > TTL_MS) cache.delete(key);
  }
  if (cache.size >= MAX_ENTRIES) {
    const sorted = [...cache.entries()].sort((a, b) => a[1]._createdAt - b[1]._createdAt);
    const toRemove = sorted.slice(0, cache.size - MAX_ENTRIES + 1000);
    for (const [key] of toRemove) cache.delete(key);
    console.log(`[ref-index-store] Evicted ${toRemove.length} oldest entries`);
  }
}

export function initRefIndexStore(): void {
  loadFromFile();
}

export function recordRef(entry: RefEntry): void {
  const store = loadFromFile();
  try {
    evictIfNeeded();
  } catch (e) {
    console.error(`[ref-index-store] Eviction failed: ${e}`);
  }

  const now = Date.now();
  const key = entry.accountId ? `${entry.accountId}:${entry.msgId}` : entry.msgId;
  store.set(key, { ...entry, _createdAt: now });

  appendLine({ k: key, v: entry, t: now });

  if (shouldCompact()) compactFile();
}

export function lookupRef(msgId: string, accountId?: string): RefEntry | null {
  const store = loadFromFile();
  const scopedKey = accountId ? `${accountId}:${msgId}` : null;
  const entry = (scopedKey ? store.get(scopedKey) : null) ?? store.get(msgId);
  if (!entry) return null;
  const resolvedKey = (scopedKey && store.has(scopedKey)) ? scopedKey : msgId;
  if (Date.now() - entry._createdAt > TTL_MS) {
    store.delete(resolvedKey);
    return null;
  }
  return {
    msgId: entry.msgId,
    text: entry.text,
    sender: entry.sender,
    senderId: entry.senderId,
    timestamp: entry.timestamp,
    accountId: entry.accountId,
  };
}

export function flushRefIndex(): void {
  if (cache && shouldCompact()) compactFile();
}

export function getRefIndexStats(): {
  size: number;
  maxEntries: number;
  totalLinesOnDisk: number;
  filePath: string;
} {
  const store = loadFromFile();
  return { size: store.size, maxEntries: MAX_ENTRIES, totalLinesOnDisk, filePath: getRefIndexFile() };
}
