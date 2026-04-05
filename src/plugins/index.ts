import { PokeEnhancer } from './pokeEnhancer.js';
import { WebSearch } from './webSearch.js';
import { ChatSummary } from './chatSummary.js';
import { UrlSummary } from './urlSummary.js';
import { DiaryManager } from './diary.js';
import { MemoryManager } from './memory.js';
import { SmartSegmentation } from './smartSegmentation.js';

export interface PluginContext {
  userId: number;
  groupId?: number;
  isGroup: boolean;
  text: string;
  senderName: string;
  config: any;
  client: any;
  runtime?: any;
  cfg?: any;
}

export interface PluginResult {
  handled: boolean;
  response?: string;
  error?: string;
}

export class PluginManager {
  private pokeEnhancer: PokeEnhancer;
  private webSearch: WebSearch;
  private chatSummary: ChatSummary;
  private urlSummary: UrlSummary;
  private diaryManager: DiaryManager;
  private memoryManager: MemoryManager;
  private smartSegmentation: SmartSegmentation;

  constructor() {
    this.pokeEnhancer = new PokeEnhancer();
    this.webSearch = new WebSearch();
    this.chatSummary = new ChatSummary();
    this.urlSummary = new UrlSummary();
    this.diaryManager = new DiaryManager();
    this.memoryManager = new MemoryManager();
    this.smartSegmentation = new SmartSegmentation();
  }

  async initialize(config: any): Promise<void> {
    await this.pokeEnhancer.initialize(config);
    await this.webSearch.initialize(config);
    await this.chatSummary.initialize(config);
    await this.urlSummary.initialize(config);
    await this.diaryManager.initialize(config);
    await this.memoryManager.initialize(config);
    await this.smartSegmentation.initialize(config);
    
    this.memoryManager.setOnAutoDiary(async (chatId: string) => {
      console.log(`[PluginManager] 📝 触发自动日记生成: ${chatId}`);
      const diary = await this.diaryManager.generateSilentDiary(chatId);
      if (diary) {
        console.log(`[PluginManager] ✅ 自动日记已生成，不发送到QQ`);
      }
    });

    this.memoryManager.setOnContextCompress((chatId: string, summary: string) => {
      console.log(`[PluginManager] 🗜️ 上下文已整理: ${chatId}`);
      console.log(summary);
    });

    this.diaryManager.setOnDiaryGenerated((chatId: string, diary) => {
      console.log(`[PluginManager] 📝 日记已生成: ${chatId}, 日期: ${diary.date}`);
    });

    console.log('[PluginManager] 所有插件初始化完成');
  }

  async handleMessage(ctx: PluginContext): Promise<PluginResult> {
    if (ctx.text.match(/\/smart_seg/i)) {
      return this.smartSegmentation.handle(ctx);
    }

    if (ctx.text.includes('戳') && ctx.text.includes('我')) {
      return this.pokeEnhancer.handle(ctx);
    }

    const searchPatterns = ['搜索', '搜一下', '查一下', 'bing', '百度'];
    for (const pattern of searchPatterns) {
      if (ctx.text.toLowerCase().includes(pattern)) {
        return this.webSearch.handle(ctx);
      }
    }

    const urlPattern = /https?:\/\/[^\s]+/i;
    if (urlPattern.test(ctx.text)) {
      const urlResult = await this.urlSummary.handle(ctx);
      if (urlResult.handled) return urlResult;
    }

    if (ctx.text.includes('/summary') || ctx.text.includes('/摘要')) {
      return this.chatSummary.handle(ctx);
    }

    if (ctx.text.includes('/diary') || ctx.text.includes('/日记')) {
      return this.diaryManager.handle(ctx);
    }

    if (ctx.text.includes('/memory') || ctx.text.includes('/记忆')) {
      return this.memoryManager.handle(ctx);
    }

    return { handled: false };
  }

  getPokeEnhancer(): PokeEnhancer { return this.pokeEnhancer; }
  getWebSearch(): WebSearch { return this.webSearch; }
  getChatSummary(): ChatSummary { return this.chatSummary; }
  getUrlSummary(): UrlSummary { return this.urlSummary; }
  getDiaryManager(): DiaryManager { return this.diaryManager; }
  getMemoryManager(): MemoryManager { return this.memoryManager; }
  getSmartSegmentation(): SmartSegmentation { return this.smartSegmentation; }
}

export const pluginManager = new PluginManager();
export { PokeEnhancer } from './pokeEnhancer.js';
export { WebSearch } from './webSearch.js';
export { ChatSummary } from './chatSummary.js';
export { UrlSummary } from './urlSummary.js';
export { DiaryManager } from './diary.js';
export { MemoryManager } from './memory.js';
export { SmartSegmentation } from './smartSegmentation.js';
