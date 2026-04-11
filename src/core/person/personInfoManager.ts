interface PersonInfo {
  userId: number;
  userName: string;
  nickname?: string;
  groupId?: number;
  groupName?: string;
  relationship: string;
  traits: string[];
  interests: string[];
  lastInteraction: number;
  interactionCount: number;
  notes: string[];
  intimacyLevel: number;
  intimacyUpdatedAt: number;
  consecutiveDays: number;
  lastInteractionDate: string;
}

interface PersonInfoUpdate {
  userId: number;
  userName?: string;
  nickname?: string;
  groupId?: number;
  groupName?: string;
  relationship?: string;
  trait?: string;
  interest?: string;
  note?: string;
}

export class PersonInfoManager {
  private personStore: Map<string, PersonInfo> = new Map();
  private groupPersonIndex: Map<number, Set<string>> = new Map();
  private intimacyDecayTimer: NodeJS.Timeout | null = null;
  private readonly INTIMACY_MAX = 100;
  private readonly INTIMACY_MIN = 0;
  private readonly INTIMACY_INCREASE_BASE = 2;
  private readonly INTIMACY_DECAY_RATE = 5;
  private readonly DECAY_CHECK_INTERVAL = 3600000;
  private readonly DECAY_THRESHOLD = 86400000;

  private getKey(userId: number, groupId?: number): string {
    return groupId ? `${userId}:${groupId}` : `${userId}:private`;
  }

  startIntimacyDecayTimer(): void {
    if (this.intimacyDecayTimer) return;
    
    this.intimacyDecayTimer = setInterval(() => {
      this.decayInactiveUsers();
    }, this.DECAY_CHECK_INTERVAL);
    
    console.log('[PersonInfoManager] 亲密度衰减定时器已启动');
  }

  stopIntimacyDecayTimer(): void {
    if (this.intimacyDecayTimer) {
      clearInterval(this.intimacyDecayTimer);
      this.intimacyDecayTimer = null;
      console.log('[PersonInfoManager] 亲密度衰减定时器已停止');
    }
  }

  private decayInactiveUsers(): void {
    const now = Date.now();
    let decayedCount = 0;
    
    for (const person of this.personStore.values()) {
      const timeSinceLastInteraction = now - person.lastInteraction;
      
      if (timeSinceLastInteraction > this.DECAY_THRESHOLD && person.intimacyLevel > this.INTIMACY_MIN) {
        const daysInactive = Math.floor(timeSinceLastInteraction / this.DECAY_THRESHOLD);
        const decayAmount = Math.min(
          daysInactive * this.INTIMACY_DECAY_RATE,
          person.intimacyLevel
        );
        
        person.intimacyLevel = Math.max(this.INTIMACY_MIN, person.intimacyLevel - decayAmount);
        person.intimacyUpdatedAt = now;
        decayedCount++;
        
        console.log(`[PersonInfoManager] 用户 ${person.userId} 亲密度衰减: -${decayAmount}, 当前: ${person.intimacyLevel}`);
      }
    }
    
    if (decayedCount > 0) {
      console.log(`[PersonInfoManager] 本次衰减影响了 ${decayedCount} 个用户`);
    }
  }

  private increaseIntimacy(person: PersonInfo): void {
    const now = Date.now();
    const today = new Date().toISOString().split('T')[0];
    
    if (person.lastInteractionDate !== today) {
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      if (person.lastInteractionDate === yesterday) {
        person.consecutiveDays++;
        console.log(`[PersonInfoManager] 用户 ${person.userId} 连续互动天数: ${person.consecutiveDays}`);
      } else {
        person.consecutiveDays = 1;
      }
      person.lastInteractionDate = today;
    }
    
    const consecutiveBonus = Math.min(person.consecutiveDays * 0.5, 5);
    const interactionBonus = Math.min(person.interactionCount * 0.1, 3);
    const totalIncrease = this.INTIMACY_INCREASE_BASE + consecutiveBonus + interactionBonus;
    
    const oldLevel = person.intimacyLevel;
    person.intimacyLevel = Math.min(this.INTIMACY_MAX, person.intimacyLevel + totalIncrease);
    person.intimacyUpdatedAt = now;
    
    if (person.intimacyLevel > oldLevel) {
      console.log(`[PersonInfoManager] 用户 ${person.userId} 亲密度上升: +${(person.intimacyLevel - oldLevel).toFixed(1)}, 当前: ${person.intimacyLevel.toFixed(1)}`);
    }
  }

  getIntimacyLevel(userId: number, groupId?: number): number {
    const person = this.getPersonInfo(userId, groupId);
    return person?.intimacyLevel ?? this.INTIMACY_MIN;
  }

  getIntimacyDescription(userId: number, groupId?: number): string {
    const level = this.getIntimacyLevel(userId, groupId);
    
    if (level >= 90) return "灵魂伴侣";
    if (level >= 75) return "挚友";
    if (level >= 60) return "好友";
    if (level >= 45) return "朋友";
    if (level >= 30) return "熟人";
    if (level >= 15) return "点头之交";
    return "陌生人";
  }

