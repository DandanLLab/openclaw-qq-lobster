import { OneBotClient } from "./client.js";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/core";
import { listKnownUsers, getKnownUsersStats } from "./known-users.js";
import type { KnownUser } from "./known-users.js";
import { parseTarget } from "./message-parser.js";

export { listKnownUsers, getKnownUsersStats };

let _clients: Map<string, OneBotClient> | null = null;

export function registerClientsMap(clients: Map<string, OneBotClient>): void {
  _clients = clients;
}

export interface ProactiveSendOptions {
  to: string;
  text: string;
  mediaUrl?: string;
  accountId?: string;
}

export interface ProactiveSendResult {
  success: boolean;
  error?: string;
}

export async function sendProactive(options: ProactiveSendOptions): Promise<ProactiveSendResult> {
  if (!_clients) {
    return { success: false, error: "Clients map not initialized. Channel plugin may not be running." };
  }

  const resolvedAccountId = options.accountId || DEFAULT_ACCOUNT_ID;
  const client = _clients.get(resolvedAccountId);
  if (!client) {
    return {
      success: false,
      error: `No connected client for account "${resolvedAccountId}". Available: [${[..._clients.keys()].join(", ")}]`,
    };
  }

  try {
    const target = parseTarget(options.to);

    if (options.mediaUrl) {
      const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(options.mediaUrl);
      if (isImage) {
        const segments: any[] = [];
        if (options.text) segments.push({ type: "text", data: { text: options.text } });
        segments.push({ type: "image", data: { file: options.mediaUrl } });
        if (target.type === "group") await client.sendGroupMsg(target.groupId!, segments);
        else if (target.type === "guild") await client.sendGuildChannelMsg(target.guildId!, target.channelId!, segments);
        else await client.sendPrivateMsg(target.userId!, segments);
      } else {
        if (options.text) {
          if (target.type === "group") await client.sendGroupMsg(target.groupId!, options.text);
          else if (target.type === "guild") await client.sendGuildChannelMsg(target.guildId!, target.channelId!, options.text);
          else await client.sendPrivateMsg(target.userId!, options.text);
        }
        const fileMsg: any[] = [{ type: "file", data: { file: options.mediaUrl } }];
        if (target.type === "group") await client.sendGroupMsg(target.groupId!, fileMsg);
        else if (target.type === "guild") await client.sendGuildChannelMsg(target.guildId!, target.channelId!, fileMsg);
        else await client.sendPrivateMsg(target.userId!, fileMsg);
      }
    } else {
      if (target.type === "group") await client.sendGroupMsg(target.groupId!, options.text);
      else if (target.type === "guild") await client.sendGuildChannelMsg(target.guildId!, target.channelId!, options.text);
      else await client.sendPrivateMsg(target.userId!, options.text);
    }

    return { success: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[proactive] sendProactive failed: to=${options.to}, error=${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}

export async function sendBulkProactive(
  recipients: string[],
  text: string,
  accountId?: string,
): Promise<Array<{ to: string; result: ProactiveSendResult }>> {
  const results: Array<{ to: string; result: ProactiveSendResult }> = [];

  for (let i = 0; i < recipients.length; i++) {
    const to = recipients[i];
    const result = await sendProactive({ to, text, accountId });
    results.push({ to, result });

    if (i < recipients.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return results;
}

export async function broadcastToKnownUsers(
  text: string,
  options?: {
    accountId?: string;
    type?: "private" | "group" | "guild";
    activeWithin?: number;
  }
): Promise<{ sent: number; failed: number; results: Array<{ to: string; result: ProactiveSendResult }> }> {
  const users = listKnownUsers({
    accountId: options?.accountId,
    type: options?.type,
    activeWithin: options?.activeWithin,
  });

  const recipients: string[] = users.map((u: KnownUser) => {
    if (u.type === "group" && u.groupId) return `group:${u.groupId}`;
    return String(u.openid);
  });

  const results = await sendBulkProactive(recipients, text, options?.accountId);

  const sent = results.filter(r => r.result.success).length;
  const failed = results.filter(r => !r.result.success).length;

  return { sent, failed, results };
}
