import type { MessageInfo } from "../config.js";
import {
  callWithModelRotation,
  getModelTaskConfig,
  getProviders,
  type ModelCallOptions,
} from "../modelCaller.js";

interface ChatHistoryRecord {
  id: string;
  chatId: string;
  theme: string;
  summary: string;
  keywords: string[];
  keyPoints: string[];
  participants: string[];
  startTime: number;
  endTime: number;
  createTime: number;
}

interface DreamTool {
  name: string;
  description: string;
  parameters: Array<{ name: string; type: string; description: string; required: boolean }>;
  execute: (params: Record<string, unknown>) => Promise<string>;
}

const DREAM_HEAD_PROMPT = `你的名字是{bot_name}，你现在处于"梦境维护模式（dream agent）"。
你可以自由地在 ChatHistory 库中探索、整理、创建和删改记录，以帮助自己在未来更好地回忆和理解对话历史。

本轮要维护的聊天ID：{chat_id}
本轮随机选中的起始记忆 ID：{start_memory_id}
请优先以这条起始记忆为切入点，先理解它的内容与上下文，再决定如何在其附近进行创建新概括、重写或删除等整理操作。

你可以使用的工具包括：
- search_chat_history：根据关键词或参与人搜索历史记忆概括列表
- get_chat_history_detail：查看某条概括的详细内容
- create_chat_history：创建一条新的 ChatHistory 概括记录
- update_chat_history：重写或精炼主题、概括、关键词、关键信息
- delete_chat_history：删除明显冗余、噪声、错误或无意义的记录
- finish_maintenance：结束本次维护

**工作目标**：
- 发现冗余、重复或高度相似的记录，并进行合并或删除
- 发现主题/概括过于含糊、啰嗦或缺少关键信息的记录，进行重写和精简
- 尽量保持信息的真实与可用性，不要凭空捏造事实

**轮次信息**：
- 本次维护最多执行 {max_iterations} 轮
- 如果提前完成维护工作，可以调用 finish_maintenance 工具主动结束`;

export class DreamManager {
  private chatId: string;
  private config: any;
  private historyStore: Map<string, ChatHistoryRecord> = new Map();
  private tools: Map<string, DreamTool> = new Map();
  private maintenanceFinished: boolean = false;

  constructor(chatId: string, config?: any) {
    this.chatId = chatId;
    this.config = config || {};
    this.initTools();
  }

  private initTools(): void {
    this.registerTool({
      name: "search_chat_history",
      description: "根据关键词或参与人查询当前 chat_id 下的 ChatHistory 概览",
      parameters: [
        { name: "keyword", type: "string", description: "关键词", required: false },
        { name: "participant", type: "string", description: "参与人昵称", required: false },
      ],
      execute: async (params) => {
        const keyword = params.keyword as string;
        const participant = params.participant as string;
        return await this.searchChatHistory(keyword, participant);
      },
    });

    this.registerTool({
      name: "get_chat_history_detail",
      description: "根据 memory_id 获取单条 ChatHistory 的详细内容",
      parameters: [
        { name: "memory_id", type: "string", description: "ChatHistory ID", required: true },
      ],
      execute: async (params) => {
        const memoryId = params.memory_id as string;
        return await this.getChatHistoryDetail(memoryId);
      },
    });

    this.registerTool({
      name: "create_chat_history",
      description: "创建一条新的 ChatHistory 概括记录",
      parameters: [
        { name: "theme", type: "string", description: "主题标题", required: true },
        { name: "summary", type: "string", description: "概括内容", required: true },
        { name: "keywords", type: "string", description: "关键词JSON数组", required: true },
        { name: "key_points", type: "string", description: "关键信息JSON数组", required: true },
        { name: "start_time", type: "string", description: "起始时间戳", required: true },
        { name: "end_time", type: "string", description: "结束时间戳", required: true },
      ],
      execute: async (params) => {
        return await this.createChatHistory(
          params.theme as string,
          params.summary as string,
          JSON.parse(params.keywords as string || "[]"),
          JSON.parse(params.key_points as string || "[]"),
          parseFloat(params.start_time as string || "0"),
          parseFloat(params.end_time as string || "0")
        );
      },
    });

    this.registerTool({
      name: "update_chat_history",
      description: "按字段更新 ChatHistory 记录",
      parameters: [
        { name: "memory_id", type: "string", description: "ChatHistory ID", required: true },
        { name: "theme", type: "string", description: "新的主题标题", required: false },
        { name: "summary", type: "string", description: "新的概括内容", required: false },
        { name: "keywords", type: "string", description: "新的关键词JSON数组", required: false },
        { name: "key_points", type: "string", description: "新的关键信息JSON数组", required: false },
      ],
      execute: async (params) => {
        return await this.updateChatHistory(
          params.memory_id as string,
          {
            theme: params.theme as string,
            summary: params.summary as string,
            keywords: params.keywords ? JSON.parse(params.keywords as string) : undefined,
            keyPoints: params.key_points ? JSON.parse(params.key_points as string) : undefined,
          }
        );
      },
    });

    this.registerTool({
      name: "delete_chat_history",
      description: "根据 memory_id 删除一条 ChatHistory 记录",
      parameters: [
        { name: "memory_id", type: "string", description: "ChatHistory ID", required: true },
      ],
      execute: async (params) => {
        return await this.deleteChatHistory(params.memory_id as string);
      },
    });

    this.registerTool({
      name: "finish_maintenance",
      description: "结束本次 dream 维护任务",
      parameters: [
        { name: "reason", type: "string", description: "结束维护的原因说明", required: false },
      ],
      execute: async (params) => {
        this.maintenanceFinished = true;
        return `维护已结束: ${params.reason || "完成维护"}`;
      },
    });
  }

