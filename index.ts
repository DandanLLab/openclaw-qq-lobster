import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { qqChannel } from "./src/channel.js";
import { setQQRuntime, getQQRuntime } from "./src/runtime.js";
import { getQQClient, initQQClientManager } from "./src/client.js";
import { getEmojiManager } from "./src/core/emoji/emojiManager.js";
import { getCurrentMessageContext } from "./src/messageContext.js";
import { getPersonInfoManager } from "./src/core/person/personInfoManager.js";
import { sendProactive, broadcastToKnownUsers, listKnownUsers, getKnownUsersStats } from "./src/proactive.js";
import { runDiagnostics, getQQBotDataDir } from "./src/utils/platform.js";
import { getPackageVersion } from "./src/utils/pkg-version.js";
import { getRecentLogs } from "./src/log-buffer.js";
import { getUpdateInfo } from "./src/update-checker.js";
import { lookupRef, getRefIndexStats } from "./src/ref-index-store.js";
import { transcribeAudioForNapcat, resolveSTTConfig } from "./src/message-parser.js";
import { getCachedMemberName } from "./src/member-cache.js";

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

  api.registerTool({
    name: "qq_lookup_ref",
    label: "QQ查询引用消息",
    description: "根据消息ID查询之前记录的消息引用信息。龙虾可以查找历史消息的上下文。",
    parameters: Type.Object({
      message_id: Type.String({ description: "要查询的消息ID" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const ref = lookupRef(params.message_id);
        if (!ref) {
          return { 
            content: [{ type: "text", text: `未找到消息ID ${params.message_id} 的引用记录` }], 
            details: { success: false, found: false } 
          };
        }
        return { 
          content: [{ type: "text", text: `消息引用: 发送者 ${ref.sender}，内容: ${ref.text.substring(0, 100)}...` }], 
          details: { success: true, found: true, ref } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `查询失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_get_ref_stats",
    label: "QQ引用索引统计",
    description: "获取消息引用索引的统计信息。",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      try {
        const stats = getRefIndexStats();
        return { 
          content: [{ type: "text", text: `引用索引统计: ${stats.size}/${stats.maxEntries} 条记录，磁盘行数: ${stats.totalLinesOnDisk}` }], 
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
    name: "qq_transcribe_voice",
    label: "QQ语音转文字",
    description: "将语音文件转换为文字。龙虾可以处理用户发送的语音消息。",
    parameters: Type.Object({
      audio_path: Type.String({ description: "语音文件路径（本地路径或URL）" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const runtime = getQQRuntime();
        const cfg = runtime.config.loadConfig();
        const transcription = await transcribeAudioForNapcat(params.audio_path, cfg);
        if (!transcription) {
          return { 
            content: [{ type: "text", text: "语音转文字失败：未配置STT服务或转换失败" }], 
            details: { success: false, reason: "no_stt_config" } 
          };
        }
        return { 
          content: [{ type: "text", text: `语音转文字结果: ${transcription}` }], 
          details: { success: true, transcription } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `语音转文字失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_get_member_name",
    label: "QQ获取群成员名称",
    description: "从缓存中获取群成员的名称。龙虾可以快速获取群成员信息。",
    parameters: Type.Object({
      group_id: Type.Number({ description: "群号" }),
      user_id: Type.String({ description: "用户ID" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const name = getCachedMemberName(String(params.group_id), params.user_id);
        if (!name) {
          return { 
            content: [{ type: "text", text: `缓存中未找到群 ${params.group_id} 用户 ${params.user_id} 的名称` }], 
            details: { success: false, found: false } 
          };
        }
        return { 
          content: [{ type: "text", text: `群 ${params.group_id} 用户 ${params.user_id} 的名称: ${name}` }], 
          details: { success: true, found: true, name } 
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
    name: "qq_get_logs",
    label: "QQ获取日志",
    description: "获取最近的日志记录。龙虾可以查看系统运行日志。",
    parameters: Type.Object({
      count: Type.Optional(Type.Number({ description: "获取日志条数，默认20，最大100", default: 20 })),
    }),
    async execute(_toolCallId, params) {
      try {
        const count = Math.min(Math.max(params.count || 20, 1), 100);
        const logs = getRecentLogs(count);
        if (logs.length === 0) {
          return { 
            content: [{ type: "text", text: "暂无日志记录" }], 
            details: { success: true, logs: [] } 
          };
        }
        const logText = logs.map(l => `[${l.level}] ${l.msg}`).join("\n");
        return { 
          content: [{ type: "text", text: `最近 ${logs.length} 条日志:\n${logText}` }], 
          details: { success: true, count: logs.length, logs } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `获取日志失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_check_update",
    label: "QQ检查更新",
    description: "检查QQ插件是否有新版本可用。龙虾可以主动检查更新。",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      try {
        const info = await getUpdateInfo();
        if (info.hasUpdate) {
          return { 
            content: [{ type: "text", text: `✨ 有新版本 v${info.latest} 可用！当前版本: v${info.current}` }], 
            details: { success: true, hasUpdate: true, current: info.current, latest: info.latest } 
          };
        } else if (info.error) {
          return { 
            content: [{ type: "text", text: `检查更新失败: ${info.error}` }], 
            details: { success: false, error: info.error } 
          };
        }
        return { 
          content: [{ type: "text", text: `✅ 已是最新版本 v${info.current}` }], 
          details: { success: true, hasUpdate: false, current: info.current } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `检查更新失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_get_version",
    label: "QQ获取版本信息",
    description: "获取QQ插件的版本信息。",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      try {
        const version = getPackageVersion(import.meta.url);
        const nodeVersion = process.version;
        return { 
          content: [{ type: "text", text: `OpenClaw QQ 插件 v${version}\nNode.js: ${nodeVersion}` }], 
          details: { success: true, version, nodeVersion } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `获取版本失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_get_data_dir",
    label: "QQ获取数据目录",
    description: "获取QQ插件的数据存储目录路径。",
    parameters: Type.Object({
      subpath: Type.Optional(Type.String({ description: "子路径，如 'data', 'temp', 'emoji'" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const dataDir = getQQBotDataDir(params.subpath || "");
        return { 
          content: [{ type: "text", text: `数据目录: ${dataDir}` }], 
          details: { success: true, path: dataDir } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `获取目录失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_get_person_info",
    label: "QQ获取用户档案",
    description: "获取用户的个人信息档案，包括亲密度、互动次数等。龙虾可以了解与用户的关系。",
    parameters: Type.Object({
      user_id: Type.Optional(Type.Number({ description: "用户ID（不填则使用当前对话用户）" })),
      group_id: Type.Optional(Type.Number({ description: "群号（可选，用于获取群内档案）" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const ctx = getCurrentMessageContext();
        const userId = params.user_id || ctx?.userId;
        const groupId = params.group_id || ctx?.groupId;
        
        if (!userId) {
          return { 
            content: [{ type: "text", text: "无法确定用户ID" }], 
            details: { success: false } 
          };
        }
        
        const personManager = getPersonInfoManager();
        const personInfo = personManager.getPersonInfo(userId, groupId);
        
        if (!personInfo) {
          return { 
            content: [{ type: "text", text: `未找到用户 ${userId} 的档案信息` }], 
            details: { success: false, found: false } 
          };
        }
        
        const info = `用户 ${userId} 档案:\n亲密度: ${personInfo.intimacyLevel?.toFixed(2) || 0}\n互动次数: ${personInfo.interactionCount || 0}\n最后互动: ${personInfo.lastInteraction ? new Date(personInfo.lastInteraction).toLocaleString() : '无'}`;
        return { 
          content: [{ type: "text", text: info }], 
          details: { success: true, found: true, personInfo } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `获取档案失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_record_interaction",
    label: "QQ记录互动",
    description: "手动记录与用户的互动。龙虾可以主动记录重要的互动事件。",
    parameters: Type.Object({
      user_id: Type.Optional(Type.Number({ description: "用户ID（不填则使用当前对话用户）" })),
      user_name: Type.Optional(Type.String({ description: "用户名称" })),
      group_id: Type.Optional(Type.Number({ description: "群号（可选）" })),
      group_name: Type.Optional(Type.String({ description: "群名称" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const ctx = getCurrentMessageContext();
        const userId = params.user_id || ctx?.userId;
        const userName = params.user_name || ctx?.senderName || String(userId);
        const groupId = params.group_id || ctx?.groupId;
        const groupName = params.group_name;
        
        if (!userId) {
          return { 
            content: [{ type: "text", text: "无法确定用户ID" }], 
            details: { success: false } 
          };
        }
        
        const personManager = getPersonInfoManager();
        personManager.recordInteraction(userId, groupId, userName);
        
        if (groupId && groupName) {
          personManager.updatePersonInfo({ userId, groupId, groupName });
        }
        
        return { 
          content: [{ type: "text", text: `已记录与用户 ${userName}(${userId}) 的互动` }], 
          details: { success: true, userId, groupId } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `记录互动失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_list_known_users",
    label: "QQ列出已知用户",
    description: "列出已知的用户列表。龙虾可以查看最近互动过的用户。",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "返回数量，默认10", default: 10 })),
      type: Type.Optional(Type.Union([Type.Literal("private"), Type.Literal("group"), Type.Literal("guild")])),
    }),
    async execute(_toolCallId, params) {
      try {
        const users = listKnownUsers({
          limit: params.limit || 10,
          type: params.type as any,
          sortBy: "lastSeenAt",
          sortOrder: "desc",
        });
        
        if (users.length === 0) {
          return { 
            content: [{ type: "text", text: "暂无已知用户记录" }], 
            details: { success: true, users: [] } 
          };
        }
        
        const userList = users.map((u, i) => `${i + 1}. ${u.nickname || u.openid} (${u.type}) - 互动${u.interactionCount}次`).join("\n");
        return { 
          content: [{ type: "text", text: `已知用户列表:\n${userList}` }], 
          details: { success: true, count: users.length, users } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `获取用户列表失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_forward_to_group",
    label: "QQ跨频道转发消息到群",
    description: "将消息转发到指定的群。管理员可以直接转发，普通用户需要龙虾判断内容是否合适。常用于私聊中请求龙虾帮忙在群里发布消息。",
    parameters: Type.Object({
      group_id: Type.Optional(Type.Number({ description: "目标群号（不填则发送到主群）" })),
      message: Type.String({ description: "要转发的消息内容" }),
      source_context: Type.Optional(Type.String({ description: "消息来源说明，如'用户XXX在私聊中请求转发'" })),
    }),
    async execute(_toolCallId, params) {
      const client = getQQClient("default");
      if (!client) {
        return { content: [{ type: "text", text: "QQ客户端未连接" }], details: { success: false } };
      }
      
      const ctx = getCurrentMessageContext();
      const runtime = getQQRuntime();
      const cfg = runtime.config.loadConfig() as any;
      const qqConfig = cfg?.channels?.qq || {};
      
      const targetGroupId = params.group_id || qqConfig.primaryGroup;
      
      if (!targetGroupId) {
        return { 
          content: [{ type: "text", text: "未指定目标群号，且未配置主群。请指定group_id或配置primaryGroup。" }], 
          details: { success: false, reason: "no_target_group" } 
        };
      }
      
      const isAdmin = ctx && qqConfig.admins?.includes(ctx.userId);
      const isPrivateChat = ctx && !ctx.isGroup;
      
      if (isPrivateChat && !isAdmin) {
        const sourceInfo = params.source_context || `用户${ctx?.userId}在私聊中请求`;
        return { 
          content: [{ 
            type: "text", 
            text: `【需要判断】${sourceInfo}转发以下消息到群 ${targetGroupId}:\n"${params.message.substring(0, 100)}..."\n\n请判断内容是否合适后再决定是否发送。` 
          }], 
          details: { 
            success: false, 
            needsJudgment: true, 
            group_id: targetGroupId, 
            message: params.message,
            source_user_id: ctx?.userId,
            is_admin: false 
          } 
        };
      }
      
      try {
        await client.sendGroupMsg(targetGroupId, params.message);
        console.log(`[QQ] 📤 跨频道转发消息到群 ${targetGroupId}: ${params.message.substring(0, 50)}...`);
        return { 
          content: [{ type: "text", text: `✅ 消息已发送到群 ${targetGroupId}` }], 
          details: { success: true, group_id: targetGroupId, message_length: params.message.length } 
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
    name: "qq_send_to_primary_group",
    label: "QQ发送消息到主群",
    description: "发送消息到主群。龙虾可以主动在主群发布通知或消息。需要配置了primaryGroup。",
    parameters: Type.Object({
      message: Type.String({ description: "要发送的消息内容" }),
      mention_all: Type.Optional(Type.Boolean({ description: "是否@全体成员", default: false })),
    }),
    async execute(_toolCallId, params) {
      const client = getQQClient("default");
      if (!client) {
        return { content: [{ type: "text", text: "QQ客户端未连接" }], details: { success: false } };
      }
      
      const runtime = getQQRuntime();
      const cfg = runtime.config.loadConfig() as any;
      const primaryGroup = cfg?.channels?.qq?.primaryGroup;
      
      if (!primaryGroup) {
        return { 
          content: [{ type: "text", text: "未配置主群（primaryGroup）。请先在配置中设置主群号。" }], 
          details: { success: false, reason: "no_primary_group" } 
        };
      }
      
      try {
        let message = params.message;
        if (params.mention_all) {
          message = `[CQ:at,qq=all] ${message}`;
        }
        await client.sendGroupMsg(primaryGroup, message);
        console.log(`[QQ] 📤 发送消息到主群 ${primaryGroup}: ${params.message.substring(0, 50)}...`);
        return { 
          content: [{ type: "text", text: `✅ 消息已发送到主群 ${primaryGroup}` }], 
          details: { success: true, group_id: primaryGroup, message_length: params.message.length } 
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
    name: "qq_cross_channel_reply",
    label: "QQ跨频道回复",
    description: "在私聊中回复时，同时将回复发送到指定群。适用于用户在私聊中讨论，但希望龙虾在群里也回复的情况。",
    parameters: Type.Object({
      group_id: Type.Optional(Type.Number({ description: "目标群号（不填则发送到主群）" })),
      group_message: Type.String({ description: "发送到群的消息" }),
      private_message: Type.Optional(Type.String({ description: "发送给当前私聊用户的消息（可选）" })),
    }),
    async execute(_toolCallId, params) {
      const client = getQQClient("default");
      if (!client) {
        return { content: [{ type: "text", text: "QQ客户端未连接" }], details: { success: false } };
      }
      
      const ctx = getCurrentMessageContext();
      const runtime = getQQRuntime();
      const cfg = runtime.config.loadConfig() as any;
      const qqConfig = cfg?.channels?.qq || {};
      
      const targetGroupId = params.group_id || qqConfig.primaryGroup;
      
      if (!targetGroupId) {
        return { 
          content: [{ type: "text", text: "未指定目标群号，且未配置主群。" }], 
          details: { success: false, reason: "no_target_group" } 
        };
      }
      
      const results: { group: boolean; private: boolean } = { group: false, private: false };
      
      try {
        await client.sendGroupMsg(targetGroupId, params.group_message);
        results.group = true;
        console.log(`[QQ] 📤 跨频道回复到群 ${targetGroupId}`);
      } catch (e: any) {
        console.error(`[QQ] 发送到群失败: ${e.message}`);
      }
      
      if (params.private_message && ctx && !ctx.isGroup) {
        try {
          await client.sendPrivateMsg(ctx.userId, params.private_message);
          results.private = true;
          console.log(`[QQ] 📤 跨频道回复到私聊 ${ctx.userId}`);
        } catch (e: any) {
          console.error(`[QQ] 发送到私聊失败: ${e.message}`);
        }
      }
      
      const summary = [];
      if (results.group) summary.push(`群 ${targetGroupId} ✓`);
      if (results.private) summary.push(`私聊 ✓`);
      if (!results.group && !results.private) summary.push("全部失败 ✗");
      
      return { 
        content: [{ type: "text", text: `跨频道回复结果: ${summary.join(", ")}` }], 
        details: { success: results.group, results, group_id: targetGroupId } 
      };
    },
  });

  api.registerTool({
    name: "qq_broadcast_to_groups",
    label: "QQ广播到多个群",
    description: "将消息广播到多个群。管理员可以直接广播，普通用户需要龙虾判断。适用于发布通知、公告等。",
    parameters: Type.Object({
      group_ids: Type.Optional(Type.Array(Type.Number({ description: "目标群号列表（不填则发送到所有已知群）" }))),
      message: Type.String({ description: "要广播的消息内容" }),
      include_primary: Type.Optional(Type.Boolean({ description: "是否包含主群", default: true })),
    }),
    async execute(_toolCallId, params) {
      const client = getQQClient("default");
      if (!client) {
        return { content: [{ type: "text", text: "QQ客户端未连接" }], details: { success: false } };
      }
      
      const ctx = getCurrentMessageContext();
      const runtime = getQQRuntime();
      const cfg = runtime.config.loadConfig() as any;
      const qqConfig = cfg?.channels?.qq || {};
      
      const isAdmin = ctx && qqConfig.admins?.includes(ctx.userId);
      
      if (!isAdmin) {
        return { 
          content: [{ 
            type: "text", 
            text: `【需要管理员权限】广播功能需要管理员权限。当前用户不是管理员。` 
          }], 
          details: { success: false, needsAdmin: true } 
        };
      }
      
      let targetGroups = params.group_ids || [];
      
      if (targetGroups.length === 0) {
        if (qqConfig.primaryGroup && params.include_primary !== false) {
          targetGroups.push(qqConfig.primaryGroup);
        }
        if (qqConfig.allowedGroups && qqConfig.allowedGroups.length > 0) {
          targetGroups = [...new Set([...targetGroups, ...qqConfig.allowedGroups])];
        }
      }
      
      if (targetGroups.length === 0) {
        return { 
          content: [{ type: "text", text: "没有可用的目标群。请配置primaryGroup或allowedGroups，或指定group_ids。" }], 
          details: { success: false, reason: "no_target_groups" } 
        };
      }
      
      const results: { group_id: number; success: boolean; error?: string }[] = [];
      
      for (const groupId of targetGroups) {
        try {
          await client.sendGroupMsg(groupId, params.message);
          results.push({ group_id: groupId, success: true });
          await new Promise(r => setTimeout(r, 500));
        } catch (e: any) {
          results.push({ group_id: groupId, success: false, error: e.message });
        }
      }
      
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
      
      return { 
        content: [{ type: "text", text: `广播完成: 成功 ${successCount}/${results.length}，失败 ${failCount}` }], 
        details: { success: successCount > 0, results, total: results.length, successCount, failCount } 
      };
    },
  });

  api.registerTool({
    name: "qq_get_primary_group",
    label: "QQ获取主群信息",
    description: "获取主群的配置信息。龙虾可以了解主群是哪个群。",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const runtime = getQQRuntime();
      const cfg = runtime.config.loadConfig() as any;
      const qqConfig = cfg?.channels?.qq || {};
      const primaryGroup = qqConfig.primaryGroup;
      
      if (!primaryGroup) {
        return { 
          content: [{ type: "text", text: "未配置主群（primaryGroup）。" }], 
          details: { success: false, hasPrimaryGroup: false } 
        };
      }
      
      const groupConfig = qqConfig.groupChannels?.[String(primaryGroup)] || {};
      
      return { 
        content: [{ 
          type: "text", 
          text: `主群信息:\n群号: ${primaryGroup}\n群名: ${groupConfig.name || '未配置'}\n优先级: ${groupConfig.priority || 0}` 
        }], 
        details: { 
          success: true, 
          hasPrimaryGroup: true, 
          primaryGroup,
          groupConfig 
        } 
      };
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
