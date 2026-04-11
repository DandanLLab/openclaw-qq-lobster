import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ChannelPlugin,
  type ChannelAccountSnapshot,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "openclaw/plugin-sdk/core";
import { OneBotClient, registerQQClient, unregisterQQClient, getQQClient } from "./client.js";
import { QQConfigSchema, type QQConfig, getGroupConfig, isPrimaryGroup, shouldRespondToGroup, type GroupChannelConfig, resolveConnectionConfig } from "./config.js";
import { getQQRuntime } from "./runtime.js";
import type { OneBotMessage } from "./types.js";
import { HeartFCChat } from "./core/heartflow/index.js";
import { getPersonInfoManager } from "./core/person/index.js";
import { KnowledgeManagerFactory } from "./core/knowledge/index.js";
import { DreamScheduler } from "./core/dream/index.js";
import { getImageManager, initializeImageManager } from "./core/image/index.js";
import { ExpressionLearnerManager } from "./core/expression/index.js";
import { getEmojiManager } from "./core/emoji/index.js";
import { analyzeEmotion, getEmojiForEmotion, getReplyStyleSuggestion } from "./emotionAnalyzer.js";
import { PFC } from "./core/brain/index.js";
import { MemoryRetrieval } from "./core/memory/index.js";
import { setCurrentMessageContext } from "./messageContext.js";
import { getMessageQueueManager } from "./messageQueue.js";
import {
  downloadImageToBase64,
  processImage,
  formatImageDescription,
  computeImageHash,
  checkIfEmoji,
  detectImageFormat,
} from "./core/image/imageManager.js";
import {
  callWithModelRotation,
  getModelTaskConfig,
  getProviders,
} from "./core/modelCaller.js";
import { pluginManager, type PluginContext } from "./plugins/index.js";
import { handleAdminCommand } from "./admin-commands.js";
import { triggerUpdateCheck } from "./update-checker.js";
import { installGlobalInterceptor } from "./log-buffer.js";
import { populateGroupMemberCache, getCachedMemberName, setCachedMemberName, clearMemberCache } from "./member-cache.js";
import { initRefIndexStore, recordRef, lookupRef, flushRefIndex } from "./ref-index-store.js";
import { TypingKeepAlive } from "./typing-keepalive.js";
import { UploadCache } from "./upload-cache.js";
import { createDeliverDebouncer } from "./deliver-debounce.js";
import { recordKnownUser, getKnownUsersStats, flushKnownUsers } from "./known-users.js";
import { registerClientsMap, sendProactive, broadcastToKnownUsers } from "./proactive.js";
import { cleanCQCodes, extractImageUrls, getReplyMessageId, splitMessage, stripMarkdown, processAntiRisk, resolveMediaUrl, isImageFile, transcribeAudioForNapcat, convertSilkToWav, normalizeTarget } from "./message-parser.js";
import { runDiagnostics, getQQBotDataDir } from "./utils/platform.js";
import { getPackageVersion } from "./utils/pkg-version.js";

export type ResolvedQQAccount = ChannelAccountSnapshot & {
  config: QQConfig;
  client?: OneBotClient;
};

const clientsMap = new Map<string, OneBotClient>();

class QQBotContext {
  private personManager = getPersonInfoManager();
  private knowledgeManagerFactory = new KnowledgeManagerFactory();
  private dreamScheduler = new DreamScheduler();
  private imageManager = getImageManager();
  private expressionLearnerManager = new ExpressionLearnerManager();
  private memoryRetrieval: Map<string, MemoryRetrieval> = new Map();
  private heartFChatting: Map<string, HeartFCChat> = new Map();
  private pfc: Map<string, PFC> = new Map();
  private initialized: boolean = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await initializeImageManager();
    await pluginManager.initialize({});
    this.personManager.startIntimacyDecayTimer();
    this.initialized = true;
    console.log("[QQBotContext] 所有模块初始化完成，亲密度衰减定时器已启动");
  }

  getPersonManager() { return this.personManager; }
  getKnowledgeManager() { return this.knowledgeManagerFactory; }
  getDreamManager() { return this.dreamScheduler; }
  getImageManager() { return this.imageManager; }
  getExpressionLearner() { return this.expressionLearnerManager; }

  getMemoryRetrieval(chatId: string): MemoryRetrieval {
    if (!this.memoryRetrieval.has(chatId)) {
      this.memoryRetrieval.set(chatId, new MemoryRetrieval(chatId));
    }
    return this.memoryRetrieval.get(chatId)!;
  }

  getHeartFChatting(chatId: string, chatStream: any, config: any): HeartFCChat {
    if (!this.heartFChatting.has(chatId)) {
      this.heartFChatting.set(chatId, new HeartFCChat(chatId, chatStream, config));
    }
    return this.heartFChatting.get(chatId)!;
  }

  getPFC(chatId: string, chatName: string = "", botName: string = "助手"): PFC {
    if (!this.pfc.has(chatId)) {
      const chatConfig = { thinkMode: "dynamic" as const, plannerSmooth: 3, mentionedBotReply: true };
      const personalityConfig = { name: botName, traits: ["友好", "乐于助人"], speakingStyle: "自然亲切" };
      this.pfc.set(chatId, new PFC(chatId, chatName, chatConfig, personalityConfig, botName));
    }
    return this.pfc.get(chatId)!;
  }

  async planReply(
    chatId: string,
    messages: Array<{ content: string; senderId: string; senderName: string; timestamp: number; isMentioned?: boolean }>,
    forceReply: boolean = false,
    llmCall?: (prompt: string) => Promise<string>
  ): Promise<{ shouldReply: boolean; reasoning?: string; actionMessage?: string }> {
    const pfc = this.getPFC(chatId);
    const messageInfos = messages.map((m, i) => ({
      id: `msg_${i}_${m.timestamp}`,
      content: m.content,
      senderId: m.senderId,
      senderName: m.senderName,
      timestamp: m.timestamp,
      isMentioned: m.isMentioned,
      chatId,
      chatType: "group" as const,
    }));
    
    try {
      const result = await pfc.plan(messageInfos, forceReply, llmCall);
      if (result && result.actionType) {
        return {
          shouldReply: result.actionType === "reply" || result.actionType === "direct_reply",
          reasoning: result.reasoning,
          actionMessage: typeof result.actionMessage === 'string' ? result.actionMessage : undefined,
        };
      }
    } catch (e) {
      console.warn("[QQBotContext] PFC规划失败:", e);
    }
    return { shouldReply: forceReply };
  }

  processMessage(text: string, userId: number, groupId?: number): { 
    emotion: ReturnType<typeof analyzeEmotion>;
    personContext: string;
    knowledgeContext: string;
  } {
    const emotion = analyzeEmotion(text);
    const personContext = this.personManager.getPersonContext(userId, groupId);
    const knowledgeResult = this.getKnowledgeManager();
    
    return {
      emotion,
      personContext,
      knowledgeContext: "",
    };
  }

  recordInteraction(userId: number, userName: string, groupId?: number, groupName?: string): void {
    this.personManager.recordInteraction(userId, groupId, userName);
    if (groupId && groupName) {
      const person = this.personManager.getPersonInfo(userId, groupId);
      if (person && !person.groupName) {
        this.personManager.updatePersonInfo({ userId, groupId, groupName });
      }
    }
  }

  learnExpression(pattern: string, replacement: string, context?: string): void {
    console.log(`[QQBotContext] learnExpression 被调用，但新版本使用自动学习`);
  }

  applyExpressions(text: string, context?: string): string {
    return text;
  }

  getStats(): {
    persons: number;
    knowledge: number;
    expressions: number;
    dreams: number;
  } {
    return {
      persons: this.personManager.getStats().totalPersons,
      knowledge: 0,
      expressions: 0,
      dreams: 0,
    };
  }
}

const botContext = new QQBotContext();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface CommandContext {
  userId: number;
  groupId?: number;
  isGroup: boolean;
  isAdmin: boolean;
  client: OneBotClient;
  config: QQConfig;
  groupConfig: GroupChannelConfig | null;
  cfg: any;
}

