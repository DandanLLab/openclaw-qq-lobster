import type { MessageInfo } from "../config.js";
import {
  callWithModelRotation,
  getModelTaskConfig,
  getProviders,
  type ModelCallOptions,
} from "../modelCaller.js";

interface ExpressionRecord {
  situation: string;
  style: string;
  contentList: string[];
  count: number;
  lastActiveTime: number;
  createTime: number;
  chatId: string;
  checked: boolean;
  rejected: boolean;
}

interface JargonEntry {
  content: string;
  meaning: string;
  context: string;
  createTime: number;
  chatId: string;
}

const LEARN_STYLE_PROMPT = `{chat_str}
你的名字是{bot_name},现在请你完成两个提取任务
任务1：请从上面这段群聊中用户的语言风格和说话方式
1. 只考虑文字，不要考虑表情包和图片
2. 不要总结SELF的发言，因为这是你自己的发言，不要重复学习你自己的发言
3. 不要涉及具体的人名，也不要涉及具体名词
4. 思考有没有特殊的梗，一并总结成语言风格
5. 例子仅供参考，请严格根据群聊内容总结!!!
注意：总结成如下格式的规律，总结的内容要详细，但具有概括性：
例如：当"AAAAA"时，可以"BBBBB", AAAAA代表某个场景，不超过20个字。BBBBB代表对应的语言风格，特定句式或表达方式，不超过20个字。
表达方式在3-5个左右，不要超过10个

任务2：请从上面这段聊天内容中提取"可能是黑话"的候选项（黑话/俚语/网络缩写/口头禅）。
- 必须为对话中真实出现过的短词或短语
- 必须是你无法理解含义的词语，没有明确含义的词语，请不要选择有明确含义，或者含义清晰的词语
- 排除：人名、@、表情包/图片中的内容、纯标点、常规功能词（如的、了、呢、啊等）
- 每个词条长度建议 2-8 个字符（不强制），尽量短小
- 请你提取出可能的黑话，最多30个黑话，请尽量提取所有

输出要求：
将表达方式，语言风格和黑话以 JSON 数组输出，每个元素为一个对象，结构如下：
[
  {{"situation": "AAAAA", "style": "BBBBB", "source_id": "3"}},
  {{"situation": "CCCC", "style": "DDDD", "source_id": "7"}},
  {{"content": "词条", "source_id": "12"}}
]

其中：
表达方式条目：
- situation：表示"在什么情境下"的简短概括（不超过20个字）
- style：表示对应的语言风格或常用表达（不超过20个字）
- source_id：该表达方式对应的"来源行编号"
黑话jargon条目：
- content:表示黑话的内容
- source_id：该黑话对应的"来源行编号"

现在请你输出 JSON：`;

export class ExpressionLearner {
  private chatId: string;
  private config: any;
  private expressionStore: Map<string, ExpressionRecord> = new Map();
  private jargonStore: Map<string, JargonEntry> = new Map();
  private learningLock: boolean = false;

  constructor(chatId: string, config?: any) {
    this.chatId = chatId;
    this.config = config || {};
  }

  async learnAndStore(messages: MessageInfo[]): Promise<Array<[string, string]>> {
    if (!messages || messages.length === 0) {
      return [];
    }

    if (this.learningLock) {
      console.log(`[ExpressionLearner] 学习任务正在进行中，跳过本次学习`);
      return [];
    }

    this.learningLock = true;

    try {
      const chatStr = this.buildChatString(messages);
      const prompt = LEARN_STYLE_PROMPT
        .replace("{bot_name}", this.config?.bot?.nickname || "助手")
        .replace("{chat_str}", chatStr);

      const result = await this.callLLM(prompt, 0.3);

      if (!result.success || !result.content) {
        console.error(`[ExpressionLearner] 学习表达方式失败: ${result.error}`);
        return [];
      }

      const { expressions, jargons } = this.parseExpressionResponse(result.content);

      if (expressions.length > 20) {
        console.log(`[ExpressionLearner] 表达方式提取数量超过20个，放弃本次表达学习`);
        return [];
      }

      if (jargons.length > 30) {
        console.log(`[ExpressionLearner] 黑话提取数量超过30个，放弃本次黑话学习`);
      }

      const filteredExpressions = this.filterExpressions(expressions, messages);

      const currentTime = Date.now();
      for (const [situation, style] of filteredExpressions) {
        await this.upsertExpressionRecord(situation, style, currentTime);
      }

      const learntStr = filteredExpressions.map(([s, st]) => `${s}->${st}`).join("\n");
      console.log(`[ExpressionLearner] 在 ${this.chatId} 学习到表达风格:\n${learntStr}`);

      return filteredExpressions;
    } catch (error) {
      console.error(`[ExpressionLearner] 学习过程出错:`, error);
      return [];
    } finally {
      this.learningLock = false;
    }
  }

  private buildChatString(messages: MessageInfo[]): string {
    return messages
      .map((msg, i) => `[${i + 1}] ${msg.senderName || "用户"}: ${msg.content}`)
      .join("\n");
  }