  private registerTool(tool: DreamTool): void {
    this.tools.set(tool.name, tool);
  }

  async runDreamAgent(maxIterations: number = 15): Promise<void> {
    const startTime = Date.now();
    console.log(`[DreamManager] 开始对 chat_id=${this.chatId} 进行 dream 维护，最多迭代 ${maxIterations} 轮`);

    this.maintenanceFinished = false;

    const startMemoryId = this.pickRandomMemory();
    const headPrompt = DREAM_HEAD_PROMPT
      .replace("{bot_name}", this.config?.bot?.nickname || "助手")
      .replace("{chat_id}", this.chatId)
      .replace("{start_memory_id}", startMemoryId || "无")
      .replace("{max_iterations}", String(maxIterations));

    const conversationMessages: Array<{ role: string; content: string; toolCalls?: any[] }> = [];

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      if (this.maintenanceFinished) {
        console.log(`[DreamManager] 检测到 finish_maintenance，提前结束`);
        break;
      }

      const roundInfo = `【轮次信息】当前是第 ${iteration}/${maxIterations} 轮，还剩 ${maxIterations - iteration + 1} 轮。`;

      const messages = [
        { role: "system", content: headPrompt },
        ...conversationMessages,
        { role: "user", content: roundInfo },
      ];

      const result = await this.callLLMWithTools(messages);

      if (!result.success) {
        console.error(`[DreamManager] 第 ${iteration} 轮 LLM 调用失败: ${result.error}`);
        break;
      }

      if (result.toolCalls && result.toolCalls.length > 0) {
        for (const toolCall of result.toolCalls) {
          const tool = this.tools.get(toolCall.name);
          if (tool) {
            const toolResult = await tool.execute(toolCall.params || {});
            conversationMessages.push({
              role: "assistant",
              content: result.content || "",
              toolCalls: [toolCall],
            });
            conversationMessages.push({
              role: "tool",
              content: toolResult,
            });
          }
        }
      } else if (result.content) {
        conversationMessages.push({
          role: "assistant",
          content: result.content,
        });
      }

      console.log(`[DreamManager] 第 ${iteration} 轮响应，工具调用数=${result.toolCalls?.length || 0}`);
    }

