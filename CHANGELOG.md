# OpenClaw QQ Plugin 更新说明

> 本文档记录了基于原版 `openclaw_QQ_plugin` 的二次开发修改内容

## 版本对比概览

| 对比项 | 原版 (openclaw_QQ_plugin) | 修改版 (qq) |
|--------|---------------------------|-------------|
| 文件数量 | 6 个核心文件 | 40+ 个文件 |
| 代码行数 | ~800 行 | ~5000+ 行 |
| 功能模块 | 基础消息收发 | 完整AI智能体系统 |
| 配置项 | 15 个 | 35+ 个 |

---

## 🚀 重大新增功能

### 1. 智能大脑系统 (Brain/PFC)

新增「前额叶皮层」(PFC) 模块，实现智能决策：

- **对话观察者** (`chatObserver.ts`): 观察群聊动态，理解对话上下文
- **行动规划器** (`actionPlanner.ts`): 智能规划回复策略
- **对话信息处理** (`conversationInfo.ts`): 分析对话结构和参与者
- **PFC核心** (`pfc.ts`): 整合认知功能，做出回复决策

```
原版: 简单的 @ 触发 + 关键词触发
新版: AI 驱动的智能决策，根据对话上下文判断是否回复、如何回复
```

### 2. 心流控制系统 (HeartFlow)

- **频率控制** (`frequencyControl.ts`): 控制机器人发言频率
- **心流聊天** (`heartFCChat.ts`): 管理聊天状态和流畅度

### 3. 记忆与知识系统

- **记忆检索** (`memoryRetrieval.ts`): 长期记忆存储和检索
- **知识管理** (`knowledgeManager.ts`): 知识库管理
- **梦境管理** (`dreamManager.ts`): 离线时的「梦境」处理

### 4. 情感分析系统

新增 `emotionAnalyzer.ts`：

- 支持 9 种情感识别：开心、难过、生气、惊讶、困惑、担心、爱、疲惫、兴奋
- 情感强度计算
- 根据情感建议回复风格
- 自动添加情感 Emoji

### 5. 图片智能处理

新增 `imageManager.ts`：

- **VLM 图片识别**: 使用视觉语言模型识别图片内容
- **表情包检测**: 自动识别图片是否为表情包
- **表情包偷取**: 自动保存群友发送的表情包
- **图片格式检测**: 支持 GIF/APNG/WebP/PNG/JPG

### 6. 表情包系统

新增 `emojiManager.ts`：

- 本地表情包管理
- 根据情感自动匹配表情包
- 表情包统计和随机发送

### 7. 人员档案系统

新增 `personInfoManager.ts`：

- 用户档案管理
- 交互历史记录
- 群组上下文关联

### 8. 表达学习系统

新增 `expressionLearner.ts`：

- 学习用户表达方式
- 自动优化回复风格

---

## 🔧 新增插件系统

### 插件架构

新增完整的插件管理系统 (`plugins/index.ts`)：

| 插件 | 功能 | 命令 |
|------|------|------|
| **WebSearch** | 网络搜索 | `/search <关键词>` |
| **ChatSummary** | 聊天摘要 | `/summary [today\|user <id>]` |
| **Diary** | 日记功能 | `/diary [list\|today\|generate]` |
| **Memory** | 记忆管理 | `/memory [list\|add\|search\|clear\|stats\|share]` |
| **UrlSummary** | URL摘要 | 自动检测URL并摘要 |
| **SmartSegmentation** | 智能分段 | `/smart_seg [on\|off\|status]` |
| **PokeEnhancer** | 戳一戳增强 | 「戳我」触发 |

---

## ⚙️ 配置增强

### 新增配置项

```jsonc
{
  // 主群配置
  "primaryGroup": 12345678,
  
  // 群组独立配置
  "groupChannels": {
    "12345678": {
      "name": "主群",
      "isPrimary": true,
      "talkValue": 0.8,
      "requireMention": false,
      "historyLimit": 10
    }
  },
  
  // 发言频率控制
  "talkValue": 0.5,
  
  // 图片识别
  "enableImageRecognition": true,
  "imageRecognitionPrompt": "请简洁描述这张图片的内容",
  
  // 内容审核
  "enableModeration": true,
  "autoMuteMaxDuration": 60,
  "requireAdminApprovalForKick": true,
  
  // 表情包自动发送
  "autoSendEmoji": false,
  "autoSendEmojiProbability": 0.3,
  "autoSendEmojiMinIntensity": 0.5,
  
  // URL摘要
  "enableUrlSummary": true,
  
  // 智能分段
  "enableSmartSegmentationLLM": false,
  
  // 自定义模型调用
  "useCustomModelCaller": false
}
```

