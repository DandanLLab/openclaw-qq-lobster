
OpenClawd 是一个多功能代理。下面的聊天演示仅展示了最基础的功能。
# OpenClaw QQ 插件 (OneBot v11) - 增强版

> 本插件是基于 [openclaw_QQ_plugin](https://github.com/Xiaji-yu/openclaw_QQ_plugin) 的二次开发增强版本

本插件通过 OneBot v11 协议（WebSocket）为 [OpenClaw](https://github.com/openclaw/openclaw) 添加全功能的 QQ 频道支持。相比原版，本版本新增了智能大脑系统、情感分析、表情包管理、图片识别等高级功能，打造更智能、更有趣的聊天机器人。

## ✨ 核心特性

### 🧠 深度智能与上下文

*   **历史回溯 (Context)**：在群聊中自动获取最近 N 条历史消息（默认 5 条），让 AI 能理解对话前文，不再"健忘"。
*   **系统提示词 (System Prompt)**：支持注入自定义提示词，让 Bot 扮演特定角色（如"猫娘"、"严厉的管理员"）。
*   **转发消息理解**：AI 能够解析并读取用户发送的合并转发聊天记录，处理复杂信息。
*   **关键词唤醒**：除了 @机器人，支持配置特定的关键词（如"小助手"）来触发对话。
*   **🆕 智能大脑系统 (PFC)**：
    *   **对话观察者**：观察群聊动态，理解对话上下文
    *   **行动规划器**：智能规划回复策略，判断是否回复、如何回复
    *   **对话信息处理**：分析对话结构和参与者
    *   AI 驱动的智能决策，不再只是简单的 @ 触发
*   **🆕 情感分析系统**：
    *   支持 9 种情感识别：开心、难过、生气、惊讶、困惑、担心、爱、疲惫、兴奋
    *   情感强度计算
    *   根据情感建议回复风格
    *   自动添加情感 Emoji
*   **🆕 记忆与知识系统**：
    *   长期记忆存储和检索
    *   知识库管理
    *   离线时的「梦境」处理

### 🛡️ 强大的管理与风控

*   **连接自愈**：内置心跳检测与重连指数退避机制，能自动识别并修复"僵尸连接"，确保 7x24 小时在线。
*   **群管指令**：管理员可直接在 QQ 中使用指令管理群成员（禁言/踢出）。
*   **🆕 AI 工具调用**：机器人可以主动调用工具执行操作：
    *   `qq_group_ban` - 群禁言 (1-5分钟)
    *   `qq_group_kick` - 群踢人 (需管理员确认)
    *   `qq_send_poke` - 戳一戳
    *   `qq_send_emoji` - 发送表情包
    *   `qq_send_emoji_by_emotion` - 根据情感发送表情包
    *   `qq_send_image` - 发送图片
    *   `qq_send_file` - 发送文件
*   **黑白名单**：
    *   **群组白名单**：只在指定的群组中响应，避免被拉入广告群。
    *   **用户黑名单**：屏蔽恶意用户的骚扰。
*   **🆕 主群系统**：
    *   支持配置主群，主群消息优先处理
    *   每个群可独立配置发言概率、历史消息数等
*   **自动请求处理**：可配置自动通过好友申请和入群邀请，实现无人值守运营。
*   **生产级风控**：
    *   **默认 @ 触发**：默认开启 `requireMention`，仅在被 @ 时回复，保护 Token 并不打扰他人。
    *   **🆕 动态发言概率**：根据对话历史自动调整发言概率，正在对话的用户更容易触发回复
    *   **速率限制**：发送多条消息时自动插入随机延迟，防止被 QQ 风控禁言。
    *   **URL 规避**：自动对链接进行处理（如加空格），降低被系统吞消息的概率。
    *   **系统号屏蔽**：自动过滤 QQ 管家等系统账号的干扰。
*   **🆕 内容审核**：
    *   AI 驱动的内容审核
    *   自动禁言功能
    *   可配置审核豁免用户/群组

### 🎭 丰富的交互体验

*   **戳一戳 (Poke)**：当用户"戳一戳"机器人时，AI 会感知到并做出有趣的回应。
*   **拟人化回复**：
    *   **自动 @**：在群聊回复时，自动 @原发送者（仅在第一段消息），符合人类社交礼仪。
    *   **昵称解析**：将消息中的 `[CQ:at]` 代码转换为真实昵称（如 `@张三`），AI 回复更自然。
*   **多模态支持**：
    *   **图片**：支持收发图片。优化了对 `base64://` 格式的支持，即使 Bot 与 OneBot 服务端不在同一局域网也可正常交互。
    *   **🆕 图片智能识别**：
        *   使用 VLM (视觉语言模型) 识别图片内容
        *   自动检测图片是否为表情包
        *   支持 GIF/APNG/WebP/PNG/JPG 格式检测
    *   **语音**：接收语音消息（需服务端支持 STT）并可选开启 TTS 语音回复。
    *   **文件**：支持群文件和私聊文件的收发。
*   **🆕 表情包系统**：
    *   本地表情包管理
    *   根据情感自动匹配表情包
    *   **表情包偷取**：自动保存群友发送的表情包
    *   表情包统计和随机发送
    *   支持「发表情」「来个表情包」等自然语言触发
*   **🆕 人员档案系统**：
    *   用户档案管理
    *   交互历史记录
    *   群组上下文关联
*   **QQ 频道 (Guild)**：原生支持 QQ 频道消息收发。

### 🔌 插件系统

*   **🆕 网络搜索**：`/search <关键词>` - 搜索网络内容
*   **🆕 聊天摘要**：`/summary [today|user <id>]` - 生成聊天摘要
*   **🆕 日记功能**：`/diary [list|today|generate]` - 自动生成日记
*   **🆕 记忆管理**：`/memory [list|add|search|clear|stats|share]` - 管理长期记忆
*   **🆕 URL摘要**：自动检测消息中的 URL 并生成摘要
*   **🆕 智能分段**：`/smart_seg [on|off|status]` - 使用 LLM 智能分段消息

---

## 📋 前置条件

1.  **OpenClaw**：已安装并运行 OpenClaw 主程序。
2.  **OneBot v11 服务端**：你需要一个运行中的 OneBot v11 实现。
    *   推荐：**[NapCat (Docker)](https://github.com/NapCatQQ/NapCat-Docker)** 或 **Lagrange**。
    *   **重要配置**：请务必在 OneBot 配置中将 `message_post_format` 设置为 `array`（数组格式），否则无法解析多媒体消息。
    *   网络：确保开启了正向 WebSocket 服务（通常端口为 3001）。
3.  **🆕 VLM 模型**（可选）：如需图片识别功能，需配置支持视觉的模型。

---

## 🚀 安装指南

### 方法 1: 使用 OpenClaw CLI (推荐)
如果你的 OpenClaw 版本支持插件市场或 CLI 安装：
```bash
# 进入插件目录
cd openclaw/extensions
# 克隆仓库
git clone https://github.com/Xiaji-yu/openclaw_QQ_plugin.git qq
# 安装依赖并构建
cd ../..
pnpm install && pnpm build
```

### 方法 2: Docker 集成
在你的 `docker-compose.yml` 或 `Dockerfile` 中，将本插件代码复制到 `/app/extensions/qq` 目录，然后重新构建镜像。

---

## ⚙️ 配置说明

### 1. 快速配置 (CLI 向导)
插件内置了交互式配置脚本，助你快速生成配置文件。
在插件目录 (`openclaw/extensions/qq`) 下运行：

```bash
node bin/onboard.js
```
按照提示输入 WebSocket 地址（如 `ws://localhost:3001`）、Token 和管理员 QQ 号即可。

### 2. 标准化配置 (OpenClaw Setup)
如果已集成到 OpenClaw CLI，可运行：
```bash
openclaw setup qq
```

### 3. 手动配置详解 (`openclaw.json`)
你也可以直接编辑配置文件。以下是完整配置清单：

```json
{
  "channels": {
    "qq": {
      "wsUrl": "ws://127.0.0.1:3001",
      "accessToken": "123456",
      "admins": [12345678],
      "allowedGroups": [10001, 10002],
      "blockedUsers": [999999],
      "systemPrompt": "你是一位精通 Linux 系统管理、Docker 容器化架构、以及 Python 脚本开发的专家级运维助理。",
      "historyLimit": 5,
      "keywordTriggers": ["小助手", "帮助"],
      "autoApproveRequests": true,
      "enableGuilds": true,
      "enableTTS": false,
      "rateLimitMs": 1000,
      "formatMarkdown": true,
      "antiRiskMode": false,
      "maxMessageLength": 4000,
      
      "primaryGroup": 10001,
      "talkValue": 0.5,
      "enableImageRecognition": true,
      "imageRecognitionPrompt": "请简洁描述这张图片的内容，如果是表情包请描述表达的情感。",
      "enableModeration": true,
      "autoMuteMaxDuration": 60,
      "requireAdminApprovalForKick": true,
      "autoSendEmoji": false,
      "autoSendEmojiProbability": 0.3,
      "autoSendEmojiMinIntensity": 0.5,
      "enableUrlSummary": true,
      "enableSmartSegmentationLLM": false,
      "useCustomModelCaller": false,
      
      "groupChannels": {
        "10001": {
          "name": "主群",
          "isPrimary": true,
          "talkValue": 0.8,
          "requireMention": false,
          "historyLimit": 10,
          "systemPrompt": "这是主群，请更认真地回复。"
        }
      }
    }
  },
  "plugins": {
    "entries": {
      "qq": { "enabled": true }
    }
  }
}
```

### 基础配置项

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `wsUrl` | string | **必填** | OneBot v11 WebSocket 地址 |
| `accessToken` | string | - | 连接鉴权 Token |
| `admins` | number[] | `[]` | **管理员 QQ 号列表**。拥有执行 `/status`, `/kick` 等指令的权限。 |
| `requireMention` | boolean | `true` | **是否需要 @ 触发**。设为 `true` 仅在被 @ 或回复机器人时响应。 |
| `allowedGroups` | number[] | `[]` | **群组白名单**。若设置，Bot 仅在这些群组响应；若为空，则响应所有群组。 |
| `blockedUsers` | number[] | `[]` | **用户黑名单**。Bot 将忽略这些用户的消息。 |
| `systemPrompt` | string | - | **人设设定**。注入到 AI 上下文的系统提示词。 |
| `historyLimit` | number | `5` | **历史消息条数**。群聊时携带最近 N 条消息给 AI，设为 0 关闭。 |
| `keywordTriggers` | string[] | `[]` | **关键词触发**。群聊中无需 @，包含这些词也会触发回复。 |
| `autoApproveRequests` | boolean | `false` | 是否自动通过好友申请和群邀请。 |
| `enableGuilds` | boolean | `true` | 是否开启 QQ 频道 (Guild) 支持。 |
| `enableTTS` | boolean | `false` | (实验性) 是否将 AI 回复转为语音发送 (需服务端支持 TTS)。 |
| `rateLimitMs` | number | `1000` | **发送限速**。多条消息间的延迟(毫秒)，建议设为 1000 以防风控。 |
| `formatMarkdown` | boolean | `false` | 是否将 Markdown 表格/列表转换为易读的纯文本排版。 |
| `antiRiskMode` | boolean | `false` | 是否开启风控规避（如给 URL 加空格）。 |
| `maxMessageLength` | number | `4000` | 单条消息最大长度，超过将自动分片发送。 |

### 🆕 增强配置项

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `primaryGroup` | number | - | **主群号**。主群消息会优先处理，系统提示词会标注为主群。 |
| `talkValue` | number | `0.5` | **发言概率** (0.0-1.0)。群聊中未 @ 时的自动回复概率。 |
| `enableImageRecognition` | boolean | `true` | 是否启用 VLM 图片识别。 |
| `imageRecognitionPrompt` | string | 见上 | 图片识别的自定义提示词。 |
| `enableModeration` | boolean | `true` | 是否启用 AI 内容审核。 |
| `autoMuteMaxDuration` | number | `60` | 自动禁言最大时长（秒）。 |
| `requireAdminApprovalForKick` | boolean | `true` | 踢人操作是否需要管理员确认。 |
| `requireAdminApprovalForLongMute` | boolean | `true` | 长时间禁言是否需要管理员确认。 |
| `moderationExemptUsers` | number[] | `[]` | 审核豁免用户列表。 |
| `moderationExemptGroups` | number[] | `[]` | 审核豁免群组列表。 |
| `moderationGroups` | number[] | `[]` | 启用审核的群组白名单。 |
| `autoSendEmoji` | boolean | `false` | 是否根据情感自动发送表情包。 |
| `autoSendEmojiProbability` | number | `0.3` | 自动发表情包的概率。 |
| `autoSendEmojiMinIntensity` | number | `0.5` | 触发自动发表情包的最小情感强度。 |
| `enableUrlSummary` | boolean | `true` | 是否自动摘要 URL。 |
| `enableSmartSegmentationLLM` | boolean | `false` | 是否使用 LLM 智能分段消息。 |
| `useCustomModelCaller` | boolean | `false` | 是否使用自定义模型轮播生成回复。 |

### 🆕 群组独立配置 (`groupChannels`)

每个群可以独立配置，优先级高于全局配置：

```json
{
  "groupChannels": {
    "群号字符串": {
      "groupId": 群号,
      "name": "群名称",
      "isPrimary": false,
      "priority": 0,
      "talkValue": 0.5,
      "requireMention": true,
      "historyLimit": 5,
      "systemPrompt": "群专属提示词",
      "enableModeration": true,
      "keywordTriggers": ["关键词"],
      "disabled": false,
      "tags": ["标签"]
    }
  }
}
```

---

## 🎮 使用指南

### 🗣️ 基础聊天
*   **私聊**：直接发送消息给机器人即可。
*   **群聊**：
    *   **@机器人** + 消息。
    *   回复机器人的消息。
    *   发送包含**关键词**（如配置中的"小助手"）的消息。
    *   **戳一戳**机器人头像。
    *   **🆕 自然触发**：根据 `talkValue` 配置，机器人有一定概率自动参与群聊。

### 👮‍♂️ 管理员指令
仅配置在 `admins` 列表中的用户可用：

*   `/status`
    *   查看机器人运行状态（内存占用、连接状态、用户档案数等）。
*   `/help`
    *   显示帮助菜单。
*   `/mute @用户 [分钟]` (仅群聊)
    *   禁言指定用户。不填时间默认 30 分钟。
*   `/kick @用户` (仅群聊)
    *   将指定用户移出群聊。
*   `/learn <模式> <替换>` (私聊)
    *   学习表达方式。

### 🆕 增强指令

*   `/chat t <数值>` - 设置当前群的发言频率 (0-1)
*   `/chat s` - 显示当前群的聊天配置状态
*   `/emoji list` - 查看表情包统计
*   `/random_emoji` - 随机发送表情包
*   `/search <关键词>` - 网络搜索
*   `/summary [today|user <id>]` - 生成聊天摘要
*   `/diary [list|today|generate]` - 日记功能
*   `/memory [list|add|search|clear|stats|share]` - 记忆管理
*   `/smart_seg [on|off|status]` - 智能分段开关

### 🆕 自然语言触发

*   **表情包请求**：「发表情」「来个表情包」「斗图」等
*   **戳一戳**：「戳我」
*   **网络搜索**：「搜索 xxx」「搜一下 xxx」「bing xxx」

### 💻 CLI 命令行使用
如果你在服务器终端操作 OpenClaw，可以使用以下标准命令：

1.  **查看状态**
    ```bash
    openclaw status
    ```
    显示 QQ 连接状态、延迟及当前 Bot 昵称。

2.  **列出群组/频道**
    ```bash
    openclaw list-groups --channel qq
    ```
    列出所有已加入的群聊和频道 ID。

3.  **主动发送消息**
    ```bash
    # 发送私聊
    openclaw send qq 12345678 "你好，这是测试消息"
    
    # 发送群聊 (使用 group: 前缀)
    openclaw send qq group:88888888 "大家好"
    
    # 发送频道消息
    openclaw send qq guild:GUILD_ID:CHANNEL_ID "频道消息"
    ```

---

## 📁 数据目录

插件会在运行目录下创建以下数据目录：

```
data/
├── emoji/          # 表情包存储（自动偷取的表情包）
├── images/         # 图片缓存
├── diary/          # 日记数据
├── memory/         # 记忆数据
└── chat_summary/   # 聊天摘要数据
```

---

## ❓ 常见问题 (FAQ)

**Q: 安装依赖时报错 `openclaw @workspace:*` 找不到？**
A: 这是因为主仓库的 workspace 协议导致的。我们已在最新版本中将其修复，请执行 `git pull` 后直接使用 `pnpm install` 或 `npm install` 即可，无需特殊环境。

**Q: 给机器人发图片它没反应？**
A: 
1. 确认你使用的 OneBot 实现（如 NapCat）开启了图片上报。
2. 建议在 OneBot 配置中开启"图片转 Base64"，这样即使你的 OpenClaw 在公网云服务器上，也能正常接收本地内网机器人的图片。
3. 插件现在会自动识别并提取图片，不再强制要求开启 `message_post_format: array`。
4. 🆕 如果开启了图片识别，请确保配置了支持视觉的 VLM 模型。

**Q: 机器人与 OneBot 不在同一个网络环境（非局域网）能用吗？**
A: **完全可以**。只要 `wsUrl` 能够通过内网穿透或公网 IP 访问到，且图片通过 Base64 传输，即可实现跨地域部署。

**Q: 为什么群聊不回话？**
A: 
1. 检查 `requireMention` 是否开启（默认开启），需要 @机器人。
2. 检查群组是否在 `allowedGroups` 白名单内（如果设置了的话）。
3. 检查 OneBot 日志，确认消息是否已上报。
4. 🆕 检查 `talkValue` 配置，如果设为 0 则不会自动回复。

**Q: 如何让 Bot 说话（TTS）？**
A: 将 `enableTTS` 设为 `true`。注意：这取决于 OneBot 服务端是否支持 TTS 转换。通常 NapCat/Lagrange 对此支持有限，可能需要额外插件。

**Q: 🆕 如何启用图片识别？**
A: 
1. 确保 `enableImageRecognition` 为 `true`（默认开启）
2. 在 OpenClaw 配置中配置支持视觉的模型（如 `gpt-4-vision-preview`、`claude-3-opus` 等）
3. 配置 `modelTasks.vlm` 任务指向视觉模型

**Q: 🆕 表情包偷取功能怎么用？**
A: 默认开启。当群友发送表情包时，插件会自动检测并保存到 `data/emoji/` 目录。你可以通过 `/random_emoji` 命令随机发送。

---

## 🆚 与原版插件的功能区别

| 功能特性 | 原版 | 增强版 | 说明 |
| :--- | :--- | :--- | :--- |
| **智能决策** | ❌ | ✅ PFC 大脑系统 | AI 判断是否回复、如何回复 |
| **情感分析** | ❌ | ✅ 9 种情感 | 根据情感调整回复风格 |
| **图片识别** | ❌ | ✅ VLM 支持 | 知道图片是什么内容 |
| **表情包系统** | ❌ | ✅ 完整管理 | 偷取、匹配、发送表情包 |
| **人员档案** | ❌ | ✅ 用户画像 | 记住用户信息 |
| **记忆系统** | ❌ | ✅ 长期记忆 | 跨会话记忆 |
| **插件系统** | ❌ | ✅ 7 个插件 | 搜索、摘要、日记等 |
| **AI 工具** | ❌ | ✅ 10+ 工具 | 禁言、踢人、发图等 |
| **群组独立配置** | ❌ | ✅ 支持 | 每个群独立设置 |
| **主群系统** | ❌ | ✅ 支持 | 优先处理主群消息 |
| **动态发言概率** | ❌ | ✅ 支持 | 根据对话调整概率 |

---

## 🆚 与 Telegram 插件的功能区别

如果您习惯使用 OpenClaw 的 Telegram 插件，以下是 `openclaw_qq` 在体验上的主要差异：

| 功能特性 | QQ 插件 (openclaw_qq) | Telegram 插件 | 体验差异说明 |
| :--- | :--- | :--- | :--- |
| **消息排版** | **纯文本** | **原生 Markdown** | QQ 不支持加粗、代码块高亮，插件会自动转换排版。 |
| **流式输出** | ❌ 不支持 | ✅ 支持 | TG 可实时看到 AI 打字；QQ 需等待 AI 生成完毕后整段发送。 |
| **消息编辑** | ❌ 不支持 | ✅ 支持 | TG 可修改已发内容；QQ 发送后无法修改，只能撤回。 |
| **交互按钮** | ❌ 暂不支持 | ✅ 支持 | TG 消息下方可带按钮；QQ 目前完全依靠文本指令。 |
| **风控等级** | 🔴 **极高** | 🟢 **极低** | QQ 极易因回复过快或敏感词封号，插件已内置分片限速。 |
| **戳一戳** | ✅ **特色支持** | ❌ 不支持 | QQ 特有的社交互动，AI 可感知并回应。 |
| **转发消息** | ✅ **深度支持** | ❌ 基础支持 | QQ 插件专门优化了对"合并转发"聊天记录的解析。 |
| **表情包** | ✅ **完整系统** | ❌ 基础支持 | QQ 插件支持表情包偷取、匹配、发送。 |

---

## 🙏 致谢

- 原版项目: [Xiaji-yu/openclaw_QQ_plugin](https://github.com/Xiaji-yu/openclaw_QQ_plugin)
- OpenClaw 主项目