  getIntimacyStats(): {
    totalUsers: number;
    avgIntimacy: number;
    highIntimacyUsers: number;
    lowIntimacyUsers: number;
  } {
    const users = Array.from(this.personStore.values());
    if (users.length === 0) {
      return { totalUsers: 0, avgIntimacy: 0, highIntimacyUsers: 0, lowIntimacyUsers: 0 };
    }
    
    const totalIntimacy = users.reduce((sum, p) => sum + p.intimacyLevel, 0);
    const avgIntimacy = totalIntimacy / users.length;
    const highIntimacyUsers = users.filter(p => p.intimacyLevel >= 60).length;
    const lowIntimacyUsers = users.filter(p => p.intimacyLevel < 15).length;
    
    return {
      totalUsers: users.length,
      avgIntimacy: Math.round(avgIntimacy * 10) / 10,
      highIntimacyUsers,
      lowIntimacyUsers
    };
  }

  getPersonInfo(userId: number, groupId?: number): PersonInfo | undefined {
    const key = this.getKey(userId, groupId);
    return this.personStore.get(key);
  }

  updatePersonInfo(update: PersonInfoUpdate): PersonInfo {
    const key = this.getKey(update.userId, update.groupId);
    let person = this.personStore.get(key);

    if (!person) {
      const today = new Date().toISOString().split('T')[0];
      person = {
        userId: update.userId,
        userName: update.userName || String(update.userId),
        nickname: update.nickname,
        groupId: update.groupId,
        groupName: update.groupName,
        relationship: "陌生人",
        traits: [],
        interests: [],
        lastInteraction: Date.now(),
        interactionCount: 0,
        notes: [],
        intimacyLevel: 0,
        intimacyUpdatedAt: Date.now(),
        consecutiveDays: 0,
        lastInteractionDate: today,
      };
      this.personStore.set(key, person);

      if (update.groupId) {
        if (!this.groupPersonIndex.has(update.groupId)) {
          this.groupPersonIndex.set(update.groupId, new Set());
        }
        this.groupPersonIndex.get(update.groupId)!.add(key);
      }
    }

    if (update.userName) person.userName = update.userName;
    if (update.nickname) person.nickname = update.nickname;
    if (update.groupName) person.groupName = update.groupName;
    if (update.relationship) person.relationship = update.relationship;
    if (update.trait && !person.traits.includes(update.trait)) {
      person.traits.push(update.trait);
    }
    if (update.interest && !person.interests.includes(update.interest)) {
      person.interests.push(update.interest);
    }
    if (update.note && !person.notes.includes(update.note)) {
      person.notes.push(update.note);
    }

    person.lastInteraction = Date.now();
    person.interactionCount++;
    
    this.increaseIntimacy(person);

    return person;
  }

  recordInteraction(userId: number, groupId?: number, userName?: string): void {
    this.updatePersonInfo({
      userId,
      userName,
      groupId,
    });
  }

  getGroupMembers(groupId: number): PersonInfo[] {
    const keys = this.groupPersonIndex.get(groupId);
    if (!keys) return [];

    const members: PersonInfo[] = [];
    for (const key of keys) {
      const person = this.personStore.get(key);
      if (person) {
        members.push(person);
      }
    }
    return members;
  }

  searchPersonByName(name: string): PersonInfo[] {
    const results: PersonInfo[] = [];
    const lowerName = name.toLowerCase();

    for (const person of this.personStore.values()) {
      if (
        person.userName.toLowerCase().includes(lowerName) ||
        (person.nickname && person.nickname.toLowerCase().includes(lowerName))
      ) {
        results.push(person);
      }
    }

    return results;
  }

  getRelationshipDescription(userId: number, groupId?: number): string {
    const person = this.getPersonInfo(userId, groupId);
    if (!person) return "陌生人";

    const parts: string[] = [];

    if (person.relationship !== "陌生人") {
      parts.push(`关系: ${person.relationship}`);
    }

    if (person.traits.length > 0) {
      parts.push(`特点: ${person.traits.slice(0, 3).join(", ")}`);
    }

    if (person.interests.length > 0) {
      parts.push(`兴趣: ${person.interests.slice(0, 3).join(", ")}`);
    }

    if (person.notes.length > 0) {
      parts.push(`备注: ${person.notes[person.notes.length - 1]}`);
    }

    return parts.length > 0 ? parts.join("; ") : "暂无详细信息";
  }

  getPersonContext(userId: number, groupId?: number): string {
    const person = this.getPersonInfo(userId, groupId);
    if (!person) return "";

    const lines: string[] = [];
    lines.push(`用户: ${person.userName}`);
    
    if (person.nickname && person.nickname !== person.userName) {
      lines.push(`昵称: ${person.nickname}`);
    }

    lines.push(`关系: ${person.relationship}`);
    lines.push(`互动次数: ${person.interactionCount}`);
    lines.push(`亲密度: ${person.intimacyLevel.toFixed(1)} (${this.getIntimacyDescription(userId, groupId)})`);
    
    if (person.consecutiveDays > 0) {
      lines.push(`连续互动: ${person.consecutiveDays}天`);
    }

    if (person.traits.length > 0) {
      lines.push(`特点: ${person.traits.join(", ")}`);
    }

    if (person.interests.length > 0) {
      lines.push(`兴趣: ${person.interests.join(", ")}`);
    }

    if (person.notes.length > 0) {
      lines.push(`备注: ${person.notes.slice(-3).join("; ")}`);
    }

    return lines.join("\n");
  }

  getStats(): { totalPersons: number; totalGroups: number } {
    return {
      totalPersons: this.personStore.size,
      totalGroups: this.groupPersonIndex.size,
    };
  }
}

let personInfoManagerInstance: PersonInfoManager | null = null;

export function getPersonInfoManager(): PersonInfoManager {
  if (!personInfoManagerInstance) {
    personInfoManagerInstance = new PersonInfoManager();
  }
  return personInfoManagerInstance;
}