### 群组独立配置

每个群可以独立配置：

- `talkValue`: 发言概率
- `requireMention`: 是否需要@
- `historyLimit`: 历史消息数量
- `systemPrompt`: 群专属系统提示词
- `enableModeration`: 是否启用审核
- `keywordTriggers`: 关键词触发列表
- `disabled`: 是否禁用
- `tags`: 群标签

---

## 🛠️ 新增工具 (Tools)

在 `index.ts` 中注册了 10+ 个 AI 可调用的工具：

| 工具名 | 功能 |
|--------|------|
| `qq_group_ban` | 群禁言 (1-5分钟) |
| `qq_group_kick` | 群踢人 (需管理员确认) |
| `qq_send_poke` | 戳一戳 |
| `qq_send_emoji` | 发送表情包 |
| `qq_send_emoji_by_emotion` | 根据情感发送表情包 |
| `qq_list_emojis` | 列出表情包 |
| `qq_get_emoji_stats` | 表情包统计 |
| `qq_send_image` | 发送图片 |
| `qq_send_file` | 发送文件 |
| `qq_get_context` | 获取当前上下文 |

---

## 📡 客户端增强

### 新增客户端管理器

```typescript
// 原版: 直接使用 Map
const clients = new Map<string, OneBotClient>();

// 新版: 专用管理器
class QQClientManager {
  registerClient(accountId: string, client: OneBotClient): void;
  unregisterClient(accountId: string): void;
  getClient(accountId: string): OneBotClient | undefined;
}
```

### 新增消息队列

- 断线时消息缓存
- 连接恢复后自动发送
- 更好的错误处理

### 新增 API 方法

| 方法 | 功能 |
|------|------|
| `sendEmojiToGroup()` | 发送表情包到群 |
| `sendEmojiToPrivate()` | 发送表情包到私聊 |
| `sendImageToGroup()` | 发送图片到群 |
| `sendImageToPrivate()` | 发送图片到私聊 |
| `sendImageUrlToGroup()` | 通过URL发送图片 |
| `sendImageUrlToPrivate()` | 通过URL发送图片 |
| `getGroupMemberList()` | 获取群成员列表 |
| `isConnected()` | 检查连接状态 |
| `waitForConnection()` | 等待连接 |

---

## 🔄 消息处理增强

### 消息队列管理

新增 `messageQueue.ts`：

- **优先级队列**: @消息优先处理
- **动态发言概率**: 根据对话历史调整
- **上下文聚合**: 合并连续消息
- **超时清理**: 自动清理过期消息

### 消息上下文

新增 `messageContext.ts`：

- 跟踪当前消息上下文
- 支持按群/用户查询历史上下文

---

## 📝 类型定义扩展

### 原版类型

```typescript
export type OneBotMessageSegment =
  | { type: "text"; data: { text: string } }
  | { type: "image"; data: { file: string; url?: string } }
  | { type: "at"; data: { qq: string } }
  | { type: "reply"; data: { id: string } };
```

### 新版类型

```typescript
export type OneBotMessageSegment =
  | { type: "text"; data: { text: string } }
  | { type: "image"; data: { file: string; url?: string; subtype?: number; summary?: string } }
  | { type: "at"; data: { qq: string } }
  | { type: "reply"; data: { id: string } }
  | { type: "face"; data: { id: number } }
  | { type: "record"; data: { file: string } }
  | { type: "video"; data: { file: string } }
  | { type: "music"; data: { type: string; id: string } }
  | { type: "tts"; data: { text: string } };

// 新增接口
export interface ImageMessageOptions { ... }
export interface EmojiMessageOptions { ... }
```

---

## 🎯 命令系统增强

### 原版命令

```
/status - 状态
/mute @用户 [分] - 禁言
/kick @用户 - 踢出
/help - 帮助
```

### 新版命令

```
/status - 状态 (增强版，显示更多统计)
/mute @用户 [分] - 禁言
/kick @用户 - 踢出
/help - 帮助
/chat t <数值> - 设置发言频率 (0-1)
/chat s - 显示当前状态
/emoji list - 表情包统计
/random_emoji - 随机表情包
/search <关键词> - 网络搜索
/summary [today|user <id>] - 聊天摘要
/diary [list|today|generate] - 日记功能
/memory [list|add|search|clear|stats|share] - 记忆管理
/smart_seg [on|off|status] - 智能分段开关
```

---

## 📊 系统提示词增强

### 原版