async function handleCommand(text: string, ctx: CommandContext): Promise<boolean> {
  const { userId, groupId, isGroup, isAdmin, client, config, groupConfig, cfg } = ctx;
  
  const hasAdmins = config.admins && config.admins.length > 0;
  const adminCommands = ["/ping", "/version", "/logs", "/status", "/mute", "/kick", "/ban", "/help"];
  const isAdminCommand = adminCommands.some(cmd => text.startsWith(cmd));
  
  if (isAdminCommand) {
    if (!hasAdmins) {
      console.log(`[QQ] 管理员命令 ${text.split(" ")[0]} 被忽略：未配置管理员`);
      return false;
    }
    if (!isAdmin) {
      console.log(`[QQ] 非管理员用户 ${userId} 尝试使用管理员命令 ${text.split(" ")[0]}，已忽略`);
      return false;
    }
    
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    
    const adminCtx = {
      client,
      isGroup,
      groupId,
      userId,
      text,
      message: undefined as any,
      eventTime: Date.now(),
    };
    
    const handled = await handleAdminCommand(cmd, parts, adminCtx);
    if (handled) return true;
  }
  
  if (isGroup) {
    if (config.allowedGroups && config.allowedGroups.length > 0) {
      if (!config.allowedGroups.includes(groupId!)) {
        return true;
      }
    }
  }
  
  const chatFreqMatch = text.match(/^\/chat\s+(?:t|talk_frequency|talkfrequency)\s+([+-]?\d*\.?\d+)$/i);
  if (chatFreqMatch) {
    const value = parseFloat(chatFreqMatch[1]);
    const clampedValue = Math.max(0, Math.min(1, value));
    
    if (groupConfig) {
      groupConfig.talkValue = clampedValue;
    }
    
    if (isGroup) {
      client.sendGroupMsg(groupId!, `[CQ:at,qq=${userId}] 已设置发言频率为: ${clampedValue.toFixed(2)}`);
    } else {
      client.sendPrivateMsg(userId, `已设置发言频率为: ${clampedValue.toFixed(2)}`);
    }
    return true;
  }
  
  if (/^\/chat\s+(?:s|show|status)$/i.test(text)) {
    const talkValue = groupConfig?.talkValue ?? config.talkValue ?? 0.5;
    const requireMention = groupConfig?.requireMention ?? config.requireMention;
    const historyLimit = groupConfig?.historyLimit ?? config.historyLimit ?? 5;
    const isPrimary = groupConfig?.isPrimary ?? false;
    
    const statusMsg = `📊 当前聊天状态
• 发言频率: ${talkValue.toFixed(2)}
• 需要@: ${requireMention ? "是" : "否"}
• 历史消息数: ${historyLimit}
• 主群: ${isPrimary ? "是" : "否"}
• 管理员: ${isAdmin ? "是" : "否"}`;
    
    if (isGroup) {
      client.sendGroupMsg(groupId!, `[CQ:at,qq=${userId}] ${statusMsg}`);
    } else {
      client.sendPrivateMsg(userId, statusMsg);
    }
    return true;
  }
  
  if (/^\/emoji\s+list/i.test(text)) {
    try {
      const emojiManager = getEmojiManager(cfg);
      const count = await emojiManager.getCount();
      if (isGroup) {
        client.sendGroupMsg(groupId!, `[CQ:at,qq=${userId}] 📊 表情包统计: 共 ${count} 个表情包`);
      } else {
        client.sendPrivateMsg(userId, `📊 表情包统计: 共 ${count} 个表情包`);
      }
    } catch (e) {
      if (isGroup) {
        client.sendGroupMsg(groupId!, `[CQ:at,qq=${userId}] 获取表情包统计失败`);
      } else {
        client.sendPrivateMsg(userId, `获取表情包统计失败`);
      }
    }
    return true;
  }
  
  if (/^\/random_emojis?$/i.test(text)) {
    try {
      const emojiManager = getEmojiManager(cfg);
      const emojis = await emojiManager.getRandom(3);
      if (emojis && emojis.length > 0) {
        for (const emoji of emojis) {
          if (emoji.path && fsSync.existsSync(emoji.path)) {
            const buffer = fsSync.readFileSync(emoji.path);
            const base64 = buffer.toString("base64");
            if (isGroup) {
              client.sendEmojiToGroup(groupId!, base64);
            } else {
              client.sendEmojiToPrivate(userId, base64);
            }
            await sleep(500);
          }
        }
      } else {
        if (isGroup) {
          client.sendGroupMsg(groupId!, `暂无表情包～`);
        } else {
          client.sendPrivateMsg(userId, `暂无表情包～`);
        }
      }
    } catch (e) {
      if (isGroup) {
        client.sendGroupMsg(groupId!, `发送表情包失败`);
      } else {
        client.sendPrivateMsg(userId, `发送表情包失败`);
      }
    }
    return true;
  }
  
  if (/^\/help$/i.test(text)) {
    if (isGroup) {
      return true;
    }
    const helpMsg = `📖 命令帮助
/chat t <数值> - 设置发言频率 (0-1)
/chat s - 显示当前状态
/emoji list - 表情包统计
/random_emoji - 随机表情包
/search <关键词> - 网络搜索
/summary [today|user <id>] - 聊天摘要
/diary [list|today|generate] - 日记功能
/memory [list|add|search|clear|stats|share] - 记忆管理
/smart_seg [on|off|status] - 智能分段开关
/help - 显示帮助`;
    client.sendPrivateMsg(userId, helpMsg);
    return true;
  }
  
  const pluginCtx: PluginContext = {
    userId,
    groupId,
    isGroup,
    text,
    senderName: '',
    config,
    client,
    cfg
  };
  
  if (text.startsWith('/search') || text.startsWith('/搜索') || 
      text.startsWith('搜索 ') || text.startsWith('搜一下 ') ||
      text.toLowerCase().startsWith('bing ')) {
    const result = await pluginManager.getWebSearch().handle(pluginCtx);
    if (result.handled && result.response) {
      if (isGroup) {
        client.sendGroupMsg(groupId!, `[CQ:at,qq=${userId}] ${result.response}`);
      } else {
        client.sendPrivateMsg(userId, result.response);
      }
      return true;
    }
  }
  
  if (text.startsWith('/summary') || text.includes('/摘要')) {
    const result = await pluginManager.getChatSummary().handle(pluginCtx);
    if (result.handled && result.response) {
      if (isGroup) {
        client.sendGroupMsg(groupId!, `[CQ:at,qq=${userId}] ${result.response}`);
      } else {
        client.sendPrivateMsg(userId, result.response);
      }
      return true;
    }
  }
  
  if (text.startsWith('/diary') || text.includes('/日记')) {
    const result = await pluginManager.getDiaryManager().handle(pluginCtx);
    if (result.handled && result.response) {
      if (isGroup) {
        client.sendGroupMsg(groupId!, `[CQ:at,qq=${userId}] ${result.response}`);
      } else {
        client.sendPrivateMsg(userId, result.response);
      }
      return true;
    }
  }
  
  if (text.startsWith('/memory') || text.includes('/记忆')) {
    const result = await pluginManager.getMemoryManager().handle(pluginCtx);
    if (result.handled && result.response) {
      if (isGroup) {
        client.sendGroupMsg(groupId!, `[CQ:at,qq=${userId}] ${result.response}`);
      } else {
        client.sendPrivateMsg(userId, result.response);
      }
      return true;
    }
  }
  
  if (text.match(/\/smart_seg/i)) {
    const result = await pluginManager.getSmartSegmentation().handle(pluginCtx);
    if (result.handled && result.response) {
      if (isGroup) {
        client.sendGroupMsg(groupId!, `[CQ:at,qq=${userId}] ${result.response}`);
      } else {
        client.sendPrivateMsg(userId, result.response);
      }
      return true;
    }
  }
  
  if (text.includes('戳') && text.includes('我')) {
    const result = await pluginManager.getPokeEnhancer().handle(pluginCtx);
    if (result.handled && result.response) {
      if (isGroup) {
        client.sendGroupMsg(groupId!, `[CQ:at,qq=${userId}] ${result.response}`);
      } else {
        client.sendPrivateMsg(userId, result.response);
      }
      return true;
    }
  }
  
  return false;
}

