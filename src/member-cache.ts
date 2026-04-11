import type { OneBotClient } from "./client.js";

const memberCache = new Map<string, { name: string; time: number }>();
const bulkCachedGroups = new Set<string>();
const loadingGroups = new Set<string>();

export function getCachedMemberName(groupId: string, userId: string): string | null {
  const key = `${groupId}:${userId}`;
  const cached = memberCache.get(key);
  if (cached && Date.now() - cached.time < 3_600_000) {
    return cached.name;
  }
  return null;
}

export function setCachedMemberName(groupId: string, userId: string, name: string): void {
  memberCache.set(`${groupId}:${userId}`, { name, time: Date.now() });
}

export async function populateGroupMemberCache(client: OneBotClient, groupId: number): Promise<void> {
  const key = String(groupId);
  if (bulkCachedGroups.has(key)) return;
  if (loadingGroups.has(key)) {
    let waited = 0;
    while (loadingGroups.has(key) && waited < 250) {
      await new Promise((r) => setTimeout(r, 20));
      waited++;
    }
    return;
  }
  loadingGroups.add(key);
  try {
    const members = await client.getGroupMemberList(groupId);
    if (Array.isArray(members)) {
      for (const m of members) {
        const name = m.card || m.nickname || String(m.user_id);
        setCachedMemberName(key, String(m.user_id), name);
      }
      bulkCachedGroups.add(key);
    }
  } catch {
  } finally {
    loadingGroups.delete(key);
  }
}

export function clearMemberCache(): void {
  memberCache.clear();
  bulkCachedGroups.clear();
}
