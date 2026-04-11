import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { qqChannel } from "./src/channel.js";
import { setQQRuntime } from "./src/runtime.js";
import { getQQClient, initQQClientManager } from "./src/client.js";
import { getEmojiManager } from "./src/core/emoji/emojiManager.js";
import { getCurrentMessageContext } from "./src/messageContext.js";
import { getPersonInfoManager } from "./src/core/person/personInfoManager.js";
import { sendProactive, broadcastToKnownUsers, listKnownUsers, getKnownUsersStats } from "./src/proactive.js";
import { runDiagnostics } from "./src/utils/platform.js";
import { getPackageVersion } from "./src/utils/pkg-version.js";
import { getRecentLogs } from "./src/log-buffer.js";
import { getUpdateInfo } from "./src/update-checker.js";

function registerQQTools(api: OpenClawPluginApi) {
  api.registerTool({
    name: "qq_group_ban",
    label: "QQ群禁言",
    description: "在QQ群中禁言指定用户。禁言时间1-5分钟，不需要管理员确认。只有在主群才能使用此功能。如果不指定user_id，则禁言当前对话的用户。",
    parameters: Type.Object({
      user_id: Type.Optional(Type.Number({ description: "要禁言的用户ID（不填则禁言当前用户）" })),
      duration: Type.Number({ description: "禁言时长（秒），范围60-300秒（1-5分钟）", minimum: 60, maximum: 300, default: 60 }),
    }),
    async execute(_toolCallId, params) {
      const client = getQQClient("default");
      if (!client) {
        return { content: [{ type: "text", text: "QQ客户端未连接" }], details: { success: false } };
      }
      
      const ctx = getCurrentMessageContext();
      if (!ctx || !ctx.isGroup) {
        return { content: [{ type: "text", text: "当前不在群聊环境中，无法禁言" }], details: { success: false } };
      }
      
      if (!ctx.isPrimary) {
        return { content: [{ type: "text", text: "⚠️ 权限不足：禁言功能仅在主群可用" }], details: { success: false, reason: "not_primary_group" } };
      }
      
      const targetUserId = params.user_id || ctx.userId;
      const duration = Math.min(Math.max(params.duration, 60), 300);
      
      try {
        await client.setGroupBan(ctx.groupId!, targetUserId, duration);
        return { 
          content: [{ type: "text", text: `已将用户 ${targetUserId} 在群 ${ctx.groupId} 禁言 ${duration} 秒` }], 
          details: { success: true, group_id: ctx.groupId, user_id: targetUserId, duration } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `禁言失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_group_kick",
    label: "QQ群踢人",
    description: "将指定用户踢出QQ群。此操作需要管理员确认后才会执行。只有在主群才能使用此功能。如果不指定user_id，则踢出当前对话的用户。",
    parameters: Type.Object({
      user_id: Type.Optional(Type.Number({ description: "要踢出的用户ID（不填则踢出当前用户）" })),
      reason: Type.Optional(Type.String({ description: "踢人原因" })),
    }),
    async execute(_toolCallId, params) {
      const ctx = getCurrentMessageContext();
      if (!ctx || !ctx.isGroup) {
        return { content: [{ type: "text", text: "当前不在群聊环境中，无法踢人" }], details: { success: false } };
      }
      
      if (!ctx.isPrimary) {
        return { content: [{ type: "text", text: "⚠️ 权限不足：踢人功能仅在主群可用" }], details: { success: false, reason: "not_primary_group" } };
      }
      
      const targetUserId = params.user_id || ctx.userId;
      
      return { 
        content: [{ 
          type: "text", 
          text: `【需要管理员确认】请求将用户 ${targetUserId} 踢出群 ${ctx.groupId}。原因: ${params.reason || '未提供'}。请管理员确认后执行。` 
        }], 
        details: { success: false, needsApproval: true, group_id: ctx.groupId, user_id: targetUserId, reason: params.reason } 
      };
    },
  });

  api.registerTool({
    name: "qq_send_poke",
    label: "QQ戳一戳",
    description: "戳一戳指定用户。如果不指定user_id，则戳当前对话的用户。龙虾可以自行决定是否戳回去。",
    parameters: Type.Object({
      user_id: Type.Optional(Type.Number({ description: "要戳的用户ID（不填则戳当前用户）" })),
    }),
    async execute(_toolCallId, params) {
      const client = getQQClient("default");
      if (!client) {
        return { content: [{ type: "text", text: "QQ客户端未连接" }], details: { success: false } };
      }
      
      const ctx = getCurrentMessageContext();
      if (!ctx || !ctx.isGroup) {
        return { content: [{ type: "text", text: "当前不在群聊环境中，无法戳一戳" }], details: { success: false } };
      }
      
      const targetUserId = params.user_id || ctx.userId;
      
      try {
        await client.sendGroupPoke(ctx.groupId!, targetUserId);
        return { 
          content: [{ type: "text", text: `已戳一戳用户 ${targetUserId}` }], 
          details: { success: true, group_id: ctx.groupId, user_id: targetUserId } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `戳一戳失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_send_emoji",
    label: "QQ发送表情包",
    description: "发送表情包到当前群聊。龙虾可以自行决定是否发送表情包。",
    parameters: Type.Object({
      emoji_path: Type.String({ description: "表情包文件路径" }),
    }),
    async execute(_toolCallId, params) {
      const client = getQQClient("default");
      if (!client) {
        return { content: [{ type: "text", text: "QQ客户端未连接" }], details: { success: false } };
      }
      
      const ctx = getCurrentMessageContext();
      if (!ctx || !ctx.isGroup) {
        return { content: [{ type: "text", text: "当前不在群聊环境中，无法发送表情包" }], details: { success: false } };
      }
      
      try {
        const fs = await import("fs");
        const imageBuffer = fs.readFileSync(params.emoji_path);
        const base64 = imageBuffer.toString("base64");
        await client.sendEmojiToGroup(ctx.groupId!, base64);
        return { 
          content: [{ type: "text", text: `已发送表情包` }], 
          details: { success: true, group_id: ctx.groupId, emoji_path: params.emoji_path } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `发送表情包失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_send_emoji_by_emotion",
    label: "QQ根据情感发送表情包",
    description: "根据情感描述自动选择并发送表情包到当前群聊。龙虾可以根据当前对话的情感氛围选择合适的表情包。",
    parameters: Type.Object({
      emotion: Type.String({ description: "情感描述，如：开心、无奈、嘲讽、疑惑、惊讶等" }),
    }),
    async execute(_toolCallId, params) {
      const client = getQQClient("default");
      if (!client) {
        return { content: [{ type: "text", text: "QQ客户端未连接" }], details: { success: false } };
      }
      
      const ctx = getCurrentMessageContext();
      if (!ctx || !ctx.isGroup) {
        return { content: [{ type: "text", text: "当前不在群聊环境中，无法发送表情包" }], details: { success: false } };
      }
      
      try {
        const emojiManager = getEmojiManager();
        const emoji = await emojiManager.getEmojiForText(params.emotion);
        
        if (!emoji) {
          return { 
            content: [{ type: "text", text: `没有找到匹配"${params.emotion}"情感的表情包` }], 
            details: { success: false, emotion: params.emotion } 
          };
        }

        const fs = await import("fs");
        const imageBuffer = fs.readFileSync(emoji.path);
        const base64 = imageBuffer.toString("base64");
        await client.sendEmojiToGroup(ctx.groupId!, base64);
        
        return { 
          content: [{ type: "text", text: `已发送表情包：${emoji.description}` }], 
          details: { success: true, group_id: ctx.groupId, emotion: params.emotion, emoji_description: emoji.description } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `发送表情包失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_list_emojis",
    label: "QQ列出表情包",
    description: "列出当前可用的表情包及其描述。龙虾可以查看有哪些表情包可以使用。",
    parameters: Type.Object({
      count: Type.Optional(Type.Number({ description: "返回数量，默认10个", default: 10 })),
    }),
    async execute(_toolCallId, params) {
      try {
        const emojiManager = getEmojiManager();
        const emojis = await emojiManager.getRandom(params.count || 10);
        
        if (emojis.length === 0) {
          return { 
            content: [{ type: "text", text: "当前没有可用的表情包" }], 
            details: { success: true, emojis: [] } 
          };
        }

        const emojiList = emojis.map((e, i) => `${i + 1}. ${e.description} (情感: ${e.emotion})`).join("\n");
        return { 
          content: [{ type: "text", text: `当前可用表情包:\n${emojiList}` }], 
          details: { success: true, count: emojis.length, emojis } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `获取表情包列表失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_get_emoji_stats",
    label: "QQ表情包统计",
    description: "获取表情包存储统计信息。",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      try {
        const emojiManager = getEmojiManager();
        const stats = emojiManager.getStats();
        return { 
          content: [{ type: "text", text: `表情包统计: ${stats.total}/${stats.max} 个` }], 
          details: { success: true, stats } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `获取统计失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_send_image",
    label: "QQ发送图片",
    description: "发送图片到当前群聊或私聊。龙虾可以自行决定是否发送图片。",
    parameters: Type.Object({
      image_url: Type.String({ description: "图片URL或本地路径" }),
    }),
    async execute(_toolCallId, params) {
      const client = getQQClient("default");
      if (!client) {
        return { content: [{ type: "text", text: "QQ客户端未连接" }], details: { success: false } };
      }
      
      const ctx = getCurrentMessageContext();
      if (!ctx) {
        return { content: [{ type: "text", text: "无法获取当前消息上下文" }], details: { success: false } };
      }
      
      try {
        if (ctx.isGroup) {
          await client.sendImageUrlToGroup(ctx.groupId!, params.image_url);
        } else {
          await client.sendImageUrlToPrivate(ctx.userId, params.image_url);
        }
        return { 
          content: [{ type: "text", text: `已发送图片` }], 
          details: { success: true, image_url: params.image_url } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `发送图片失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_send_file",
    label: "QQ发送文件",
    description: "发送文件到当前群聊。龙虾可以自行决定是否发送文件。",
    parameters: Type.Object({
      file_url: Type.String({ description: "文件URL或本地路径" }),
      file_name: Type.Optional(Type.String({ description: "文件名" })),
    }),
    async execute(_toolCallId, params) {
      const client = getQQClient("default");
      if (!client) {
        return { content: [{ type: "text", text: "QQ客户端未连接" }], details: { success: false } };
      }
      
      const ctx = getCurrentMessageContext();
      if (!ctx || !ctx.isGroup) {
        return { content: [{ type: "text", text: "当前不在群聊环境中，无法发送文件" }], details: { success: false } };
      }
      
      try {
        const fileName = params.file_name || params.file_url.split("/").pop() || "file";
        const message = `[CQ:file,file=${params.file_url},name=${fileName}]`;
        await client.sendGroupMsg(ctx.groupId!, message);
        return { 
          content: [{ type: "text", text: `已发送文件: ${fileName}` }], 
          details: { success: true, group_id: ctx.groupId, file_url: params.file_url } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `发送文件失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_get_context",
    label: "QQ获取当前上下文",
    description: "获取当前消息的上下文信息，包括用户ID、群号、是否主群等。龙虾可以在需要时查看当前对话环境。",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const ctx = getCurrentMessageContext();
      if (!ctx) {
        return { 
          content: [{ type: "text", text: "无法获取当前消息上下文" }], 
          details: { success: false } 
        };
      }
      
      const info = ctx.isGroup 
        ? `当前环境: 群聊\n群号: ${ctx.groupId}\n用户ID: ${ctx.userId}\n用户名: ${ctx.senderName}\n是否主群: ${ctx.isPrimary ? '是' : '否'}`
        : `当前环境: 私聊\n用户ID: ${ctx.userId}\n用户名: ${ctx.senderName}`;
      
      return { 
        content: [{ type: "text", text: info }], 
        details: { success: true, context: ctx } 
      };
    },
  });

  api.registerTool({
    name: "qq_send_proactive",
    label: "QQ主动发送消息",
    description: "主动发送消息到指定用户或群组，无需等待用户触发。龙虾可以主动联系用户。",
    parameters: Type.Object({
      to: Type.String({ description: "目标ID，格式：私聊用QQ号，群聊用 group:群号" }),
      text: Type.String({ description: "要发送的消息内容" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await sendProactive({ to: params.to, text: params.text });
        return { 
          content: [{ type: "text", text: result.success ? `消息已发送到 ${params.to}` : `发送失败: ${result.error}` }], 
          details: { success: result.success, error: result.error } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `发送失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_broadcast",
    label: "QQ广播消息",
    description: "向所有已知用户或群组广播消息。龙虾可以群发通知。",
    parameters: Type.Object({
      text: Type.String({ description: "要广播的消息内容" }),
      type: Type.Optional(Type.Union([Type.Literal("private"), Type.Literal("group")])),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await broadcastToKnownUsers(params.text, { type: params.type as any });
        return { 
          content: [{ type: "text", text: `广播完成: 成功 ${result.sent}，失败 ${result.failed}` }], 
          details: { success: true, sent: result.sent, failed: result.failed } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `广播失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_get_known_users",
    label: "QQ获取已知用户",
    description: "获取已知用户列表统计信息。",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      try {
        const stats = getKnownUsersStats();
        return { 
          content: [{ type: "text", text: `已知用户统计: 总计 ${stats.totalUsers} 人，私聊 ${stats.privateUsers}，群聊 ${stats.groupUsers}，24h活跃 ${stats.activeIn24h}` }], 
          details: { success: true, stats } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `获取失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_diagnostics",
    label: "QQ环境诊断",
    description: "运行QQ插件环境诊断，检查ffmpeg、silk-wasm等依赖。",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      try {
        const report = await runDiagnostics();
        const summary = `平台: ${report.platform}\nNode: ${report.nodeVersion}\nffmpeg: ${report.ffmpeg ?? '未安装'}\nsilk-wasm: ${report.silkWasm ? '可用' : '不可用'}\n警告: ${report.warnings.length}`;
        return { 
          content: [{ type: "text", text: summary }], 
          details: { success: true, report } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `诊断失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });
}

const plugin = {
  id: "qq",
  name: "QQ (OneBot)",
  description: "QQ channel plugin via OneBot v11",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    initQQClientManager();
    setQQRuntime(api.runtime);
    
    const emojiManager = getEmojiManager();
    emojiManager.initialize().catch(err => {
      console.error("[QQ] EmojiManager initialization failed:", err);
    });
    
    const personInfoManager = getPersonInfoManager();
    personInfoManager.startIntimacyDecayTimer();
    console.log("[QQ] PersonInfoManager initialized with intimacy decay timer");
    
    api.registerChannel({ plugin: qqChannel });
    registerQQTools(api);
  },
};

export default plugin;