    const cost = (Date.now() - startTime) / 1000;
    console.log(`[DreamManager] 维护结束，耗时 ${cost.toFixed(1)} 秒`);
  }

  private pickRandomMemory(): string | null {
    const ids = Array.from(this.historyStore.keys());
    if (ids.length === 0) return null;
    return ids[Math.floor(Math.random() * ids.length)];
  }

  private async searchChatHistory(keyword?: string, participant?: string): Promise<string> {
    const records = Array.from(this.historyStore.values());

    let filtered = records;
    if (keyword) {
      filtered = filtered.filter(r =>
        r.theme.includes(keyword) ||
        r.summary.includes(keyword) ||
        r.keywords.some(k => k.includes(keyword))
      );
    }
    if (participant) {
      filtered = filtered.filter(r => r.participants.includes(participant));
    }

    return filtered
      .slice(0, 10)
      .map(r => `ID=${r.id}, 主题=${r.theme}, 概括=${r.summary.substring(0, 50)}...`)
      .join("\n");
  }

  private async getChatHistoryDetail(memoryId: string): Promise<string> {
    const record = this.historyStore.get(memoryId);
    if (!record) {
      return `未找到 ID=${memoryId} 的记录`;
    }

    return `ID=${record.id}
主题=${record.theme}
概括=${record.summary}
关键词=${record.keywords.join(", ")}
关键信息=${record.keyPoints.join("; ")}
参与者=${record.participants.join(", ")}`;
  }

  private async createChatHistory(
    theme: string,
    summary: string,
    keywords: string[],
    keyPoints: string[],
    startTime: number,
    endTime: number
  ): Promise<string> {
    const id = `${this.chatId}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;

    const record: ChatHistoryRecord = {
      id,
      chatId: this.chatId,
      theme,
      summary,
      keywords,
      keyPoints,
      participants: [],
      startTime,
      endTime,
      createTime: Date.now(),
    };

    this.historyStore.set(id, record);
    console.log(`[DreamManager] 创建记录: ${theme}`);
    return `创建成功: ID=${id}`;
  }

  private async updateChatHistory(
    memoryId: string,
    updates: Partial<ChatHistoryRecord>
  ): Promise<string> {
    const record = this.historyStore.get(memoryId);
    if (!record) {
      return `未找到 ID=${memoryId} 的记录`;
    }

    Object.assign(record, updates);
    console.log(`[DreamManager] 更新记录: ${record.theme}`);
    return `更新成功: ID=${memoryId}`;
  }

  private async deleteChatHistory(memoryId: string): Promise<string> {
    const deleted = this.historyStore.delete(memoryId);
    if (deleted) {
      console.log(`[DreamManager] 删除记录: ${memoryId}`);
      return `删除成功: ID=${memoryId}`;
    }
    return `未找到 ID=${memoryId} 的记录`;
  }

  private async callLLMWithTools(messages: Array<{ role: string; content: string; toolCalls?: any[] }>): Promise<{
    success: boolean;
    content?: string;
    toolCalls?: Array<{ name: string; params: Record<string, unknown> }>;
    error?: string;
  }> {
    try {
      const providers = getProviders(this.config);
      const taskConfig = getModelTaskConfig(this.config, "toolUse");

      if (!taskConfig || !taskConfig.models?.length) {
        return { success: false, error: "未配置toolUse模型任务" };
      }

      const options: ModelCallOptions = {
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        maxTokens: 2048,
        temperature: 0.3,
        timeout: 60000,
      };

      const result = await callWithModelRotation(providers, taskConfig, options);

      const toolCalls = this.extractToolCalls(result.content || "");

      return {
        success: result.success,
        content: result.content,
        toolCalls,
        error: result.error,
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  private extractToolCalls(content: string): Array<{ name: string; params: Record<string, unknown> }> {
    const toolCalls: Array<{ name: string; params: Record<string, unknown> }> = [];

    const jsonPattern = /```json\s*([\s\S]*?)\s*```/g;
    let match;

    while ((match = jsonPattern.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.tool || parsed.function || parsed.name) {
          toolCalls.push({
            name: parsed.tool || parsed.function || parsed.name,
            params: parsed.params || parsed.arguments || parsed.parameters || {},
          });
        }
      } catch {
        // ignore parse errors
      }
    }

    const funcPattern = /(\w+)\s*\(\s*([^)]*)\s*\)/g;
    while ((match = funcPattern.exec(content)) !== null) {
      const funcName = match[1];
      if (this.tools.has(funcName)) {
        toolCalls.push({
          name: funcName,
          params: {},
        });
      }
    }

    return toolCalls;
  }

  getStats(): { totalRecords: number } {
    return {
      totalRecords: this.historyStore.size,
    };
  }
}

export class DreamScheduler {
  private config: any;
  private managers: Map<string, DreamManager> = new Map();
  private running: boolean = false;

  constructor(config?: any) {
    this.config = config;
  }

  getManager(chatId: string): DreamManager {
    if (!this.managers.has(chatId)) {
      this.managers.set(chatId, new DreamManager(chatId, this.config));
    }
    return this.managers.get(chatId)!;
  }

  async start(intervalMinutes: number = 30): Promise<void> {
    this.running = true;
    console.log(`[DreamScheduler] 启动，间隔 ${intervalMinutes} 分钟`);

    while (this.running) {
      await this.runCycle();
      await this.sleep(intervalMinutes * 60 * 1000);
    }
  }

  stop(): void {
    this.running = false;
  }

  private async runCycle(): Promise<void> {
    const chatIds = Array.from(this.managers.keys());

    if (chatIds.length === 0) {
      return;
    }

    const randomChatId = chatIds[Math.floor(Math.random() * chatIds.length)];
    const manager = this.getManager(randomChatId);

    await manager.runDreamAgent();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