  private parseExpressionResponse(response: string): {
    expressions: Array<[string, string, string]>;
    jargons: Array<[string, string]>;
  } {
    const expressions: Array<[string, string, string]> = [];
    const jargons: Array<[string, string]> = [];

    try {
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return { expressions, jargons };
      }

      const jsonStr = jsonMatch[1] || jsonMatch[0];
      const parsed = JSON.parse(jsonStr);

      if (!Array.isArray(parsed)) {
        return { expressions, jargons };
      }

      for (const item of parsed) {
        if (item.situation && item.style) {
          expressions.push([item.situation, item.style, item.source_id || ""]);
        } else if (item.content) {
          jargons.push([item.content, item.source_id || ""]);
        }
      }
    } catch (error) {
      console.warn(`[ExpressionLearner] 解析响应失败:`, error);
    }

    return { expressions, jargons };
  }

  private filterExpressions(
    expressions: Array<[string, string, string]>,
    messages: MessageInfo[]
  ): Array<[string, string]> {
    const filtered: Array<[string, string]> = [];
    const bannedNames = new Set<string>();

    const botNickname = (this.config?.bot?.nickname || "").trim();
    if (botNickname) bannedNames.add(botNickname.toLowerCase());

    const aliasNames = this.config?.bot?.aliasNames || [];
    for (const alias of aliasNames) {
      if (alias?.trim()) bannedNames.add(alias.trim().toLowerCase());
    }

    for (const [situation, style, sourceId] of expressions) {
      const sourceIdStr = (sourceId || "").trim();
      if (!sourceIdStr || !/^\d+$/.test(sourceIdStr)) {
        continue;
      }

      const lineIndex = parseInt(sourceIdStr) - 1;
      if (lineIndex < 0 || lineIndex >= messages.length) {
        continue;
      }

      if (
        situation.includes("SELF") ||
        style.includes("SELF") ||
        situation.includes("表情") ||
        style.includes("表情") ||
        situation.includes("[图片") ||
        style.includes("[图片")
      ) {
        continue;
      }

      const normalizedStyle = style.trim().toLowerCase();
      if (bannedNames.has(normalizedStyle)) {
        continue;
      }

      filtered.push([situation, style]);
    }

    return filtered;
  }

  private async upsertExpressionRecord(
    situation: string,
    style: string,
    currentTime: number
  ): Promise<void> {
    const key = `${this.chatId}:${situation}`;
    const existing = this.expressionStore.get(key);

    if (existing) {
      existing.contentList.push(situation);
      existing.count += 1;
      existing.checked = false;
      existing.lastActiveTime = currentTime;
    } else {
      const record: ExpressionRecord = {
        situation,
        style,
        contentList: [situation],
        count: 1,
        lastActiveTime: currentTime,
        createTime: currentTime,
        chatId: this.chatId,
        checked: false,
        rejected: false,
      };
      this.expressionStore.set(key, record);
    }
  }

  getExpressionHabits(maxNum: number = 8): { block: string; selectedIds: number[] } {
    const allExpressions = Array.from(this.expressionStore.values())
      .filter(r => !r.rejected && r.count >= 1);

    if (allExpressions.length === 0) {
      return { block: "", selectedIds: [] };
    }

    const shuffled = allExpressions.sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, Math.min(maxNum, shuffled.length));

    const styleHabits: string[] = [];
    const selectedIds: number[] = [];

    selected.forEach((expr, idx) => {
      styleHabits.push(`当${expr.situation}时：${expr.style}`);
      selectedIds.push(idx);
    });

    const block = styleHabits.length > 0
      ? `在回复时，你可以参考以下的语言习惯，不要生硬使用：\n${styleHabits.join("\n")}`
      : "";

    return { block, selectedIds };
  }

  private async callLLM(prompt: string, temperature: number = 0.3): Promise<{
    success: boolean;
    content?: string;
    error?: string;
  }> {
    try {
      const providers = getProviders(this.config);
      const taskConfig = getModelTaskConfig(this.config, "toolUse");

      if (!taskConfig || !taskConfig.models?.length) {
        return { success: false, error: "未配置toolUse模型任务" };
      }

      const options: ModelCallOptions = {
        messages: [{ role: "user", content: prompt }],
        maxTokens: 2048,
        temperature,
        timeout: 60000,
      };

      const result = await callWithModelRotation(providers, taskConfig, options);

      return {
        success: result.success,
        content: result.content,
        error: result.error,
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  getStats(): { totalExpressions: number; totalJargons: number } {
    return {
      totalExpressions: this.expressionStore.size,
      totalJargons: this.jargonStore.size,
    };
  }
}

export class ExpressionLearnerManager {
  private learners: Map<string, ExpressionLearner> = new Map();
  private config: any;

  constructor(config?: any) {
    this.config = config;
  }

  getLearner(chatId: string): ExpressionLearner {
    if (!this.learners.has(chatId)) {
      this.learners.set(chatId, new ExpressionLearner(chatId, this.config));
    }
    return this.learners.get(chatId)!;
  }
}