```
<system>自定义系统提示词</system>
<history>历史消息</history>
用户消息
```

### 新版

```xml
<sender>
QQ号: 12345678
昵称: 用户名
群号: 87654321
群名片: 群名片
是否@: 是
</sender>

<chat_info>
类型: 群聊
群号: 87654321
群名: 群名称
是否主群: 是
</chat_info>

<queue_context>
队列上下文消息
</queue_context>

<system>自定义系统提示词</system>

<primary_group>这是主群消息，请优先认真回复。</primary_group>

<history>历史消息</history>

<person>用户档案信息</person>

<emotion>
用户情感: happy (强度: 80%)
关键词: 开心, 哈哈
情感表情: 😊
建议回复风格: 积极、热情、分享快乐
</emotion>

<pfc_decision>
决策推理: 用户正在分享快乐，应该积极回应
建议回复方向: 分享用户的喜悦
</pfc_decision>

用户消息
```

---

## 📁 文件结构对比

### 原版结构

```
openclaw_QQ_plugin/
├── index.ts
├── package.json
├── openclaw.plugin.json
├── README.md
└── src/
    ├── channel.ts
    ├── client.ts
    ├── config.ts
    ├── runtime.ts
    └── types.ts
```

### 新版结构

```
qq/
├── index.ts
├── package.json
├── package-lock.json
├── openclaw.plugin.json
├── README.md
├── tsconfig.json
└── src/
    ├── channel.ts
    ├── client.ts
    ├── config.ts
    ├── runtime.ts
    ├── types.ts
    ├── emotionAnalyzer.ts
    ├── messageContext.ts
    ├── messageQueue.ts
    ├── core/
    │   ├── index.ts
    │   ├── config.ts
    │   ├── modelCaller.ts
    │   ├── brain/
    │   │   ├── index.ts
    │   │   └── pfc/
    │   │       ├── index.ts
    │   │       ├── pfc.ts
    │   │       ├── actionPlanner.ts
    │   │       ├── chatObserver.ts
    │   │       └── conversationInfo.ts
    │   ├── dream/
    │   │   ├── index.ts
    │   │   └── dreamManager.ts
    │   ├── emoji/
    │   │   ├── index.ts
    │   │   └── emojiManager.ts
    │   ├── expression/
    │   │   ├── index.ts
    │   │   └── expressionLearner.ts
    │   ├── heartflow/
    │   │   ├── index.ts
    │   │   ├── frequencyControl.ts
    │   │   └── heartFCChat.ts
    │   ├── image/
    │   │   ├── index.ts
    │   │   └── imageManager.ts
    │   ├── knowledge/
    │   │   ├── index.ts
    │   │   └── knowledgeManager.ts
    │   ├── memory/
    │   │   ├── index.ts
    │   │   ├── memoryRetrieval.ts
    │   │   └── thinkingBack.ts
    │   ├── message/
    │   │   ├── index.ts
    │   │   ├── messageParser.ts
    │   │   └── messageProcessor.ts
    │   ├── moderation/
    │   │   ├── index.ts
    │   │   └── contentModeration.ts
    │   ├── person/
    │   │   ├── index.ts
    │   │   └── personInfoManager.ts
    │   ├── planner/
    │   │   ├── index.ts
    │   │   ├── actionManager.ts
    │   │   └── actionPlanner.ts
    │   └── replyer/
    │       ├── index.ts
    │       └── replyGenerator.ts
    └── plugins/
        ├── index.ts
        ├── chatSummary.ts
        ├── diary.ts
        ├── memory.ts
        ├── pokeEnhancer.ts
        ├── smartSegmentation.ts
        ├── urlSummary.ts
        └── webSearch.ts
```

---

## 🔗 依赖关系

原版和修改版的 `package.json` 依赖相同：

```json
{
  "dependencies": {
    "ws": "^8.18.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "openclaw": "*",
    "typescript": "^5.9.3"
  }
}
```

---

## 📌 升级建议

从原版升级到修改版：

1. **备份数据**: 备份现有配置文件
2. **更新配置**: 添加新的配置项到 `openclaw.json`
3. **创建数据目录**: 
   - `data/emoji/` - 表情包存储
   - `data/images/` - 图片缓存
4. **配置模型任务**: 如需使用自定义模型轮播，配置 `modelTasks`
5. **测试功能**: 逐一测试新功能

---

## 🙏 致谢

- 原版项目: [Xiaji-yu/openclaw_QQ_plugin](https://github.com/Xiaji-yu/openclaw_QQ_plugin)
- OpenClaw 主项目
