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
          details: { success: true } 
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

  api.registerTool({
    name: "qq_send_proactive",
    label: "QQ主动发送消息",
    description: "主动发送消息给指定目标。龙虾可以主动联系用户或群。目标格式：私聊用QQ号，群聊用\"group:群号\"，频道用\"guild:频道ID:子频道ID\"。",
    parameters: Type.Object({
      to: Type.String({ description: "目标：QQ号、group:群号、或guild:频道ID:子频道ID" }),
      text: Type.String({ description: "消息内容" }),
      media_url: Type.Optional(Type.String({ description: "媒体URL（图片或文件）" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await sendProactive({
          to: params.to,
          text: params.text,
          mediaUrl: params.media_url,
        });
        
        if (result.success) {
          return { 
            content: [{ type: "text", text: `✅ 消息已发送到 ${params.to}` }], 
            details: { success: true, to: params.to } 
          };
        } else {
          return { 
            content: [{ type: "text", text: `发送失败: ${result.error}` }], 
            details: { success: false, error: result.error } 
          };
        }
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `发送失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_broadcast_known_users",
    label: "QQ广播给已知用户",
    description: "向已知用户广播消息。可以筛选用户类型（私聊/群/频道）和活跃时间。管理员功能。",
    parameters: Type.Object({
      message: Type.String({ description: "要广播的消息内容" }),
      type: Type.Optional(Type.Union([Type.Literal("private"), Type.Literal("group"), Type.Literal("guild")])),
      active_within_hours: Type.Optional(Type.Number({ description: "只发送给N小时内活跃的用户" })),
    }),
    async execute(_toolCallId, params) {
      const ctx = getCurrentMessageContext();
      const runtime = getQQRuntime();
      const cfg = runtime.config.loadConfig() as any;
      const qqConfig = cfg?.channels?.qq || {};
      
      const isAdmin = ctx && qqConfig.admins?.includes(ctx.userId);
      
      if (!isAdmin) {
        return { 
          content: [{ type: "text", text: "【需要管理员权限】广播功能需要管理员权限。" }], 
          details: { success: false, needsAdmin: true } 
        };
      }
      
      try {
        const result = await broadcastToKnownUsers(params.message, {
          type: params.type as any,
          activeWithin: params.active_within_hours ? params.active_within_hours * 3600000 : undefined,
        });
        
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
    name: "qq_get_known_users_stats",
    label: "QQ获取已知用户统计",
    description: "获取已知用户的统计信息，包括总数、各类型数量等。",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      try {
        const stats = getKnownUsersStats();
        return { 
          content: [{ 
            type: "text", 
            text: `已知用户统计:\n总数: ${stats.totalUsers}\n私聊: ${stats.privateUsers}\n群聊: ${stats.groupUsers}\n频道: ${stats.guildUsers}\n24h活跃: ${stats.activeIn24h}\n7天活跃: ${stats.activeIn7d}` 
          }], 
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
    name: "qq_run_diagnostics",
    label: "QQ运行环境诊断",
    description: "运行环境诊断，检查ffmpeg、silk-wasm等依赖是否正常。用于排查问题。",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      try {
        const report = await runDiagnostics();
        const lines = [
          "=== QQ插件环境诊断 ===",
          `平台: ${report.platform} (${report.arch})`,
          `Node: ${report.nodeVersion}`,
          `主目录: ${report.homeDir}`,
          `数据目录: ${report.dataDir}`,
          `ffmpeg: ${report.ffmpeg ?? "未安装"}`,
          `silk-wasm: ${report.silkWasm ? "可用" : "不可用"}`,
        ];
        if (report.warnings.length > 0) {
          lines.push("--- 警告 ---");
          lines.push(...report.warnings);
        }
        lines.push("====================");
        
        return { 
          content: [{ type: "text", text: lines.join("\n") }], 
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
    name: "qq_get_data_dir",
    label: "QQ获取数据目录",
    description: "获取QQ机器人的数据存储目录路径。",
    parameters: Type.Object({
      subpath: Type.Optional(Type.String({ description: "子路径（可选）" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const dir = params.subpath 
          ? getQQBotDataDir(...params.subpath.split("/"))
          : getQQBotDataDir();
        return { 
          content: [{ type: "text", text: `数据目录: ${dir}` }], 
          details: { success: true, path: dir } 
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
    name: "qq_get_version",
    label: "QQ获取插件版本",
    description: "获取QQ插件的当前版本号。",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      try {
        const version = getPackageVersion();
        return { 
          content: [{ type: "text", text: `QQ插件版本: ${version}` }], 
          details: { success: true, version } 
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
    name: "qq_get_recent_logs",
    label: "QQ获取最近日志",
    description: "获取最近的运行日志，用于调试和排查问题。",
    parameters: Type.Object({
      count: Type.Optional(Type.Number({ description: "获取的日志条数，默认20", default: 20 })),
    }),
    async execute(_toolCallId, params) {
      try {
        const logs = getRecentLogs(params.count || 20);
        if (logs.length === 0) {
          return { 
            content: [{ type: "text", text: "暂无日志记录" }], 
            details: { success: true, logs: [] } 
          };
        }
        
        const formatted = logs.map(l => {
          const d = new Date(l.ts);
          const ts = d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
          const prefix = l.level === "error" ? "[ERR]" : l.level === "warn" ? "[WRN]" : "[LOG]";
          return `${ts} ${prefix} ${l.msg}`;
        }).join("\n");
        
        return { 
          content: [{ type: "text", text: `最近日志:\n${formatted}` }], 
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
    description: "检查QQ插件是否有新版本可用。",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      try {
        const info = await getUpdateInfo();
        
        if (info.error) {
          return { 
            content: [{ type: "text", text: `检查更新失败: ${info.error}` }], 
            details: { success: false, error: info.error } 
          };
        }
        
        if (info.hasUpdate) {
          return { 
            content: [{ 
              type: "text", 
              text: `🔔 发现新版本!\n当前版本: ${info.current}\n最新版本: ${info.latest}\n\n更新命令: npm update @openclaw/qq` 
            }], 
            details: { success: true, hasUpdate: true, info } 
          };
        } else {
          return { 
            content: [{ type: "text", text: `✅ 已是最新版本: ${info.current}` }], 
            details: { success: true, hasUpdate: false, info } 
          };
        }
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `检查更新失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_lookup_ref",
    label: "QQ查找引用消息",
    description: "根据消息ID查找之前记录的引用消息内容。用于查看被回复的消息原文。",
    parameters: Type.Object({
      msg_id: Type.String({ description: "消息ID" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const entry = lookupRef(params.msg_id);
        
        if (!entry) {
          return { 
            content: [{ type: "text", text: `未找到消息ID ${params.msg_id} 的记录` }], 
            details: { success: false, found: false } 
          };
        }
        
        const d = new Date(entry.timestamp);
        const ts = d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
        
        return { 
          content: [{ 
            type: "text", 
            text: `引用消息:\n发送者: ${entry.sender}${entry.senderId ? ` (${entry.senderId})` : ""}\n时间: ${ts}\n内容: ${entry.text}` 
          }], 
          details: { success: true, found: true, entry } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `查找引用失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_get_ref_index_stats",
    label: "QQ获取引用索引统计",
    description: "获取引用消息索引的统计信息。",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      try {
        const stats = getRefIndexStats();
        return { 
          content: [{ 
            type: "text", 
            text: `引用索引统计:\n条目数: ${stats.size}\n最大容量: ${stats.maxEntries}\n磁盘行数: ${stats.totalLinesOnDisk}\n存储文件: ${stats.filePath}` 
          }], 
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
    name: "qq_get_member_name",
    label: "QQ获取群成员名称",
    description: "从缓存中获取群成员的名称（名片或昵称）。",
    parameters: Type.Object({
      group_id: Type.Number({ description: "群号" }),
      user_id: Type.Number({ description: "用户ID" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const name = getCachedMemberName(String(params.group_id), String(params.user_id));
        
        if (!name) {
          return { 
            content: [{ type: "text", text: `未找到群 ${params.group_id} 中用户 ${params.user_id} 的缓存名称` }], 
            details: { success: false, found: false } 
          };
        }
        
        return { 
          content: [{ type: "text", text: `群 ${params.group_id} 中用户 ${params.user_id} 的名称: ${name}` }], 
          details: { success: true, found: true, name } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `获取名称失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_send_emoji_reaction",
    label: "QQ发送表情回应",
    description: "对群消息发送表情回应（表情贴）。龙虾可以根据对话内容判断是否需要发送表情回应，比如对方说了有趣的话、感谢、夸奖等情况下可以发送👍等表情.只在群聊中有效。",
    parameters: Type.Object({
      emoji_id: Type.String({ description: "表情ID，如 128077 (👍)、128078 (👎)、128522 (😊) 等" }),
    }),
    async execute(_toolCallId, params) {
      const client = getQQClient("default");
      if (!client) {
        return { content: [{ type: "text", text: "QQ客户端未连接" }], details: { success: false } };
      }
      
      const ctx = getCurrentMessageContext();
      if (!ctx || !ctx.isGroup) {
        return { content: [{ type: "text", text: "当前不在群聊环境中，无法发送表情回应" }], details: { success: false } };
      }
      
      const messageId = ctx.messageId;
      if (!messageId) {
        return { content: [{ type: "text", text: "无法获取当前消息ID" }], details: { success: false } };
      }
      
      try {
        client.setGroupReaction(ctx.groupId!, String(messageId), params.emoji_id);
        console.log(`[QQ] 🎯 龙虾主动发送表情回应: ${params.emoji_id}`);
        return { 
          content: [{ type: "text", text: `✅ 已发送表情回应` }], 
          details: { success: true, emoji_id: params.emoji_id, group_id: ctx.groupId } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `发送表情回应失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_send_poke",
    label: "QQ戳一戳",
    description: "在QQ群中戳一戳指定用户。龙虾可以根据对话内容判断是否需要戳一戳，比如对方说了一些可爱的话、求关注、或者想互动的时候可以戳一戳。只在群聊中有效。",
    parameters: Type.Object({
      user_id: Type.Optional(Type.Number({ description: "要戳的用户ID（不填则戳当前对话用户）" })),
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
      const selfId = client.getSelfId?.();
      
      if (selfId && String(targetUserId) === String(selfId)) {
        return { content: [{ type: "text", text: "戳自己？咱才不会做这种傻事呢！" }], details: { success: false } };
      }
      
      try {
        client.sendGroupPoke(ctx.groupId!, targetUserId);
        console.log(`[QQ] 👆 龙虾主动戳一戳: 群${ctx.groupId} 用户${targetUserId}`);
        return { 
          content: [{ type: "text", text: `✅ 已戳一戳用户 ${targetUserId}` }], 
          details: { success: true, user_id: targetUserId, group_id: ctx.groupId } 
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
    name: "qq_send_like",
    label: "QQ发送好友赞",
    description: "给指定用户发送好友赞。可以用来表达喜欢或感谢。每个好友每天最多10次。",
    parameters: Type.Object({
      user_id: Type.Optional(Type.Number({ description: "要点赞的用户ID（不填则点赞当前对话用户）" })),
      times: Type.Optional(Type.Number({ description: "点赞次数，默认1次，最多10次", minimum: 1, maximum: 10 })),
    }),
    async execute(_toolCallId, params) {
      const client = getQQClient("default");
      if (!client) {
        return { content: [{ type: "text", text: "QQ客户端未连接" }], details: { success: false } };
      }
      
      const ctx = getCurrentMessageContext();
      const targetUserId = params.user_id || ctx?.userId;
      
      if (!targetUserId) {
        return { content: [{ type: "text", text: "无法确定用户ID" }], details: { success: false } };
      }
      
      const times = Math.min(Math.max(params.times || 1, 1), 10);
      
      try {
        client.sendApi("send_like", { user_id: targetUserId, times });
        console.log(`[QQ] 👍 龙虾发送好友赞: 用户${targetUserId}, ${times}次`);
        return { 
          content: [{ type: "text", text: `✅ 已给用户 ${targetUserId} 点赞 ${times} 次` }], 
          details: { success: true, user_id: targetUserId, times } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `发送点赞失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_set_group_card",
    label: "QQ设置群名片",
    description: "设置群成员的群名片（群备注）。需要管理员权限。只在群聊中有效。",
    parameters: Type.Object({
      user_id: Type.Optional(Type.Number({ description: "要设置群名片的用户ID（不填则设置当前用户）" })),
      card: Type.String({ description: "群名片内容，空字符串表示删除群名片" }),
    }),
    async execute(_toolCallId, params) {
      const client = getQQClient("default");
      if (!client) {
        return { content: [{ type: "text", text: "QQ客户端未连接" }], details: { success: false } };
      }
      
      const ctx = getCurrentMessageContext();
      if (!ctx || !ctx.isGroup) {
        return { content: [{ type: "text", text: "当前不在群聊环境中" }], details: { success: false } };
      }
      
      const targetUserId = params.user_id || ctx.userId;
      
      try {
        client.sendApi("set_group_card", { group_id: ctx.groupId, user_id: targetUserId, card: params.card || "" });
        console.log(`[QQ] 📝 龙虾设置群名片: 群${ctx.groupId} 用户${targetUserId} -> ${params.card}`);
        return { 
          content: [{ type: "text", text: `✅ 已设置群名片: ${params.card || "(已删除)"}` }], 
          details: { success: true, user_id: targetUserId, group_id: ctx.groupId } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `设置群名片失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_get_group_member_info",
    label: "QQ获取群成员信息",
    description: "获取群成员的详细信息，包括昵称、群名片、性别、年龄、角色等。只在群聊中有效。",
    parameters: Type.Object({
      user_id: Type.Optional(Type.Number({ description: "要获取信息的用户ID（不填则获取当前用户）" })),
    }),
    async execute(_toolCallId, params) {
      const client = getQQClient("default");
      if (!client) {
        return { content: [{ type: "text", text: "QQ客户端未连接" }], details: { success: false } };
      }
      
      const ctx = getCurrentMessageContext();
      if (!ctx || !ctx.isGroup) {
        return { content: [{ type: "text", text: "当前不在群聊环境中" }], details: { success: false } };
      }
      
      const targetUserId = params.user_id || ctx.userId;
      
      try {
        const result = await client.sendApiWithResponse("get_group_member_info", { group_id: ctx.groupId, user_id: targetUserId });
        const info = result.data || result;
        const summary = `群成员信息:
- QQ号: ${info.user_id}
- 昵称: ${info.nickname}
- 群名片: ${info.card || "(无)"}
- 性别: ${info.sex === 'male' ? '男' : info.sex === 'female' ? '女' : '未知'}
- 年龄: ${info.age || "未知"}
- 角色: ${info.role === 'owner' ? '群主' : info.role === 'admin' ? '管理员' : '成员'}
- 入群时间: ${info.join_time ? new Date(info.join_time * 1000).toLocaleString() : "未知"}`;
        return { 
          content: [{ type: "text", text: summary }], 
          details: { success: true, info } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `获取群成员信息失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_get_group_info",
    label: "QQ获取群信息",
    description: "获取群的基本信息，包括群名、成员数、群容量等。只在群聊中有效。",
    parameters: Type.Object({}),
    async execute(_toolCallId, params) {
      const client = getQQClient("default");
      if (!client) {
        return { content: [{ type: "text", text: "QQ客户端未连接" }], details: { success: false } };
      }
      
      const ctx = getCurrentMessageContext();
      if (!ctx || !ctx.isGroup) {
        return { content: [{ type: "text", text: "当前不在群聊环境中" }], details: { success: false } };
      }
      
      try {
        const result = await client.sendApiWithResponse("get_group_info", { group_id: ctx.groupId });
        const info = result.data || result;
        const summary = `群信息:
- 群号: ${info.group_id}
- 群名: ${info.group_name}
- 成员数: ${info.member_count}
- 群容量: ${info.max_member_count}`;
        return { 
          content: [{ type: "text", text: summary }], 
          details: { success: true, info } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `获取群信息失败: ${e.message}` }], 
          details: { success: false, error: e.message } 
        };
      }
    },
  });

  api.registerTool({
    name: "qq_delete_msg",
    label: "QQ撤回消息",
    description: "撤回指定的消息。只能撤回2分钟内自己发送的消息，或管理员可以撤回群成员的消息。需要消息ID。",
    parameters: Type.Object({
      message_id: Type.Number({ description: "要撤回的消息ID" }),
    }),
    async execute(_toolCallId, params) {
      const client = getQQClient("default");
      if (!client) {
        return { content: [{ type: "text", text: "QQ客户端未连接" }], details: { success: false } };
      }
      
      try {
        client.sendApi("delete_msg", { message_id: params.message_id });
        console.log(`[QQ] 🗑️ 龙虾撤回消息: ${params.message_id}`);
        return { 
          content: [{ type: "text", text: `✅ 已撤回消息 ${params.message_id}` }], 
          details: { success: true, message_id: params.message_id } 
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `撤回消息失败: ${e.message}` }], 
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
