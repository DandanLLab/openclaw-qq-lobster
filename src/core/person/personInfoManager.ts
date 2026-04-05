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

  private getKey(userId: number, groupId?: number): string {
    return groupId ? `${userId}:${groupId}` : `${userId}:private`;
  }

  getPersonInfo(userId: number, groupId?: number): PersonInfo | undefined {
    const key = this.getKey(userId, groupId);
    return this.personStore.get(key);
  }

  updatePersonInfo(update: PersonInfoUpdate): PersonInfo {
    const key = this.getKey(update.userId, update.groupId);
    let person = this.personStore.get(key);

    if (!person) {
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
