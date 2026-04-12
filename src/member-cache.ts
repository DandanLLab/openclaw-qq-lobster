import type { OneBotClient } from "./client.js";

interface CachedMemberInfo {
  name: string;
  card?: string;
  nickname?: string;
  role?: string;
  time: number;
}

interface CachedGroupInfo {
  groupName: string;
  memberCount: number;
  maxMemberCount: number;
  time: number;
}

const memberCache = new Map<string, CachedMemberInfo>();
const groupCache = new Map<string, CachedGroupInfo>();
const bulkCachedGroups = new Set<string>();
const loadingGroups = new Set<string>();
const loadingGroupInfo = new Set<string>();

export function getCachedMemberName(groupId: string, userId: string): string | null {
  const key = `${groupId}:${userId}`;
  const cached = memberCache.get(key);
  if (cached && Date.now() - cached.time < 3_600_000) {
    return cached.name;
  }
  return null;
}

export function getCachedMemberInfo(groupId: string, userId: string): CachedMemberInfo | null {
  const key = `${groupId}:${userId}`;
  const cached = memberCache.get(key);
  if (cached && Date.now() - cached.time < 3_600_000) {
    return cached;
  }
  return null;
}

export function setCachedMemberName(groupId: string, userId: string, name: string): void {
  memberCache.set(`${groupId}:${userId}`, { name, time: Date.now() });
}

export function setCachedMemberInfo(groupId: string, userId: string, info: Partial<CachedMemberInfo>): void {
  const key = `${groupId}:${userId}`;
  const existing = memberCache.get(key) || { name: '', time: 0 };
  memberCache.set(key, { ...existing, ...info, time: Date.now() });
}

export function getCachedGroupInfo(groupId: string): CachedGroupInfo | null {
  const cached = groupCache.get(groupId);
  if (cached && Date.now() - cached.time < 3_600_000) {
    return cached;
  }
  return null;
}

export function setCachedGroupInfo(groupId: string, info: Partial<CachedGroupInfo>): void {
  const existing = groupCache.get(groupId) || { groupName: '', memberCount: 0, maxMemberCount: 0, time: 0 };
  groupCache.set(groupId, { ...existing, ...info, time: Date.now() });
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
        setCachedMemberInfo(key, String(m.user_id), {
          name,
          card: m.card,
          nickname: m.nickname,
          role: m.role
        });
      }
      bulkCachedGroups.add(key);
    }
  } catch {
  } finally {
    loadingGroups.delete(key);
  }
}

export async function populateGroupInfoCache(client: OneBotClient, groupId: number): Promise<void> {
  const key = String(groupId);
  if (loadingGroupInfo.has(key)) {
    let waited = 0;
    while (loadingGroupInfo.has(key) && waited < 100) {
      await new Promise((r) => setTimeout(r, 20));
      waited++;
    }
    return;
  }
  
  const cached = getCachedGroupInfo(key);
  if (cached && cached.groupName) return;
  
  loadingGroupInfo.add(key);
  try {
    const result = await client.sendApiWithResponse("get_group_info", { group_id: groupId });
    const info = result?.data || result;
    if (info) {
      setCachedGroupInfo(key, {
        groupName: info.group_name || '',
        memberCount: info.member_count || 0,
        maxMemberCount: info.max_member_count || 0
      });
    }
  } catch {
  } finally {
    loadingGroupInfo.delete(key);
  }
}

export function clearMemberCache(): void {
  memberCache.clear();
  bulkCachedGroups.clear();
}

export function clearGroupCache(): void {
  groupCache.clear();
}

export function clearAllCache(): void {
  memberCache.clear();
  groupCache.clear();
  bulkCachedGroups.clear();
}
