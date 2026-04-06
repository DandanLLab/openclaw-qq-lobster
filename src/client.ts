import WebSocket from "ws";
import EventEmitter from "events";
import type { OneBotEvent, OneBotMessage, OneBotMessageSegment, ImageMessageOptions, EmojiMessageOptions } from "./types.js";

interface OneBotClientOptions {
  wsUrl: string;
  accessToken?: string;
}

class QQClientManager {
  private clients: Map<string, OneBotClient> = new Map();

  registerClient(accountId: string, client: OneBotClient): void {
    this.clients.set(accountId, client);
  }

  unregisterClient(accountId: string): void {
    this.clients.delete(accountId);
  }

  getClient(accountId: string): OneBotClient | undefined {
    return this.clients.get(accountId);
  }
}

const clientManager = new QQClientManager();

export function initQQClientManager(): void {
  // 初始化时不需要做什么，管理器是单例
}

export function getQQClient(accountId: string): OneBotClient | undefined {
  return clientManager.getClient(accountId);
}

export function registerQQClient(accountId: string, client: OneBotClient): void {
  clientManager.registerClient(accountId, client);
}

export function unregisterQQClient(accountId: string): void {
  clientManager.unregisterClient(accountId);
}

export class OneBotClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: OneBotClientOptions;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 60000;
  private selfId: number | null = null;
  private isAlive = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private messageQueue: Array<{ action: string; params: any }> = [];
  private isConnecting = false;

  constructor(options: OneBotClientOptions) {
    super();
    this.options = options;
  }

  getSelfId(): number | null {
    return this.selfId;
  }

  setSelfId(id: number) {
    this.selfId = id;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async waitForConnection(timeoutMs: number = 5000): Promise<boolean> {
    if (this.isConnected()) return true;
    
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);

      const onConnect = () => {
        clearTimeout(timer);
        this.off("connect", onConnect);
        resolve(true);
      };

      this.on("connect", onConnect);
    });
  }

  private flushMessageQueue() {
    if (this.messageQueue.length === 0) return;
    
    console.log(`[QQ] 📤 刷新消息队列，共 ${this.messageQueue.length} 条消息`);
    
    while (this.messageQueue.length > 0 && this.isConnected()) {
      const msg = this.messageQueue.shift();
      if (msg) {
        this.ws!.send(JSON.stringify({ action: msg.action, params: msg.params }));
      }
    }
  }

  connect() {
    this.cleanup();

    const headers: Record<string, string> = {};
    if (this.options.accessToken) {
      headers["Authorization"] = `Bearer ${this.options.accessToken}`;
    }

    console.log(`[QQ] 正在连接到 WebSocket 服务器: ${this.options.wsUrl}`);
    
    try {
      this.ws = new WebSocket(this.options.wsUrl, { headers });

      this.ws.on("open", () => {
        this.isAlive = true;
        this.reconnectAttempts = 0;
        this.emit("connect");
        console.log(`[QQ] ✅ WebSocket 连接成功: ${this.options.wsUrl}`);
        console.log(`[QQ] WebSocket readyState: OPEN (${WebSocket.OPEN})`);
        this.startHeartbeat();
        this.flushMessageQueue();
      });

      this.ws.on("message", (data) => {
        this.isAlive = true;
        try {
          const payload = JSON.parse(data.toString()) as OneBotEvent;
          if (payload.post_type === "meta_event" && payload.meta_event_type === "heartbeat") {
            return;
          }
          this.emit("message", payload);
        } catch (err) {
          // Ignore non-JSON or parse errors
        }
      });

      this.ws.on("close", (code, reason) => {
        console.warn(`[QQ] WebSocket 连接关闭: code=${code}, reason=${reason.toString()}`);
        this.handleDisconnect();
      });

      this.ws.on("error", (err) => {
        console.error(`[QQ] WebSocket 错误: ${err.message}`);
        this.handleDisconnect();
      });
    } catch (err) {
      console.error("[QQ] Failed to initiate WebSocket connection:", err);
      this.scheduleReconnect();
    }
  }

  private cleanup() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.removeAllListeners();
        const state = ws.readyState;
        if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
          ws.terminate();
        }
      } catch (err) {
        // 忽略所有 WebSocket 清理错误，重连时不抛出异常
      }
    }
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.isAlive === false) {
        console.warn("[QQ] Heartbeat timeout, forcing reconnect...");
        this.handleDisconnect();
        return;
      }
      this.isAlive = false;
    }, 45000);
  }

  private handleDisconnect() {
    this.cleanup();
    this.emit("disconnect");
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    console.log(`[QQ] Reconnecting in ${delay / 1000}s (Attempt ${this.reconnectAttempts + 1})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  sendPrivateMsg(userId: number, message: OneBotMessage | string) {
    this.send("send_private_msg", { user_id: userId, message });
  }

  sendGroupMsg(groupId: number, message: OneBotMessage | string) {
    this.send("send_group_msg", { group_id: groupId, message });
  }

  sendImageToPrivate(userId: number, imageBase64: string, isEmoji: boolean = false) {
    const message: OneBotMessageSegment[] = [
      {
        type: "image",
        data: {
          file: `base64://${imageBase64}`,
          subtype: isEmoji ? 1 : 0,
          ...(isEmoji ? { summary: "[动画表情]" } : {})
        }
      }
    ];
    this.send("send_private_msg", { user_id: userId, message });
  }

  sendImageToGroup(groupId: number, imageBase64: string, isEmoji: boolean = false, atUserId?: number) {
    const message: OneBotMessageSegment[] = [];

    if (atUserId) {
      message.push({ type: "at", data: { qq: String(atUserId) } });
    }

    message.push({
      type: "image",
      data: {
        file: `base64://${imageBase64}`,
        subtype: isEmoji ? 1 : 0,
        ...(isEmoji ? { summary: "[动画表情]" } : {})
      }
    });

    this.send("send_group_msg", { group_id: groupId, message });
  }

  sendEmojiToPrivate(userId: number, emojiBase64: string) {
    this.sendImageToPrivate(userId, emojiBase64, true);
  }

  sendEmojiToGroup(groupId: number, emojiBase64: string, atUserId?: number) {
    this.sendImageToGroup(groupId, emojiBase64, true, atUserId);
  }

  sendImageUrlToGroup(groupId: number, imageUrl: string, isEmoji: boolean = false, atUserId?: number) {
    const message: OneBotMessageSegment[] = [];

    if (atUserId) {
      message.push({ type: "at", data: { qq: String(atUserId) } });
    }

    message.push({
      type: "image",
      data: {
        file: imageUrl,
        subtype: isEmoji ? 1 : 0,
        ...(isEmoji ? { summary: "[动画表情]" } : {})
      }
    });

    this.send("send_group_msg", { group_id: groupId, message });
  }

  sendImageUrlToPrivate(userId: number, imageUrl: string, isEmoji: boolean = false) {
    const message: OneBotMessageSegment[] = [
      {
        type: "image",
        data: {
          file: imageUrl,
          subtype: isEmoji ? 1 : 0,
          ...(isEmoji ? { summary: "[动画表情]" } : {})
        }
      }
    ];
    this.send("send_private_msg", { user_id: userId, message });
  }

  deleteMsg(messageId: number | string) {
    this.send("delete_msg", { message_id: messageId });
  }

  setGroupAddRequest(flag: string, subType: string, approve: boolean = true, reason: string = "") {
    this.send("set_group_add_request", { flag, sub_type: subType, approve, reason });
  }

  setFriendAddRequest(flag: string, approve: boolean = true, remark: string = "") {
    this.send("set_friend_add_request", { flag, approve, remark });
  }

  async getLoginInfo(): Promise<any> {
    return this.sendWithResponse("get_login_info", {});
  }

  async getMsg(messageId: number | string): Promise<any> {
    return this.sendWithResponse("get_msg", { message_id: messageId });
  }

  async getGroupMsgHistory(groupId: number): Promise<any> {
    return this.sendWithResponse("get_group_msg_history", { group_id: groupId });
  }

  async getForwardMsg(id: string): Promise<any> {
    return this.sendWithResponse("get_forward_msg", { id });
  }

  async getFriendList(): Promise<any[]> {
    return this.sendWithResponse("get_friend_list", {});
  }

  async getGroupList(): Promise<any[]> {
    return this.sendWithResponse("get_group_list", {});
  }

  async getGroupMemberList(groupId: number): Promise<any[]> {
    return this.sendWithResponse("get_group_member_list", { group_id: groupId });
  }

  sendGuildChannelMsg(guildId: string, channelId: string, message: OneBotMessage | string) {
    this.send("send_guild_channel_msg", { guild_id: guildId, channel_id: channelId, message });
  }

  async getGuildList(): Promise<any[]> {
    try {
      return await this.sendWithResponse("get_guild_list", {});
    } catch {
      return [];
    }
  }

  async getGuildServiceProfile(): Promise<any> {
    try { return await this.sendWithResponse("get_guild_service_profile", {}); } catch { return null; }
  }

  sendGroupPoke(groupId: number, userId: number) {
    this.send("group_poke", { group_id: groupId, user_id: userId });
  }

  setGroupBan(groupId: number, userId: number, duration: number = 1800) {
    this.send("set_group_ban", { group_id: groupId, user_id: userId, duration });
  }

  setGroupKick(groupId: number, userId: number, rejectAddRequest: boolean = false) {
    this.send("set_group_kick", { group_id: groupId, user_id: userId, reject_add_request: rejectAddRequest });
  }

  private sendWithResponse(action: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not open"));
        return;
      }

      const echo = Math.random().toString(36).substring(2, 15);
      const handler = (data: WebSocket.RawData) => {
        try {
          const resp = JSON.parse(data.toString());
          if (resp.echo === echo) {
            this.ws?.off("message", handler);
            if (resp.status === "ok") {
              resolve(resp.data);
            } else {
              reject(new Error(resp.msg || "API request failed"));
            }
          }
        } catch (err) {
          // Ignore non-JSON messages
        }
      };

      this.ws.on("message", handler);
      this.ws.send(JSON.stringify({ action, params, echo }));

      setTimeout(() => {
        this.ws?.off("message", handler);
        reject(new Error("Request timeout"));
      }, 5000);
    });
  }

  private send(action: string, params: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action, params }));
      console.log(`[QQ] 📤 已发送API请求: ${action}`);
    } else {
      const state = this.ws?.readyState;
      const stateStr = state === WebSocket.CONNECTING ? "CONNECTING" : 
                       state === WebSocket.CLOSING ? "CLOSING" : 
                       state === WebSocket.CLOSED ? "CLOSED" : "NULL";
      
      console.warn(`[QQ] ⚠️ WebSocket 未就绪 (state: ${stateStr}), 将消息加入队列`);
      console.warn(`[QQ] Action: ${action}`);
      
      this.messageQueue.push({ action, params });
      console.log(`[QQ] 📝 消息队列长度: ${this.messageQueue.length}`);
      
      if (state === WebSocket.CLOSED || state === WebSocket.CLOSING || !this.ws) {
        console.log(`[QQ] 🔄 触发重连...`);
        this.scheduleReconnect();
      } else if (state === WebSocket.CONNECTING) {
        console.log(`[QQ] ⏳ WebSocket 正在连接中，消息将在连接成功后发送`);
      }
    }
  }

  disconnect() {
    this.cleanup();
  }
}
