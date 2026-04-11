import fs from "node:fs";
import path from "node:path";
import { getQQBotDataDir } from "./utils/platform.js";

let _KNOWN_USERS_DIR: string | null = null;
let _KNOWN_USERS_FILE: string | null = null;

function getKnownUsersFile(): string {
  if (!_KNOWN_USERS_FILE) {
    _KNOWN_USERS_DIR = getQQBotDataDir("data");
    _KNOWN_USERS_FILE = path.join(_KNOWN_USERS_DIR, "known-users.json");
  }
  return _KNOWN_USERS_FILE;
}

function getKnownUsersDir(): string {
  getKnownUsersFile();
  return _KNOWN_USERS_DIR!;
}

export interface KnownUser {
  openid: string;
  type: "private" | "group" | "guild";
  nickname?: string;
  groupId?: number;
  accountId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  interactionCount: number;
}

let usersCache: Map<string, KnownUser> | null = null;

const SAVE_THROTTLE_MS = 5000;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let isDirty = false;

function ensureDir(): void {
  const dir = getKnownUsersDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadUsersFromFile(): Map<string, KnownUser> {
  if (usersCache !== null) {
    return usersCache;
  }

  usersCache = new Map();

  try {
    const file = getKnownUsersFile();
    if (fs.existsSync(file)) {
      const data = fs.readFileSync(file, "utf-8");
      const users = JSON.parse(data) as KnownUser[];

      for (const user of users) {
        const key = makeUserKey(user);
        usersCache.set(key, user);
      }

      console.log(`[known-users] Loaded ${usersCache.size} users`);
    }
  } catch (err) {
    console.error(`[known-users] Failed to load users: ${err}`);
    usersCache = new Map();
  }

  return usersCache;
}

function saveUsersToFile(): void {
  if (!isDirty) return;

  if (saveTimer) {
    return;
  }

  saveTimer = setTimeout(() => {
    saveTimer = null;
    doSaveUsersToFile();
  }, SAVE_THROTTLE_MS);
}

function doSaveUsersToFile(): void {
  if (!usersCache || !isDirty) return;

  try {
    ensureDir();
    const users = Array.from(usersCache.values());
    fs.writeFileSync(getKnownUsersFile(), JSON.stringify(users, null, 2), "utf-8");
    isDirty = false;
  } catch (err) {
    console.error(`[known-users] Failed to save users: ${err}`);
  }
}

export function flushKnownUsers(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  doSaveUsersToFile();
}

function makeUserKey(user: Partial<KnownUser>): string {
  const base = `${user.accountId}:${user.type}:${user.openid}`;
  if (user.type === "group" && user.groupId) {
    return `${base}:${user.groupId}`;
  }
  return base;
}

export function recordKnownUser(user: {
  openid: string;
  type: "private" | "group" | "guild";
  nickname?: string;
  groupId?: number;
  accountId: string;
}): void {
  const cache = loadUsersFromFile();
  const key = makeUserKey(user);
  const now = Date.now();

  const existing = cache.get(key);

  if (existing) {
    existing.lastSeenAt = now;
    existing.interactionCount++;
    if (user.nickname && user.nickname !== existing.nickname) {
      existing.nickname = user.nickname;
    }
  } else {
    const newUser: KnownUser = {
      openid: user.openid,
      type: user.type,
      nickname: user.nickname,
      groupId: user.groupId,
      accountId: user.accountId,
      firstSeenAt: now,
      lastSeenAt: now,
      interactionCount: 1,
    };
    cache.set(key, newUser);
    console.log(`[known-users] New user: ${user.openid} (${user.type})`);
  }

  isDirty = true;
  saveUsersToFile();
}

export function getKnownUser(
  accountId: string,
  openid: string,
  type: "private" | "group" | "guild" = "private",
  groupId?: number
): KnownUser | undefined {
  const cache = loadUsersFromFile();
  const key = makeUserKey({ accountId, openid, type, groupId });
  return cache.get(key);
}

export function listKnownUsers(options?: {
  accountId?: string;
  type?: "private" | "group" | "guild";
  activeWithin?: number;
  limit?: number;
  sortBy?: "lastSeenAt" | "firstSeenAt" | "interactionCount";
  sortOrder?: "asc" | "desc";
}): KnownUser[] {
  const cache = loadUsersFromFile();
  let users = Array.from(cache.values());

  if (options?.accountId) {
    users = users.filter(u => u.accountId === options.accountId);
  }
  if (options?.type) {
    users = users.filter(u => u.type === options.type);
  }
  if (options?.activeWithin) {
    const cutoff = Date.now() - options.activeWithin;
    users = users.filter(u => u.lastSeenAt >= cutoff);
  }

  const sortBy = options?.sortBy ?? "lastSeenAt";
  const sortOrder = options?.sortOrder ?? "desc";
  users.sort((a, b) => {
    const aVal = a[sortBy] ?? 0;
    const bVal = b[sortBy] ?? 0;
    return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
  });

  if (options?.limit && options.limit > 0) {
    users = users.slice(0, options.limit);
  }

  return users;
}

export function getKnownUsersStats(accountId?: string): {
  totalUsers: number;
  privateUsers: number;
  groupUsers: number;
  guildUsers: number;
  activeIn24h: number;
  activeIn7d: number;
} {
  const users = listKnownUsers({ accountId });

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  return {
    totalUsers: users.length,
    privateUsers: users.filter(u => u.type === "private").length,
    groupUsers: users.filter(u => u.type === "group").length,
    guildUsers: users.filter(u => u.type === "guild").length,
    activeIn24h: users.filter(u => now - u.lastSeenAt < day).length,
    activeIn7d: users.filter(u => now - u.lastSeenAt < 7 * day).length,
  };
}

export function removeKnownUser(
  accountId: string,
  openid: string,
  type: "private" | "group" | "guild" = "private",
  groupId?: number
): boolean {
  const cache = loadUsersFromFile();
  const key = makeUserKey({ accountId, openid, type, groupId });

  if (cache.has(key)) {
    cache.delete(key);
    isDirty = true;
    saveUsersToFile();
    console.log(`[known-users] Removed user ${openid}`);
    return true;
  }

  return false;
}

export function clearKnownUsers(accountId?: string): number {
  const cache = loadUsersFromFile();
  let count = 0;

  if (accountId) {
    for (const [key, user] of cache.entries()) {
      if (user.accountId === accountId) {
        cache.delete(key);
        count++;
      }
    }
  } else {
    count = cache.size;
    cache.clear();
  }

  if (count > 0) {
    isDirty = true;
    doSaveUsersToFile();
    console.log(`[known-users] Cleared ${count} users`);
  }

  return count;
}

export function getGroupMembers(accountId: string, groupId: number): KnownUser[] {
  return listKnownUsers({ accountId, type: "group" })
    .filter(u => u.groupId === groupId);
}