export const qqChannel: ChannelPlugin<ResolvedQQAccount> = {
  id: "qq",
  meta: {
    id: "qq",
    label: "QQ (OneBot)",
    selectionLabel: "QQ",
    docsPath: "extensions/qq",
    blurb: "Connect to QQ via OneBot v11",
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    // @ts-ignore
    deleteMessage: true,
  },
  configSchema: buildChannelConfigSchema(QQConfigSchema),
  config: {
    listAccountIds: (cfg) => {
        // @ts-ignore
        const qq = cfg.channels?.qq;
        if (!qq) return [];
        if (qq.accounts) return Object.keys(qq.accounts);
        return [DEFAULT_ACCOUNT_ID];
    },
    resolveAccount: (cfg, accountId) => {
        const id = accountId ?? DEFAULT_ACCOUNT_ID;
        // @ts-ignore
        const qq = cfg.channels?.qq;
        const accountConfig = id === DEFAULT_ACCOUNT_ID ? qq : qq?.accounts?.[id];
        return {
            accountId: id,
            name: accountConfig?.name ?? "QQ Default",
            enabled: true,
            configured: Boolean(accountConfig?.wsUrl),
            tokenSource: accountConfig?.accessToken ? "config" : "none",
            config: accountConfig || {},
        };
    },
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    describeAccount: (acc) => ({
        accountId: acc.accountId,
        configured: acc.configured,
    }),
  },
  directory: {
      listPeers: async ({ accountId }) => {
          const client = getQQClient(accountId || DEFAULT_ACCOUNT_ID);
          if (!client) return [];
          try {
              const friends = await client.getFriendList();
              return friends.map(f => ({
                  id: String(f.user_id),
                  name: f.remark || f.nickname,
                  kind: "user" as const,
                  metadata: { ...f }
              }));
          } catch (e) {
              return [];
          }
      },
      listGroups: async ({ accountId, cfg }) => {
          const client = getQQClient(accountId || DEFAULT_ACCOUNT_ID);
          if (!client) return [];
          const list: any[] = [];
          
          try {
              const groups = await client.getGroupList();
              list.push(...groups.map(g => ({
                  id: String(g.group_id),
                  name: g.group_name,
                  kind: "group" as const,
                  metadata: { ...g }
              })));
          } catch (e) {}

          // @ts-ignore
          const enableGuilds = cfg?.channels?.qq?.enableGuilds ?? true;
          if (enableGuilds) {
              try {
                  const guilds = await client.getGuildList();
                  list.push(...guilds.map(g => ({
                      id: `guild:${g.guild_id}`,
                      name: `[频道] ${g.guild_name}`,
                      kind: "group" as const,
                      metadata: { ...g }
                  })));
              } catch (e) {}
          }
          return list;
      }
  },
  status: {
      probeAccount: async ({ account, timeoutMs }) => {
          console.log(`[QQ] 🔍 probeAccount 被调用! accountId=${account?.accountId}`);
          const config = account.config;
          
          const connectionConfig = resolveConnectionConfig(config);
          console.log(`[QQ] 🔍 probeAccount: mode=${connectionConfig.mode}, wsUrl=${connectionConfig.wsUrl}, reverseWsPort=${connectionConfig.reverseWsPort}`);
          
          if (connectionConfig.mode === "reverse") {
              console.log(`[QQ] 🔍 probeAccount: 反向WebSocket模式，检查现有连接`);
              const client = getQQClient(account.accountId || DEFAULT_ACCOUNT_ID);
              if (client && client.isConnected()) {
                  try {
                      const info = await client.getLoginInfo();
                      console.log(`[QQ] ✅ probeAccount: 连接正常, 用户=${info.nickname}`);
                      return { 
                          ok: true, 
                          bot: { id: String(info.user_id), username: info.nickname } 
                      };
                  } catch (e) {
                      console.warn(`[QQ] ⚠️ probeAccount: 获取登录信息失败: ${e}`);
                      return { ok: false, error: String(e) };
                  }
              }
              console.log(`[QQ] ✅ probeAccount: 反向WebSocket模式，等待NapCat连接`);
              return { ok: true, bot: { id: "reverse-mode", username: "Reverse WS Mode" } };
          }
          
          if (!connectionConfig.wsUrl) return { ok: false, error: "Missing wsUrl" };
          
          console.log(`[QQ] 🔍 probeAccount: 正向WebSocket模式，尝试连接 ${connectionConfig.wsUrl}`);
          
          const client = new OneBotClient({
              wsUrl: connectionConfig.wsUrl,
              accessToken: config.accessToken,
          });
          
          return new Promise((resolve) => {
              const timer = setTimeout(() => {
                  client.disconnect();
                  resolve({ ok: false, error: "Connection timeout" });
              }, timeoutMs || 5000);

              client.on("connect", async () => {
                  try {
                      const info = await client.getLoginInfo();
                      clearTimeout(timer);
                      client.disconnect();
                      resolve({ 
                          ok: true, 
                          bot: { id: String(info.user_id), username: info.nickname } 
                      });
                  } catch (e) {
                      clearTimeout(timer);
                      client.disconnect();
                      resolve({ ok: false, error: String(e) });
                  }
              });
              
              client.on("error", (err) => {
                  clearTimeout(timer);
                  resolve({ ok: false, error: String(err) });
              });

              client.connect();
          });
      },
      buildAccountSnapshot: ({ account, runtime, probe }) => {
          return {
              accountId: account.accountId,
              name: account.name,
              enabled: account.enabled,
              configured: account.configured,
              running: runtime?.running ?? false,
              lastStartAt: runtime?.lastStartAt ?? null,
              lastError: runtime?.lastError ?? null,
              probe,
          };
      }
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) => 
        applyAccountNameToChannelSection({ cfg, channelKey: "qq", accountId, name }),
    validateInput: ({ input }) => null,
    applyAccountConfig: ({ cfg, accountId, input }) => {
        const namedConfig = applyAccountNameToChannelSection({
            cfg,
            channelKey: "qq",
            accountId,
            name: input.name,
        });
        
        const next = accountId !== DEFAULT_ACCOUNT_ID 
            ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: "qq" }) 
            : namedConfig;

        const newConfig = {
            wsUrl: (input as any).wsUrl || (input as any).url || "ws://localhost:3001",
            accessToken: (input as any).accessToken,
            enabled: true,
        };

        if (accountId === DEFAULT_ACCOUNT_ID) {
            return {
                ...next,
                channels: {
                    ...next.channels,
                    qq: { ...next.channels?.qq, ...newConfig }
                }
            };
        }
        
        return {
            ...next,
            channels: {
                ...next.channels,
                qq: {
                    ...next.channels?.qq,
                    enabled: true,
                    accounts: {
                        ...next.channels?.qq?.accounts,
                        [accountId]: {
                            ...next.channels?.qq?.accounts?.[accountId],
                            ...newConfig
                        }
                    }
                }
            }
        };
    }
  },
  gateway: {
    startAccount: async (ctx) => {
        console.log(`[QQ] 🚀 startAccount 被调用! accountId=${ctx.account?.accountId}, reason=检查调用栈`);
        console.trace(`[QQ] 🚀 startAccount 调用栈`);
        const { account, cfg } = ctx;
        const config = account.config;

        const connectionConfig = resolveConnectionConfig(config);

        installGlobalInterceptor(config.logBufferSize ?? 200);
        initRefIndexStore();
        registerClientsMap(clientsMap);

        if (config.enableUpdateCheck !== false) {
            triggerUpdateCheck({
                info: console.log,
                error: console.error,
                debug: console.debug,
            });
        }

        const existingClient = getQQClient(account.accountId);
        console.log(`[QQ] 🔍 检查现有连接: existingClient=${existingClient ? 'exists' : 'null'}, isConnected=${existingClient?.isConnected()}`);
        if (existingClient) {
            if (existingClient.isConnected()) {
                console.log(`[QQ] ✅ 账号 ${account.accountId} 已连接，跳过重启`);
                const cleanupFn = () => {
                    existingClient.disconnect();
                    unregisterQQClient(account.accountId);
                    clearMemberCache();
                    flushRefIndex();
                    flushKnownUsers();
                    console.log(`[QQ] 🧹 账号 ${account.accountId} 已停止，缓存已清理`);
                };
                return cleanupFn;
            }
            console.log(`[QQ] Stopping existing client for account ${account.accountId} before restart`);
            existingClient.disconnect();
        }

        const client = new OneBotClient({
            wsUrl: connectionConfig.wsUrl,
            httpUrl: config.httpUrl,
            accessToken: config.accessToken,
            reverseWsPort: connectionConfig.reverseWsPort,
        });
        
        registerQQClient(account.accountId, client);
        clientsMap.set(account.accountId, client);

        const uploadCache = new UploadCache();
        const processedMsgIds = new Set<string>();
        const inboundRateLimitMap = new Map<string, number>();
        
        const cleanupInterval = setInterval(() => {
            if (processedMsgIds.size > 1000) {
                const arr = Array.from(processedMsgIds);
                processedMsgIds.clear();
                for (let i = arr.length - 500; i < arr.length; i++) {
                    if (arr[i]) processedMsgIds.add(arr[i]);
                }
            }
            const now = Date.now();
            for (const [key, time] of inboundRateLimitMap) {
                if (now - time > 60000) inboundRateLimitMap.delete(key);
            }
        }, 3600000);
        
        // 生成唯一消息ID的函数
        const generateUniqueMessageId = (event: any): string => {
            if (event.message_id) return String(event.message_id);
            // 为没有message_id的事件生成唯一ID
            const timestamp = event.time || Date.now();
            const userId = event.user_id;
            const groupId = event.group_id || event.guild_id || 'private';
            const type = event.post_type || 'message';
            const subType = event.sub_type || event.notice_type || '';
            return `${type}:${subType}:${userId}:${groupId}:${timestamp}`;
        };

        client.on("connect", async () => {
             console.log(`[QQ] Connected account ${account.accountId}`);
             try {
                const info = await client.getLoginInfo();
                if (info && info.user_id) {
                    client.setSelfId(info.user_id);
                    console.log(`[QQ] Login info obtained: selfId=${info.user_id}`);
                }
                if (info && info.nickname) console.log(`[QQ] Logged in as: ${info.nickname} (${info.user_id})`);
                getQQRuntime().channel.activity.record({
                    channel: "qq", accountId: account.accountId, direction: "inbound", 
                 });
                await botContext.initialize();
                
                if (config.autoPopulateMemberCache !== false) {
                    try {
                        const groups = await client.getGroupList();
                        for (const g of groups.slice(0, 5)) {
                            populateGroupMemberCache(client, g.group_id).catch(() => {});
                        }
                        console.log(`[QQ] 📋 预加载群成员缓存: ${Math.min(groups.length, 5)} 个群`);
                    } catch (e) {
                        console.warn(`[QQ] 预加载群成员缓存失败:`, e);
                    }
                }
             } catch (err) {
                console.warn(`[QQ] getLoginInfo failed, will rely on meta_event for selfId: ${err}`);
             }
        });

        client.on("request", (event) => {
            if (config.autoApproveRequests) {
                if (event.request_type === "friend") client.setFriendAddRequest(event.flag, true);
                else if (event.request_type === "group") client.setGroupAddRequest(event.flag, event.sub_type, true);
            }
        });

        client.on("message", async (event) => {
          try {
            if (event.post_type === "meta_event") {
                 if (event.meta_event_type === "lifecycle" && event.sub_type === "connect" && event.self_id) {
                     client.setSelfId(event.self_id);
                     console.log(`[QQ] Meta event set selfId=${event.self_id}`);
                 }
                 return;
            }

            if (event.post_type === "notice" && event.notice_type === "notify" && event.sub_type === "poke") {
                const currentSelfId = client.getSelfId() || event.self_id;
                if (String(event.target_id) === String(currentSelfId)) {
                    event.post_type = "message";
                    event.message_type = event.group_id ? "group" : "private";
                    event.raw_message = `[动作] 用户戳了你一下`;
                    event.message = [{ type: "text", data: { text: event.raw_message } }];
                    console.log(`[QQ] 收到戳一戳事件，交给龙虾核心处理`);
                } else return;
            }

            if (event.post_type !== "message") return;
            
            const rawText = event.raw_message || "";
            if (/^group:\d+$/i.test(rawText.trim()) || /^terminated$/i.test(rawText.trim())) {
                console.log(`[QQ] 拦截系统消息: ${rawText}`);
                return;
            }
            
            const selfId = client.getSelfId() || event.self_id;
            console.log(`[QQ] 收到消息: post_type=${event.post_type}, message_type=${event.message_type}, selfId=${selfId}, user_id=${event.user_id}, group_id=${event.group_id || 'N/A'}`);
            
            if (selfId && String(event.user_id) === String(selfId)) {
                console.log(`[QQ] 跳过自己的消息`);
                return;
            }

            if (config.enableDeduplication !== false) {
                const msgIdKey = generateUniqueMessageId(event);
                if (processedMsgIds.has(msgIdKey)) {
                    console.log(`[QQ] ⏭️ 检测到重复消息，跳过处理: ${msgIdKey}`);
                    return;
                }
                processedMsgIds.add(msgIdKey);
                console.log(`[QQ] 📝 记录消息ID: ${msgIdKey}`);
            }

            const isGroup = event.message_type === "group";
            const isGuild = event.message_type === "guild";
            
            if (isGuild && !config.enableGuilds) return;

            const runtime = getQQRuntime();

            const userId = event.user_id;
            const groupId = event.group_id;
            const guildId = event.guild_id;
            const channelId = event.channel_id;
            
            if (config.silentKeywords && config.silentKeywords.length > 0) {
                const rawMsg = event.raw_message || "";
                for (const kw of config.silentKeywords) {
                    if (rawMsg.includes(kw)) {
                        console.log(`[QQ] 静默关键词命中，跳过消息: ${kw}`);
                        return;
                    }
                }
            }
            
            if (config.inboundRateLimitMs && config.inboundRateLimitMs > 0) {
                const rateKey = isGroup ? `g:${groupId}:${userId}` : `p:${userId}`;
                const lastTime = inboundRateLimitMap.get(rateKey) || 0;
                const now = Date.now();
                if (now - lastTime < config.inboundRateLimitMs) {
                    console.log(`[QQ] 入站频控限制，跳过消息: ${rateKey}`);
                    return;
                }
                inboundRateLimitMap.set(rateKey, now);
            }
            
            let text = event.raw_message || "";
            
            if (Array.isArray(event.message)) {
                let resolvedText = "";
                for (const seg of event.message) {
                    if (seg.type === "text") resolvedText += seg.data?.text || "";
                    else if (seg.type === "at") {
                        let name = seg.data?.qq;
                        if (name !== "all" && isGroup) {
                            const cached = getCachedMemberName(String(groupId), String(name));
                            if (cached) name = cached;
                            else {
                                try {
                                    const info = await (client as any).sendWithResponse("get_group_member_info", { group_id: groupId, user_id: name });
                                    name = info?.card || info?.nickname || name;
                                    setCachedMemberName(String(groupId), String(seg.data.qq), name);
                                } catch (e) {}
                            }
                        }
                        resolvedText += ` @${name} `;
                    } else if (seg.type === "record") {
                        resolvedText += ` [语音消息]`;
                        if (config.enableVoiceTranscription !== false && seg.data?.url) {
                            try {
                                const audioUrl = seg.data.url;
                                const tempDir = getQQBotDataDir("temp");
                                const audioFileName = `voice_${Date.now()}.silk`;
                                const audioPath = path.join(tempDir, audioFileName);
                                
                                if (audioUrl.startsWith("http")) {
                                    const audioResp = await fetch(audioUrl);
                                    const audioBuffer = Buffer.from(await audioResp.arrayBuffer());
                                    await fs.writeFile(audioPath, audioBuffer);
                                } else if (audioUrl.startsWith("base64://")) {
                                    const audioBase64 = audioUrl.replace("base64://", "");
                                    await fs.writeFile(audioPath, Buffer.from(audioBase64, "base64"));
                                } else if (audioUrl.startsWith("file://")) {
                                    const localPath = audioUrl.replace("file://", "");
                                    await fs.copyFile(localPath, audioPath);
                                }
                                
                                let wavPath = audioPath;
                                if (audioPath.endsWith(".silk") || audioPath.endsWith(".amr")) {
                                    const convertResult = await convertSilkToWav(audioPath);
                                    if (convertResult) {
                                        wavPath = convertResult.wavPath;
                                        console.log(`[QQ] 🎵 SILK/AMR 转换为 WAV: ${wavPath}, 时长: ${convertResult.duration}ms`);
                                    }
                                }
                                
                                const transcription = await transcribeAudioForNapcat(wavPath, cfg);
                                if (transcription) {
                                    resolvedText += `(转文字: ${transcription})`;
                                    console.log(`[QQ] 🎤 语音转文字成功: ${transcription.substring(0, 50)}...`);
                                }
                                
                                await fs.unlink(audioPath).catch(() => {});
                                if (wavPath !== audioPath) await fs.unlink(wavPath).catch(() => {});
                            } catch (e) {
                                console.warn(`[QQ] 语音转文字失败:`, e);
                            }
                        } else if (seg.data?.text) {
                            resolvedText += `(${seg.data.text})`;
                        }
                    } else if (seg.type === "image") {
                        const imgUrl = seg.data?.url || seg.data?.file;
                        const subType = seg.data?.subType;
                        
                        if (imgUrl && (imgUrl.startsWith("http") || imgUrl.startsWith("base64://"))) {
                            try {
                                const base64 = await downloadImageToBase64(imgUrl);
                                if (base64) {
                                    let imageDescription = "";
                                    let imageResult = null;
                                    if (config.enableImageRecognition !== false) {
                                        imageResult = await processImage(base64, runtime, subType, config.imageRecognitionPrompt);
                                        imageDescription = formatImageDescription(imageResult);
                                        resolvedText += ` ${imageDescription}`;
                                    } else {
                                        resolvedText += " [图片]";
                                    }
                                    
                                    if ((config as any).stealEmoji !== false && isGroup && config.enableImageRecognition !== false) {
                                        const skipVLM = (config as any).emojiCheckVLM !== true;
                                        const isEmoji = await checkIfEmoji(base64, runtime, skipVLM, imageResult || undefined);
                                        if (isEmoji) {
                                            try {
                                                const emojiDir = path.join(process.cwd(), "data", "emoji");
                                                if (!fsSync.existsSync(emojiDir)) {
                                                   fsSync.mkdirSync(emojiDir, { recursive: true });
                                                }
                                                const hash = computeImageHash(base64);
                                                const detectedFormat = detectImageFormat(base64);
                                                const ext = detectedFormat === "gif" ? "gif" : 
                                                           detectedFormat === "apng" ? "png" : 
                                                           detectedFormat === "webp" ? "webp" : 
                                                           detectedFormat === "png" ? "png" : "jpg";
                                                const filename = `stolen_${Date.now()}_${hash.substring(0, 8)}.${ext}`;
                                                const filePath = path.join(emojiDir, filename);
                                                
                                                const buffer = Buffer.from(base64, "base64");
                                                fsSync.writeFileSync(filePath, buffer);
                                                const formatDisplay = detectedFormat === "apng" ? "APNG (动态PNG)" : detectedFormat.toUpperCase();
                                                console.log(`[QQ] 🎭 自动保存表情包: ${filename} (格式: ${formatDisplay})`);
                                            } catch (e) {
                                                console.warn("[QQ] 保存表情包失败:", e);
                                            }
                                        }
                                    }
                                } else {
                                    resolvedText += " [图片]";
                                }
                            } catch (e) {
                                console.warn("[QQ] 图片处理失败:", e);
                                resolvedText += " [图片]";
                            }
                        } else {
                            resolvedText += " [图片]";
                        }
                    } else if (seg.type === "video") resolvedText += " [视频消息]";
                    else if (seg.type === "json") resolvedText += " [卡片消息]";
                    else if (seg.type === "forward" && seg.data?.id) {
                        try {
                            const forwardData = await client.getForwardMsg(seg.data.id);
                            if (forwardData?.messages) {
                                resolvedText += "\n[转发聊天记录]:";
                                for (const m of forwardData.messages.slice(0, 10)) {
                                    resolvedText += `\n${m.sender?.nickname || m.user_id}: ${cleanCQCodes(m.content || m.raw_message)}`;
                                }
                            }
                        } catch (e) {}
                    } else if (seg.type === "file") {
                         if (!seg.data?.url && isGroup) {
                             try {
                                 const info = await (client as any).sendWithResponse("get_group_file_url", { group_id: groupId, file_id: seg.data?.file_id, busid: seg.data?.busid });
                                 if (info?.url) seg.data.url = info.url;
                             } catch(e) {}
                         }
                         resolvedText += ` [文件: ${seg.data?.file || "未命名"}]`;
                    }
                }
                if (resolvedText) text = resolvedText;
            }
            
            if (config.blockedUsers?.includes(userId)) return;
            if (isGroup && config.allowedGroups?.length && !config.allowedGroups.includes(groupId)) return;
            
            if (isGroup && !shouldRespondToGroup(config, groupId)) {
                console.log(`[QQ] 群 ${groupId} 已禁用或不在白名单中，跳过`);
                return;
            }
            
            console.log(`[QQ] 📥 收到消息内容: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);
            
            const groupConfig = isGroup ? getGroupConfig(config, groupId) : null;
            const isPrimary = isGroup && isPrimaryGroup(config, groupId);
            if (isGroup && isPrimary) {
                console.log(`[QQ] 🌟 主群消息: ${groupId}`);
            }
            
            const effectiveTalkValue = groupConfig?.talkValue ?? config.talkValue ?? 0.5;
            const effectiveRequireMention = groupConfig?.requireMention ?? config.requireMention;
            const effectiveHistoryLimit = groupConfig?.historyLimit ?? config.historyLimit ?? 5;
            const effectiveKeywordTriggers = groupConfig?.keywordTriggers ?? config.keywordTriggers;
            const effectiveSystemPrompt = groupConfig?.systemPrompt ?? config.systemPrompt;
            
            const isAdmin = config.admins?.includes(userId) ?? false;
            
            if (text.startsWith("/")) {
                const commandResult = await handleCommand(text, {
                    userId,
                    groupId,
                    isGroup,
                    isAdmin,
                    client,
                    config,
                    groupConfig,
                    cfg,
                });
                if (commandResult) return;
            }

            const senderName = event.sender?.nickname || String(userId);
            botContext.recordInteraction(userId, senderName, groupId);
            
            recordKnownUser({
                openid: String(userId),
                type: isGroup ? "group" : "private",
                nickname: senderName,
                groupId: isGroup ? groupId : undefined,
                accountId: account.accountId,
            });
            
            if (isGroup && config.autoMarkRead) {
                client.markGroupMsgAsRead(groupId);
            }
            
            if (isGroup && config.reactionEmoji && event.message_id) {
                try {
                    client.setGroupReaction(groupId, String(event.message_id), config.reactionEmoji);
                    console.log(`[QQ] 已回应表情: ${config.reactionEmoji}`);
                } catch (e) {
                    console.warn(`[QQ] 表情回应失败:`, e);
                }
            }

            const processedContext = botContext.processMessage(text, userId, groupId);
            const emotionInfo = processedContext.emotion;
            const personContext = processedContext.personContext;
            const knowledgeContext = processedContext.knowledgeContext;

            const chatId = isGroup ? `group:${groupId}` : `user:${userId}`;
            pluginManager.getChatSummary().recordMessage(chatId, String(userId), senderName, text);
            pluginManager.getDiaryManager().recordActivity(chatId, String(userId), senderName, text, emotionInfo?.emotion);
            
            const emotionForMemory = emotionInfo?.emotion !== 'neutral' ? emotionInfo?.emotion : undefined;
            if (emotionForMemory && emotionInfo?.intensity && emotionInfo.intensity > 0.5) {
              pluginManager.getMemoryManager().storeMemory(
                chatId,
                `[${senderName}] ${text}`,
                emotionInfo.intensity,
                emotionInfo.keywords || [],
                'chat'
              );
            }
            
            if ((config as any).autoSendEmoji === true && isGroup && emotionInfo && emotionInfo.emotion !== 'neutral') {
              const minIntensity = (config as any).autoSendEmojiMinIntensity ?? 0.5;
              const probability = (config as any).autoSendEmojiProbability ?? 0.3;
              
              if (emotionInfo.intensity >= minIntensity && Math.random() < probability) {
                try {
                  const emojiManager = getEmojiManager(cfg);
                  const emotionMap: Record<string, string> = {
                    happy: '开心 高兴 快乐',
                    sad: '难过 伤心 悲伤',
                    angry: '生气 愤怒 火大',
                    surprised: '惊讶 震惊 意外',
                    confused: '困惑 迷茫 不懂',
                    worried: '担心 焦虑 紧张',
                    love: '爱 喜欢 心动',
                    tired: '累 困 疲惫',
                    excited: '兴奋 激动 期待',
                  };
                  const emotionText = emotionMap[emotionInfo.emotion] || emotionInfo.emotion;
                  const emojiResult = await emojiManager.getEmojiForText(emotionText);
                  
                  if (emojiResult && emojiResult.path) {
                    const imageBuffer = fsSync.readFileSync(emojiResult.path);
                    const base64 = imageBuffer.toString("base64");
                    client.sendEmojiToGroup(groupId!, base64);
                    console.log(`[QQ] 🎭 根据情绪[${emotionInfo.emotion}]自动发表情包: ${emojiResult.description}`);
                  }
                } catch (e) {
                  console.warn("[QQ] 自动发表情包失败:", e);
                }
              }
            }
            
            if (config.enableUrlSummary !== false && /https?:\/\/[^\s]+/i.test(text)) {
              const urlPluginCtx: PluginContext = {
                userId,
                groupId,
                isGroup,
                text,
                senderName,
                config,
                client,
                cfg
              };
              const urlResult = await pluginManager.getUrlSummary().handle(urlPluginCtx);
              if (urlResult.handled && urlResult.response) {
                if (isGroup) {
                  client.sendGroupMsg(groupId!, urlResult.response);
                } else {
                  client.sendPrivateMsg(userId, urlResult.response);
                }
              }
            }

            if (!isGuild && isAdmin && text.trim().startsWith('/')) {
                const parts = text.trim().split(/\s+/);
                const cmd = parts[0];
                if (cmd === '/status') {
                    const stats = botContext.getStats();
                    const userStats = getKnownUsersStats(account.accountId);
                    const dataDir = getQQBotDataDir();
                    const version = getPackageVersion(import.meta.url);
                    const statusMsg = `[OpenClaw QQ] v${version}\n状态: 已连接\n机器人ID: ${client.getSelfId()}\n内存: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB\n用户档案: ${stats.persons}\n已知用户: ${userStats.totalUsers} (24h活跃: ${userStats.activeIn24h})\n数据目录: ${dataDir}`;
                    if (isGroup) client.sendGroupMsg(groupId, statusMsg); else client.sendPrivateMsg(userId, statusMsg);
                    return;
                }
                if (cmd === '/diagnostics' || cmd === '/diag') {
                    const diag = await runDiagnostics();
                    let diagMsg = `🔍 环境诊断\n平台: ${diag.platform}\nNode: ${diag.nodeVersion}\nffmpeg: ${diag.ffmpeg ?? "未安装"}\nsilk-wasm: ${diag.silkWasm ? "可用" : "不可用"}`;
                    if (diag.warnings.length > 0) {
                        diagMsg += `\n⚠️ 警告:\n${diag.warnings.join("\n")}`;
                    }
                    if (isGroup) client.sendGroupMsg(groupId, diagMsg); else client.sendPrivateMsg(userId, diagMsg);
                    return;
                }
                if (cmd === '/send' && parts.length >= 3) {
                    const target = parts[1];
                    const message = parts.slice(2).join(" ");
                    const result = await sendProactive({ to: target, text: message, accountId: account.accountId });
                    const sendMsg = result.success ? `✅ 已发送到 ${target}` : `❌ 发送失败: ${result.error}`;
                    if (isGroup) client.sendGroupMsg(groupId, sendMsg); else client.sendPrivateMsg(userId, sendMsg);
                    return;
                }
                if (cmd === '/broadcast' && parts.length >= 2) {
                    const message = parts.slice(1).join(" ");
                    const result = await broadcastToKnownUsers(message, { accountId: account.accountId, activeWithin: 7 * 24 * 60 * 60 * 1000 });
                    const bcMsg = `📢 广播完成: 成功 ${result.sent}, 失败 ${result.failed}`;
                    if (isGroup) client.sendGroupMsg(groupId, bcMsg); else client.sendPrivateMsg(userId, bcMsg);
                    return;
                }
                if (cmd === '/help') {
                    const helpMsg = `[OpenClaw QQ]\n/status - 状态\n/diagnostics - 环境诊断\n/send <目标> <消息> - 主动发送消息\n/broadcast <消息> - 广播给已知用户\n/mute @用户 [分] - 禁言\n/kick @用户 - 踢出\n/learn <模式> <替换> - 学习表达\n/help - 帮助`;
                    if (isGroup) client.sendGroupMsg(groupId, helpMsg); else client.sendPrivateMsg(userId, helpMsg);
                    return;
                }
                if (isGroup && (cmd === '/mute' || cmd === '/ban')) {
                    const targetMatch = text.match(/\[CQ:at,qq=(\d+)\]/);
                    const targetId = targetMatch ? parseInt(targetMatch[1]) : (parts[1] ? parseInt(parts[1]) : null);
                    if (targetId) {
                        client.setGroupBan(groupId, targetId, parts[2] ? parseInt(parts[2]) * 60 : 1800);
                        client.sendGroupMsg(groupId, `已禁言。`);
                    }
                    return;
                }
                if (isGroup && cmd === '/kick') {
                    const targetMatch = text.match(/\[CQ:at,qq=(\d+)\]/);
                    const targetId = targetMatch ? parseInt(targetMatch[1]) : (parts[1] ? parseInt(parts[1]) : null);
                    if (targetId) {
                        client.setGroupKick(groupId, targetId);
                        client.sendGroupMsg(groupId, `已踢出。`);
                    }
                    return;
                }
                if (cmd === '/learn' && parts.length >= 3) {
                    const pattern = parts[1];
                    const replacement = parts.slice(2).join(" ");
                    botContext.learnExpression(pattern, replacement, isGroup ? `group:${groupId}` : `private:${userId}`);
                    const learnMsg = `已学习表达: "${pattern}" -> "${replacement}"`;
                    if (isGroup) client.sendGroupMsg(groupId, learnMsg); else client.sendPrivateMsg(userId, learnMsg);
                    return;
                }
            }
            
            let repliedMsg: any = null;
            const replyMsgId = getReplyMessageId(event.message, text);
            if (replyMsgId) {
                try { repliedMsg = await client.getMsg(replyMsgId); } catch (err) {}
            }
            
            if (!repliedMsg && replyMsgId) {
                const refEntry = lookupRef(replyMsgId, account.accountId);
                if (refEntry) {
                    repliedMsg = {
                        message: refEntry.text,
                        raw_message: refEntry.text,
                        sender: { 
                            nickname: refEntry.sender, 
                            user_id: refEntry.senderId 
                        }
                    };
                    console.log(`[QQ] 📎 从引用索引找到回复消息: ${refEntry.text.substring(0, 50)}...`);
                }
            }
            
            if (event.message_id) {
                recordRef({
                    msgId: String(event.message_id),
                    text: text.substring(0, 500),
                    sender: event.sender?.nickname || String(userId),
                    senderId: String(userId),
                    timestamp: event.time * 1000,
                    accountId: account.accountId,
                });
            }
            
            let historyContext = "";
            if (isGroup && effectiveHistoryLimit !== 0) {
                 try {
                     const history = await client.getGroupMsgHistory(groupId);
                     if (history?.messages) {
                         const limit = effectiveHistoryLimit || 5;
                         historyContext = history.messages.slice(-(limit + 1), -1).map((m: any) => `${m.sender?.nickname || m.user_id}: ${cleanCQCodes(m.raw_message || "")}`).join("\n");
                     }
                 } catch (e) {}
            }

            let isTriggered = !isGroup || text.includes("[动作] 用户戳了你一下");
            if (!isTriggered && effectiveKeywordTriggers) {
                for (const kw of effectiveKeywordTriggers) { if (text.includes(kw)) { isTriggered = true; break; } }
            }
            
            const emojiRequestPatterns = [
                "发表情", "发个表情", "发个表情包", "来个表情", "来个表情包",
                "发表情包", "发张表情", "发张表情包", "来张表情", "来张表情包",
                "扔个表情", "扔个表情包", "丢个表情", "丢个表情包",
                "斗图", "来斗图", "表情包攻击", "表情攻击",
                "发个图", "来个图", "发张图", "来张图",
            ];
            let isEmojiRequest = false;
            for (const pattern of emojiRequestPatterns) {
                if (text.includes(pattern)) {
                    isEmojiRequest = true;
                    break;
                }
            }
            
            if (isEmojiRequest && isGroup) {
                try {
                    const emojiManager = getEmojiManager(cfg);
                    const emojiResult = await emojiManager.getEmojiForText(text);
                    if (emojiResult && emojiResult.path) {
                        const imageBuffer = fsSync.readFileSync(emojiResult.path);
                        const base64 = imageBuffer.toString("base64");
                        client.sendEmojiToGroup(groupId, base64);
                        console.log(`[QQ] 响应表情包请求: ${emojiResult.description}`);
                        return;
                    } else {
                        console.log(`[QQ] 没有找到合适的表情包`);
                        return;
                    }
                } catch (e) {
                    console.warn("[QQ] 表情包请求处理失败:", e);
                }
            }
            
            const checkMention = isGroup || isGuild;
            let mentioned = false;
            
            const effectiveSelfId = client.getSelfId() || event.self_id;
            console.log(`[QQ] 检查@提及: effectiveSelfId=${effectiveSelfId}, requireMention=${effectiveRequireMention}`);
            
            if (checkMention && Array.isArray(event.message)) {
                for (const s of event.message) {
                    if (s.type === "at") {
                        const atQq = String(s.data?.qq);
                        console.log(`[QQ] 发现@提及: at.qq=${atQq}, selfId=${effectiveSelfId}`);
                        if (atQq === String(effectiveSelfId) || atQq === "all") {
                            mentioned = true;
                            console.log(`[QQ] 检测到@机器人或@全体成员`);
                            break;
                        }
                    }
                }
            } else if (checkMention && text.includes(`[CQ:at,qq=`)) {
                const atMatch = text.match(/\[CQ:at,qq=(\d+)\]/);
                if (atMatch) {
                    const atQq = atMatch[1];
                    console.log(`[QQ] CQ码@提及: at.qq=${atQq}, selfId=${effectiveSelfId}`);
                    if (atQq === String(effectiveSelfId)) {
                        mentioned = true;
                        console.log(`[QQ] 检测到CQ码@机器人`);
                    }
                }
            }
            
            if (!mentioned && repliedMsg?.sender?.user_id === effectiveSelfId) {
                mentioned = true;
                console.log(`[QQ] 检测到回复机器人的消息`);
            }
            
            if (effectiveRequireMention && !mentioned && !isTriggered) {
                console.log(`[QQ] 需要提及但未检测到@，跳过消息`);
                return;
            }

            let fromId = String(userId);
            let conversationLabel = `QQ User ${userId}`;
            if (isGroup) {
                fromId = `group:${groupId}`;
                conversationLabel = `QQ Group ${groupId}`;
            } else if (isGuild) {
                fromId = `guild:${guildId}:${channelId}`;
                conversationLabel = `QQ Guild ${guildId} Channel ${channelId}`;
            }

            const messageQueueManager = getMessageQueueManager();
            
            const queueResult = messageQueueManager.enqueue(fromId, {
                chatId: fromId,
                userId,
                groupId: isGroup ? groupId : undefined,
                senderName: event.sender?.nickname || String(userId),
                text,
                timestamp: event.time * 1000,
                isMentioned: mentioned,
                event
            });

            console.log(`[QQ] 消息已记录到队列 (上下文获取)`);

            const dynamicTalkValue = messageQueueManager.getDynamicTalkValue(fromId, userId, effectiveTalkValue);

            if (isGroup && !mentioned && !isTriggered) {
                if (Math.random() > dynamicTalkValue) {
                    console.log(`[QQ] 群聊未@且概率未命中 (talkValue: ${dynamicTalkValue.toFixed(2)})，记录上下文但不回复`);
                    return;
                }
                console.log(`[QQ] 自动触发回复 (talkValue: ${dynamicTalkValue.toFixed(2)})`);
            }
            
            console.log(`[QQ] 准备生成回复: mentioned=${mentioned}, isTriggered=${isTriggered}`);

            if (queueResult.cancelledMessages.length > 0) {
                console.log(`[QQ] 🔄 @消息优先处理，取消 ${queueResult.cancelledMessages.length} 条队列消息`);
            }

            if (!queueResult.shouldProcess) {
                console.log(`[QQ] 消息已加入队列，等待处理`);
                return;
            }

            const queueContext = queueResult.contextMessages.length > 0 
                ? queueResult.contextMessages.map(m => `[${m.senderName}(${m.userId})]: ${m.text}`).join('\n')
                : '';

            const abortController = messageQueueManager.startProcessing(fromId);

            setCurrentMessageContext({
                userId,
                groupId: isGroup ? groupId : undefined,
                senderName: event.sender?.nickname || String(userId),
                isGroup,
                isPrimary: isGroup ? isPrimaryGroup(config, groupId!) : false,
                accountId: account.accountId,
                timestamp: event.time * 1000,
            });

            let pfcReasoning: string | undefined;
            let pfcActionMessage: string | undefined;
            try {
                const pfcLlmCall = async (prompt: string): Promise<string> => {
                    const runtime = getQQRuntime();
                    const cfg = runtime.config.loadConfig() as any;
                    const providers = getProviders(cfg);
                    const plannerTaskConfig = getModelTaskConfig(cfg, "planner");
                    
                    if (!plannerTaskConfig || !plannerTaskConfig.models?.length) {
                        console.warn("[QQ] PFC未配置planner模型任务");
                        return "";
                    }
                    
                    const result = await callWithModelRotation(providers, plannerTaskConfig, {
                        messages: [{ role: "user", content: prompt }],
                        maxTokens: 512,
                        temperature: 0.3,
                        timeout: 30000
                    });
                    
                    if (!result.success) {
                        console.warn(`[QQ] PFC所有模型调用失败: ${result.error}`);
                        return "";
                    }
                    
                    console.log(`[QQ] PFC使用模型: ${result.provider}/${result.model}`);
                    return result.content || "";
                };
                
                const pfcResult = await botContext.planReply(
                    fromId,
                    [{
                        content: text,
                        senderId: String(userId),
                        senderName: event.sender?.nickname || String(userId),
                        timestamp: event.time * 1000,
                        isMentioned: mentioned,
                    }],
                    mentioned || isTriggered,
                    pfcLlmCall
                );
                pfcReasoning = pfcResult.reasoning;
                pfcActionMessage = pfcResult.actionMessage;
                console.log(`[QQ] PFC决策: shouldReply=${pfcResult.shouldReply}, reasoning=${pfcReasoning?.substring(0, 50)}...`);
            } catch (e) {
                console.warn("[QQ] PFC决策失败:", e);
            }

            const sentMessages = new Set<string>();
            let lastDeliverTime = 0;
            const DELIVER_COOLDOWN_MS = 1000;

            const baseDeliver = async (payload: ReplyPayload) => {
                 const now = Date.now();
                 if (now - lastDeliverTime < DELIVER_COOLDOWN_MS) {
                     console.log(`[QQ] ⚠️ 检测到重复发送请求，跳过 (间隔: ${now - lastDeliverTime}ms)`);
                     return;
                 }
                 lastDeliverTime = now;
                 
                 console.log(`[QQ] 🦞 龙虾核心已生成回复，准备发送到QQ: ${payload.text?.substring(0, 100)}...`);
                 
                 const send = async (msg: string) => {
                     let processed = msg;
                     if (config.formatMarkdown) processed = stripMarkdown(processed);
                     if (config.antiRiskMode) processed = processAntiRisk(processed);
                     
                     const segmentation = pluginManager.getSmartSegmentation();
                     
                     console.log(`[QQ] 📊 开始分段处理, 原始长度: ${processed.length}`);
                     
                     let segments: string[] = [];
                     if (config.enableSmartSegmentationLLM) {
                       try {
                         const llmCall = async (prompt: string): Promise<string> => {
                           const providers = getProviders(cfg);
                           const taskConfig = getModelTaskConfig(cfg, "utils");
                           if (taskConfig && taskConfig.models?.length) {
                             const result = await callWithModelRotation(providers, taskConfig, {
                               messages: [{ role: "user", content: prompt }],
                               maxTokens: 512,
                               temperature: 0.3,
                               timeout: 15000
                             });
                             return result.success ? (result.content || "") : "";
                           }
                           return "";
                         };
                         segments = await segmentation.segmentWithLLM(processed, llmCall);
                       } catch (e) {
                         console.warn("[QQ] 智能分段LLM调用失败:", e);
                         segments = segmentation.segment(processed);
                       }
                     } else {
                       segments = segmentation.segment(processed);
                     }
                     
                     if (segments.length === 0) {
                       console.log(`[QQ] ⏭️ 分段结果为空，跳过发送`);
                       return;
                     }
                     
                     console.log(`[QQ] 🔪 分段完成，共 ${segments.length} 段`);
                     
                     for (let segIdx = 0; segIdx < segments.length; segIdx++) {
                       const segment = segments[segIdx];
                       
                       const segmentKey = segment.trim().toLowerCase();
                       if (sentMessages.has(segmentKey)) {
                         console.log(`[QQ] ⏭️ 检测到重复分段，跳过: ${segment.substring(0, 30)}...`);
                         continue;
                       }
                       sentMessages.add(segmentKey);
                       
                       const chunks = splitMessage(segment, config.maxMessageLength || 4000);
                       
                       for (let i = 0; i < chunks.length; i++) {
                         let chunk = chunks[i];
                         if (isGroup && segIdx === 0 && i === 0) chunk = `[CQ:at,qq=${userId}] ${chunk}`;
                         
                         console.log(`[QQ] 📤 发送消息到QQ: ${isGroup ? `群${groupId}` : `用户${userId}`}, 内容: ${chunk.substring(0, 50)}...`);
                         
                         if (isGroup) client.sendGroupMsg(groupId, chunk);
                         else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, chunk);
                         else client.sendPrivateMsg(userId, chunk);
                         
                         console.log(`[QQ] ✅ 消息已发送到QQ ${isGroup ? '群聊' : '私聊'}`);
                         
                         if (!isGuild && config.enableTTS && i === 0 && chunk.length < 100) {
                             const tts = chunk.replace(/\[CQ:.*?\]/g, "").trim();
                             if (tts) { 
                                 if (isGroup) client.sendGroupMsg(groupId, `[CQ:tts,text=${tts}]`); 
                                 else client.sendPrivateMsg(userId, `[CQ:tts,text=${tts}]`); 
                             }
                         }
                         
                         if (chunks.length > 1 && config.rateLimitMs > 0) await sleep(config.rateLimitMs);
                       }
                       
                       if (segments.length > 1 && config.rateLimitMs > 0) {
                         await sleep(config.rateLimitMs);
                       }
                     }
                 };
                 if (payload.text) await send(payload.text);
                   if ((payload as any).files) {
                     for (const f of (payload as any).files || []) { 
                         if (f.url) { 
                             const url = await resolveMediaUrl(f.url);
                             if (isImageFile(url)) {
                                 if (isGroup) client.sendImageUrlToGroup(groupId, url);
                                 else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, `[CQ:image,file=${url}]`);
                                 else client.sendImageUrlToPrivate(userId, url);
                             } else {
                                 const txtMsg = `[CQ:file,file=${url},name=${f.name || 'file'}]`;
                                 if (isGroup) client.sendGroupMsg(groupId, txtMsg);
                                 else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, `[文件] ${url}`);
                                 else client.sendPrivateMsg(userId, txtMsg);
                             }
                             if (config.rateLimitMs > 0) await sleep(config.rateLimitMs);
                         } 
                     }
                 }
            };

            const deliverDebouncer = createDeliverDebouncer(
                config.deliverDebounce,
                baseDeliver,
                { info: console.log, error: console.error },
                "[QQ debounce]"
            );
            
            const deliver = deliverDebouncer 
                ? (payload: ReplyPayload) => deliverDebouncer.deliver(payload, { kind: "reply" })
                : baseDeliver;

            const { dispatcher, replyOptions } = runtime.channel.reply.createReplyDispatcherWithTyping({ deliver });

            let replyToBody = "";
            let replyToSender = "";
            if (replyMsgId && repliedMsg) {
                replyToBody = cleanCQCodes(typeof repliedMsg.message === 'string' ? repliedMsg.message : repliedMsg.raw_message || '');
                replyToSender = repliedMsg.sender?.nickname || repliedMsg.sender?.card || String(repliedMsg.sender?.user_id || '');
            }

            const replySuffix = replyToBody ? `\n\n[Replying to ${replyToSender || "unknown"}]\n${replyToBody}\n[/Replying]` : "";
            let bodyWithReply = cleanCQCodes(text) + replySuffix;
            let systemBlock = "";
            
            const senderInfo = `<sender>\nQQ号: ${userId}\n昵称: ${event.sender?.nickname || "Unknown"}\n${isGroup ? `群号: ${groupId}\n群名片: ${event.sender?.card || "无"}\n` : ''}是否@: ${mentioned ? '是' : '否'}\n</sender>\n\n`;
            systemBlock += senderInfo;
            
            if (isGroup) {
                const groupInfo = `<chat_info>\n类型: 群聊\n群号: ${groupId}\n${groupConfig?.name ? `群名: ${groupConfig.name}\n` : ''}是否主群: ${isPrimary ? '是' : '否'}\n</chat_info>\n\n`;
                systemBlock += groupInfo;
            }
            
            if (queueContext) {
                systemBlock += `<queue_context>\n${queueContext}\n</queue_context>\n\n`;
            }
            
            if (effectiveSystemPrompt) systemBlock += `<system>${effectiveSystemPrompt}</system>\n\n`;
            if (isPrimary) systemBlock += `<primary_group>这是主群消息，请优先认真回复。</primary_group>\n\n`;
            if (historyContext) systemBlock += `<history>\n${historyContext}\n</history>\n\n`;
            if (personContext) systemBlock += `<person>\n${personContext}\n</person>\n\n`;
            if (knowledgeContext) systemBlock += `<knowledge>\n${knowledgeContext}\n</knowledge>\n\n`;
            if (emotionInfo && emotionInfo.emotion !== "neutral" && emotionInfo.intensity > 0.3) {
                systemBlock += `<emotion>\n用户情感: ${emotionInfo.emotion} (强度: ${(emotionInfo.intensity * 100).toFixed(0)}%)\n关键词: ${emotionInfo.keywords.join(", ")}\n`;
                const emotionEmoji = getEmojiForEmotion(emotionInfo.emotion);
                if (emotionEmoji) systemBlock += `情感表情: ${emotionEmoji}\n`;
                const replyStyle = getReplyStyleSuggestion(emotionInfo);
                if (replyStyle) systemBlock += `建议回复风格: ${replyStyle}\n`;
                systemBlock += `</emotion>\n\n`;
            }
            if (pfcReasoning) {
                systemBlock += `<pfc_decision>\n决策推理: ${pfcReasoning}\n`;
                if (pfcActionMessage) systemBlock += `建议回复方向: ${pfcActionMessage}\n`;
                systemBlock += `</pfc_decision>\n\n`;
            }
            bodyWithReply = systemBlock + bodyWithReply;

            const ctxPayload = runtime.channel.reply.finalizeInboundContext({
                Provider: "qq", Channel: "qq", From: fromId, To: "qq:bot", Body: bodyWithReply, RawBody: text,
                SenderId: String(userId), SenderName: event.sender?.nickname || "Unknown", ConversationLabel: conversationLabel,
                SessionKey: `qq:${fromId}`, AccountId: account.accountId, ChatType: isGroup ? "group" : isGuild ? "channel" : "direct", Timestamp: event.time * 1000,
                OriginatingChannel: "qq", OriginatingTo: fromId, CommandAuthorized: true,
                ...(extractImageUrls(event.message).length > 0 && { MediaUrls: extractImageUrls(event.message) }),
                ...(replyMsgId && { ReplyToId: replyMsgId, ReplyToBody: replyToBody, ReplyToSender: replyToSender }),
            });
            
            console.log(`[QQ] 会话上下文: SessionKey=${ctxPayload.SessionKey}, From=${fromId}, ChatType=${ctxPayload.ChatType}`);
            
            await runtime.channel.session.recordInboundSession({
                storePath: runtime.channel.session.resolveStorePath(cfg.session?.store, { agentId: "default" }),
                sessionKey: ctxPayload.SessionKey!, ctx: ctxPayload,
                updateLastRoute: { sessionKey: ctxPayload.SessionKey!, channel: "qq", to: fromId, accountId: account.accountId },
                onRecordError: (err) => console.error("QQ Session Error:", err)
            });
            
            console.log(`[QQ] ✅ 会话已记录到存储，网页端应可实时查看: SessionKey=${ctxPayload.SessionKey}`);

            console.log(`[QQ] 开始生成回复, useCustomModelCaller=${config.useCustomModelCaller}`);
            console.log(`[QQ] 🦞 消息已发送到龙虾核心，等待AI生成回复...`);

            const typingKeepAlive = config.enableTypingIndicator !== false 
                ? new TypingKeepAlive(client, isGroup, groupId, userId)
                : null;
            typingKeepAlive?.start();

            try {
                const useCustomReply = config.useCustomModelCaller === true;
                
                if (useCustomReply) {
                    const replyerTaskConfig = getModelTaskConfig(cfg, "replyer");
                    const providers = getProviders(cfg);
                    
                    if (replyerTaskConfig && replyerTaskConfig.models?.length) {
                        console.log(`[QQ] 使用自定义模型轮播生成回复，共 ${replyerTaskConfig.models.length} 个模型`);
                        
                        const result = await callWithModelRotation(providers, replyerTaskConfig, {
                            messages: [{ role: "user", content: bodyWithReply }],
                            maxTokens: replyerTaskConfig.maxTokens || 1024,
                            temperature: replyerTaskConfig.temperature ?? 0.7,
                        });
                        
                        if (result.success && result.content) {
                            console.log(`[QQ] 🦞 龙虾核心回复生成成功: ${result.provider}/${result.model}, 内容长度=${result.content.length}`);
                            await deliver({ text: result.content });
                        } else {
                            console.warn(`[QQ] 回复生成失败: ${result.error}`);
                            if (config.enableErrorNotify) {
                                await deliver({ text: "⚠️ 模型调用失败，请稍后重试。" });
                            }
                        }
                    } else {
                        console.warn("[QQ] 未配置replyer模型任务，回退到核心回复");
                        console.log(`[QQ] 🦞 调用龙虾核心回复分发器...`);
                        await runtime.channel.reply.dispatchReplyFromConfig({ ctx: ctxPayload, cfg, dispatcher, replyOptions });
                    }
                } else {
                    console.log(`[QQ] 🦞 调用龙虾核心回复分发器...`);
                    await runtime.channel.reply.dispatchReplyFromConfig({ ctx: ctxPayload, cfg, dispatcher, replyOptions });
                }
            } catch (error) {
                console.error("[QQ] 回复生成错误:", error);
                if (config.enableErrorNotify) deliver({ text: "⚠️ 服务调用失败，请稍后重试。" });
            } finally {
                typingKeepAlive?.stop();
                messageQueueManager.finishProcessing(fromId, userId);
            }
            
            console.log(`[QQ] 🎉 消息处理完成，网页端对话记录已更新`);
          } catch (err) {
            console.error("[QQ] Critical error in message handler:", err);
          }
        });

        let resolveStartAccount: ((cleanup: () => void) => void) | null = null;
        const cleanupFn = () => { 
            clearInterval(cleanupInterval);
            client.disconnect(); 
            unregisterQQClient(account.accountId);
            clearMemberCache();
            flushRefIndex();
            flushKnownUsers();
            console.log(`[QQ] 🧹 账号 ${account.accountId} 已停止，缓存已清理`);
        };
        
        if (connectionConfig.mode === "reverse") {
            console.log(`[QQ] ⏳ 反向WebSocket模式，服务器已启动，立即返回成功`);
            client.connect();
            return cleanupFn;
        }

        client.connect();
        return cleanupFn;
    },
    logoutAccount: async ({ accountId, cfg }) => {
        return { loggedOut: true, cleared: true };
    }
  },
  outbound: {
    sendText: async ({ to, text, accountId, ...rest }) => {
        console.log(`[QQ] 📤 outbound.sendText 被调用: to=${to}, accountId=${accountId}, text长度=${text?.length || 0}`);
        const replyTo = (rest as any).replyTo;
        const client = getQQClient(accountId || DEFAULT_ACCOUNT_ID);
        if (!client) {
          console.error(`[QQ] ❌ outbound.sendText 失败: Client not connected (accountId=${accountId})`);
          return { channel: "qq", sent: false, error: "Client not connected", messageId: undefined };
        }
        console.log(`[QQ] ✅ Client 已获取, isConnected=${client.isConnected()}`);
        
        const segmentation = pluginManager.getSmartSegmentation();
        console.log(`[QQ] 📊 outbound 开始分段处理, 原始长度: ${text?.length || 0}`);
        
        let segments: string[] = [];
        try {
          segments = segmentation.segment(text);
        } catch (e) {
          console.warn("[QQ] outbound 分段失败，使用原始文本:", e);
          segments = [text];
        }
        
        if (segments.length === 0) {
          console.log(`[QQ] ⏭️ outbound 分段结果为空，跳过发送`);
          return { channel: "qq", sent: false, error: "Empty segments", messageId: undefined };
        }
        
        console.log(`[QQ] 🔪 outbound 分段完成，共 ${segments.length} 段`);
        
        let lastMessageId: string | undefined;
        let sentCount = 0;
        let failedCount = 0;
        
        for (let segIdx = 0; segIdx < segments.length; segIdx++) {
            const segment = segments[segIdx];
            console.log(`[QQ] 📤 处理分段 ${segIdx + 1}/${segments.length}: ${segment.substring(0, 50)}...`);
            
            const chunks = splitMessage(segment, 4000);
            console.log(`[QQ] 📤 分段 ${segIdx + 1} 拆分为 ${chunks.length} 个 chunk(s)`);
            
            for (let i = 0; i < chunks.length; i++) {
              let message: OneBotMessage | string = chunks[i];
              if (replyTo && segIdx === 0 && i === 0) {
                message = [ { type: "reply", data: { id: String(replyTo) } }, { type: "text", data: { text: chunks[i] } } ];
              }
              
              console.log(`[QQ] 📤 发送 chunk ${i + 1}/${chunks.length} (分段 ${segIdx + 1}/${segments.length})`);
              
              try {
                if (to.startsWith("group:")) {
                  const groupId = parseInt(to.replace("group:", ""), 10);
                  console.log(`[QQ] 📤 调用 sendGroupMsg: groupId=${groupId}`);
                  client.sendGroupMsg(groupId, message);
                  sentCount++;
                }
                else if (to.startsWith("guild:")) {
                    const parts = to.split(":");
                    if (parts.length >= 3) {
                      console.log(`[QQ] 📤 调用 sendGuildChannelMsg: guildId=${parts[1]}, channelId=${parts[2]}`);
                      client.sendGuildChannelMsg(parts[1], parts[2], message);
                      sentCount++;
                    }
                }
                else {
                  const userId = parseInt(to, 10);
                  console.log(`[QQ] 📤 调用 sendPrivateMsg: userId=${userId}`);
                  client.sendPrivateMsg(userId, message);
                  sentCount++;
                }
              } catch (err) {
                console.error(`[QQ] ❌ 发送失败: ${err}`);
                failedCount++;
              }
              
              if (chunks.length > 1) await sleep(1000); 
            }
            
            if (segments.length > 1) await sleep(500);
        }
        
        console.log(`[QQ] ✅ outbound.sendText 完成: to=${to}, 发送=${sentCount}, 失败=${failedCount}`);
        return { channel: "qq", sent: sentCount > 0, messageId: lastMessageId };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, ...rest }) => {
         console.log(`[QQ] 📤 outbound.sendMedia 被调用: to=${to}, accountId=${accountId}, mediaUrl=${mediaUrl?.substring(0, 50)}`);
         const replyTo = (rest as any).replyTo;
         const client = getQQClient(accountId || DEFAULT_ACCOUNT_ID);
         if (!client) {
           console.error(`[QQ] ❌ outbound.sendMedia 失败: Client not connected (accountId=${accountId})`);
           return { channel: "qq", sent: false, error: "Client not connected", messageId: undefined };
         }
         
         const finalUrl = await resolveMediaUrl(mediaUrl);
         console.log(`[QQ] 📤 媒体URL已解析: ${finalUrl.substring(0, 80)}...`);
         
         const message: OneBotMessage = [];
         if (replyTo) message.push({ type: "reply", data: { id: String(replyTo) } });
         if (text) message.push({ type: "text", data: { text } });
         if (isImageFile(mediaUrl)) {
           message.push({ type: "image", data: { file: finalUrl } });
           console.log(`[QQ] 📤 添加图片消息段`);
         }
         else {
           message.push({ type: "text", data: { text: `[CQ:file,file=${finalUrl},url=${finalUrl}]` } });
           console.log(`[QQ] 📤 添加文件消息段`);
         }
         
         if (to.startsWith("group:")) {
           const groupId = parseInt(to.replace("group:", ""), 10);
           console.log(`[QQ] 📤 调用 sendGroupMsg (media): groupId=${groupId}`);
           client.sendGroupMsg(groupId, message);
         }
         else if (to.startsWith("guild:")) {
             const parts = to.split(":");
             if (parts.length >= 3) {
               console.log(`[QQ] 📤 调用 sendGuildChannelMsg (media): guildId=${parts[1]}, channelId=${parts[2]}`);
               client.sendGuildChannelMsg(parts[1], parts[2], message);
             }
         }
         else {
           const userId = parseInt(to, 10);
           console.log(`[QQ] 📤 调用 sendPrivateMsg (media): userId=${userId}`);
           client.sendPrivateMsg(userId, message);
         }
         console.log(`[QQ] ✅ outbound.sendMedia 完成: to=${to}`);
         return { channel: "qq", sent: true, messageId: undefined };
    },
    // @ts-ignore
    deleteMessage: async ({ messageId, accountId }) => {
        const client = getQQClient(accountId || DEFAULT_ACCOUNT_ID);
        if (!client) return { channel: "qq", success: false, error: "Client not connected" };
        try { client.deleteMsg(messageId); return { channel: "qq", success: true }; }
        catch (err) { return { channel: "qq", success: false, error: String(err) }; }
    }
  },
  messaging: { 
      normalizeTarget,
      targetResolver: {
          looksLikeId: (id) => /^\d{5,12}$/.test(id) || /^guild:/.test(id),
          hint: "QQ号, 群号 (group:123), 或频道 (guild:id:channel)",
      }
  }
};