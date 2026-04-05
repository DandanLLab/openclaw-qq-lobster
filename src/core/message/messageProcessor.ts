import type { MessageInfo, MessageReceiveConfig } from "../config.js";
import { MessageParser, type ParsedMessage, type MessageSegment } from "./messageParser.js";

export interface ProcessedMessage {
  info: MessageInfo;
  parsed: ParsedMessage;
  shouldProcess: boolean;
  skipReason?: string;
}

export class MessageProcessor {
  private config: MessageReceiveConfig;
  private banWords: string[];
  private banMsgsRegex: RegExp[];
  private parser: MessageParser;

  constructor(config: Partial<MessageReceiveConfig> = {}, parserConfig?: any) {
    this.config = {
      banWords: config.banWords ?? [],
      banMsgsRegex: config.banMsgsRegex ?? [],
    };

    this.banWords = this.config.banWords || [];
    this.banMsgsRegex = (this.config.banMsgsRegex || []).map(r => new RegExp(r, "i"));
    this.parser = new MessageParser(parserConfig);
  }

  async process(
    rawEvent: {
      user_id: number;
      group_id?: number;
      message_id?: string;
      message?: unknown;
      raw_message?: string;
      sender?: { nickname?: string; card?: string };
      time?: number;
    },
    selfId?: number
  ): Promise<ProcessedMessage> {
    const segments = this.extractSegments(rawEvent.message);
    const parsed = await this.parser.parseMessageSegments(segments);
    const info = this.createMessageInfo(parsed, rawEvent, selfId);

    const banCheck = this.checkBan(info, parsed);
    if (!banCheck.passed) {
      return {
        info,
        parsed,
        shouldProcess: false,
        skipReason: banCheck.reason,
      };
    }

    return {
      info,
      parsed,
      shouldProcess: true,
    };
  }

  private extractSegments(message: unknown): MessageSegment[] {
    if (Array.isArray(message)) {
      return message.map(seg => ({
        type: seg.type || "text",
        data: seg.data || {},
      }));
    }

    if (typeof message === "string") {
      return [{ type: "text", data: { text: message } }];
    }

    if (message && typeof message === "object") {
      return [{ type: (message as any).type || "text", data: (message as any).data || {} }];
    }

    return [];
  }

  private createMessageInfo(
    parsed: ParsedMessage,
    rawEvent: {
      user_id: number;
      group_id?: number;
      message_id?: string;
      raw_message?: string;
      sender?: { nickname?: string; card?: string };
      time?: number;
    },
    selfId?: number
  ): MessageInfo {
    const isAtMe = parsed.atUsers.some(u => u.userId === String(selfId));
    const isGroup = !!rawEvent.group_id;

    return {
      id: rawEvent.message_id || `${Date.now()}-${Math.random()}`,
      content: parsed.text,
      senderId: String(rawEvent.user_id),
      senderName: rawEvent.sender?.card || rawEvent.sender?.nickname || "用户",
      timestamp: rawEvent.time ? rawEvent.time * 1000 : Date.now(),
      isAt: isAtMe,
      chatId: rawEvent.group_id ? `group_${rawEvent.group_id}` : `private_${rawEvent.user_id}`,
      chatType: rawEvent.group_id ? "group" : "private",
      groupId: rawEvent.group_id,
      userId: rawEvent.user_id,
      isGroup,
      userName: rawEvent.sender?.card || rawEvent.sender?.nickname || "用户",
    };
  }

  private checkBan(
    info: MessageInfo,
    parsed: ParsedMessage
  ): { passed: boolean; reason?: string } {
    for (const word of this.banWords) {
      if (info.content.includes(word)) {
        return { passed: false, reason: `包含违禁词: ${word}` };
      }
    }

    for (const regex of this.banMsgsRegex) {
      if (regex.test(info.content)) {
        return { passed: false, reason: `匹配违禁规则: ${regex.source}` };
      }
    }

    return { passed: true };
  }

  isSystemUser(userId: number): boolean {
    const systemUsers = [
      2854196300, 2854196301, 2854196302, 2854196303, 2854196304,
      2854196305, 2854196306, 2854196307, 2854196308, 2854196309,
      2854196310, 2854196311, 2854196312, 2854196313, 2854196314,
      2854196315, 2854196316, 2854196317, 2854196318, 2854196319,
    ];
    return systemUsers.includes(userId);
  }

  shouldIgnoreSystemMessage(info: MessageInfo): boolean {
    return this.isSystemUser(info.userId);
  }
}
