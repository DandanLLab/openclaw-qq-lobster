import type { PluginContext, PluginResult } from './index.js';

type SegmentationStyle = 'natural' | 'conservative' | 'active';

interface SegmentationConfig {
  enabled: boolean;
  style: SegmentationStyle;
  minLength: number;
  maxSegments: number;
  removeTrailingPeriod: boolean;
}

const STYLE_GUIDES: Record<SegmentationStyle, string> = {
  natural: '像和朋友微信聊天一样自然地分条发送。有的消息短有的长，节奏随意。',
  conservative: '偏沉稳的发消息风格，一条消息说比较完整的内容，不会频繁发短消息。',
  active: '活泼的发消息风格，喜欢发短消息连击，反应词和正文分开发。'
};

const SEGMENTATION_PROMPT_TEMPLATE = `你正在模拟一个人用手机聊天。下面是 ta 想说的内容，请把它分成几条消息，就像真人会怎么一条一条发出来那样。

{style_guide}

规则：
- 去掉每条消息末尾的句号「。」，真人聊天很少用句号结尾
- 保留感叹号、问号、省略号、波浪号等有情绪的标点
- 不要每个逗号都拆开，相关的内容放在一条里
- 消息长短可以不均匀
- 最多分成 {max_segments} 条

原文：{text}

返回 JSON 数组，如 ["消息1", "消息2"]

示例：
原文："我今天去了那个新开的咖啡店，环境还不错。点了一杯拿铁，味道一般般吧，没有之前那家好喝。对了你上次推荐的那本书我看完了，超好看！"
分条：["我今天去了那个新开的咖啡店，环境还不错", "点了一杯拿铁，味道一般般吧，没有之前那家好喝", "对了你上次推荐的那本书我看完了", "超好看！"]

原文："哈哈真的吗，那太好了！我还以为你不喜欢呢。下次我们一起去看电影吧，最近有个新片子挺有意思的。"
分条：["哈哈真的吗", "那太好了！我还以为你不喜欢呢", "下次我们一起去看电影吧，最近有个新片子挺有意思的"]

原文："嗯...这个问题有点复杂，我想想怎么说。简单来说就是你需要先把环境配好，然后再安装依赖。如果还有问题可以再问我。"
分条：["嗯...这个问题有点复杂", "我想想怎么说", "简单来说就是你需要先把环境配好，然后再安装依赖", "如果还有问题可以再问我"]`;

export class SmartSegmentation {
  private enabled: boolean = true;
  private style: SegmentationStyle = 'natural';
  private minLength: number = 20;
  private maxSegments: number = 8;
  private removeTrailingPeriod: boolean = true;
  private runtimeEnabled: boolean = true;

  async initialize(config: any): Promise<void> {
    this.enabled = config.enableSmartSegmentation ?? true;
    this.style = config.segmentationStyle ?? 'natural';
    this.minLength = config.segmentationMinLength ?? 20;
    this.maxSegments = config.segmentationMaxSegments ?? 8;
    this.removeTrailingPeriod = config.removeTrailingPeriod ?? true;
    console.log(`[SmartSegmentation] 初始化完成: enabled=${this.enabled}, runtimeEnabled=${this.runtimeEnabled}, 风格=${this.style}`);
  }

  private shouldFilter(text: string): boolean {
    if (!text) return false;
    const filterPatterns = [
      /^我已经回复过.*的消息了[。，]?\s*这些是重复发送的内容\.?\s*$/i,
      /^我已经回复过.*的消息了[。，]?\s*这些是重复发送的内容\.?\s*NO_REPLY\s*$/i,
      /这些是重复发送的内容/i,
      /^Something went wrong while processing your request/i,
      /^Please try again, or use \/new to start a fresh session/i,
      /NO_REPLY/i,
      /^terminated$/i,
      /^GitHub\s*-\s*.+·\s*GitHub\s*$/i,
      /Contribute to .+ development by creating an account on GitHub/i,
      /^https?:\/\/github\.com\/[^\s]+\.\.\.$/i
    ];
    return filterPatterns.some(pattern => pattern.test(text.trim()));
  }

  private filterDuplicateContent(text: string): string {
    if (!text) return '';
    let filtered = text;
    filtered = filtered.replace(/我已经回复过[^。]*的消息了[。，]?\s*这些是重复发送的内容[。\n]*/gi, '');
    filtered = filtered.replace(/这些是重复发送的内容[。\n]*/gi, '');
    filtered = filtered.replace(/[^\n]*NO_REPLY[^\n]*\n?/gi, '');
    filtered = filtered.replace(/Something went wrong while processing your request[。\n]*/gi, '');
    filtered = filtered.replace(/Please try again, or use \/new to start a fresh session[。\n]*/gi, '');
    filtered = filtered.replace(/\bterminated\b[。\n]*/gi, '');
    filtered = filtered.replace(/^terminated$/gim, '');
    filtered = filtered.replace(/GitHub\s*-\s*[^·]+·\s*GitHub[\s\n]*/gi, '');
    filtered = filtered.replace(/Contribute to [^\n]+development by creating an account on GitHub[\s\n]*/gi, '');
    filtered = filtered.replace(/`https?:\/\/github\.com\/[^\s]+\.\.\.`[\s\n]*/gi, '');
    filtered = filtered.replace(/https?:\/\/github\.com\/[^\s]+\.\.\.[\s\n]*/gi, '');
    filtered = filtered.replace(/[（(][\d一二三四五六七八九十百千万]+字[）)]/gi, '');
  
    const seenUrls = new Set<string>();
    filtered = filtered.replace(/https?:\/\/github\.com\/[^\s]+/gi, (match) => {
      if (seenUrls.has(match)) {
        return '';
      }
      seenUrls.add(match);
      return match;
    });
    
    return filtered.trim();
  }

  async handle(ctx: PluginContext): Promise<PluginResult> {
    const { text } = ctx;

    if (text.match(/\/smart_seg\s+on/i)) {
      this.runtimeEnabled = true;
      return { handled: true, response: '智能分段已开启' };
    }

    if (text.match(/\/smart_seg\s+off/i)) {
      this.runtimeEnabled = false;
      return { handled: true, response: '智能分段已关闭' };
    }

    if (text.match(/\/smart_seg\s+status/i)) {
      return { handled: true, response: `智能分段状态: ${this.runtimeEnabled ? '开启' : '关闭'}` };
    }

    if (text.match(/\/smart_seg$/i)) {
      this.runtimeEnabled = !this.runtimeEnabled;
      return { handled: true, response: `智能分段已${this.runtimeEnabled ? '开启' : '关闭'}` };
    }

    return { handled: false };
  }

  isEnabled(): boolean {
    return this.enabled && this.runtimeEnabled;
  }

  setEnabled(enabled: boolean): void {
    this.runtimeEnabled = enabled;
  }

  setStyle(style: SegmentationStyle): void {
    this.style = style;
  }

  shouldSegment(text: string): boolean {
    console.log(`[SmartSegmentation] 🔍 shouldSegment检查: enabled=${this.enabled}, runtimeEnabled=${this.runtimeEnabled}, textLength=${text?.length || 0}`);
    
    if (!this.enabled || !this.runtimeEnabled) {
      console.log(`[SmartSegmentation] ⚠️ 分段功能未启用，跳过分段`);
      return false;
    }
    if (!text) {
      console.log(`[SmartSegmentation] ⚠️ 文本为空，跳过分段`);
      return false;
    }
    const segmentChars = ['。', '！', '？', '：', '；', '～', '…', '.', '!', '?', ':', ';',  '（', '(', '）', ')'];
    const hasSegmentChar = segmentChars.some(char => text.includes(char));
    console.log(`[SmartSegmentation] 🔍 包含分段字符: ${hasSegmentChar}`);
    return hasSegmentChar;
  }

  stripThinkingContent(text: string): string {
    if (!text) return '';
    
    let cleaned = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    cleaned = cleaned.replace(/<\/?thinking>/gi, '');
    cleaned = cleaned.replace(/<思考>[\s\S]*?<\/思考>/gi, '');
    cleaned = cleaned.replace(/<\/?思考>/gi, '');
    return cleaned.trim();
  }

  removePeriod(text: string): string {
    if (!text) return '';
    return text.replace(/[。.]$/g, '');
  }

  convertEnglishPunctuation(text: string): string {
    if (!text) return '';
    let result = text.replace(/:/g, '：');
    result = result.replace(/"/g, '"');
    result = result.replace(/"/g, '"');
    
    let inQuote = false;
    let converted = '';
    for (let i = 0; i < result.length; i++) {
      const char = result[i];
      if (char === '"') {
        if (!inQuote) {
          converted += '"';
          inQuote = true;
        } else {
          converted += '"';
          inQuote = false;
        }
      } else {
        converted += char;
      }
    }
    
    return converted;
  }

  simpleSegment(text: string): string[] {
    console.log(`[SmartSegmentation] 🔪 开始分段, 文本长度: ${text.length}`);
    
    let processed = this.stripThinkingContent(text);
    processed = this.convertEnglishPunctuation(processed);
    
    const codeBlocks: { start: number; end: number; content: string }[] = [];
    const codeBlockRegex = /```[\s\S]*?```/g;
    let match;
    while ((match = codeBlockRegex.exec(processed)) !== null) {
      codeBlocks.push({ start: match.index, end: match.index + match[0].length, content: match[0] });
    }
    
    console.log(`[SmartSegmentation] 🔪 发现 ${codeBlocks.length} 个代码块`);
    
    const segments: string[] = [];
    let current = '';
    let i = 0;
    
    const isInCodeBlock = (pos: number): boolean => {
      return codeBlocks.some(block => pos >= block.start && pos < block.end);
    };
    
    const findQuoteEnd = (start: number, quoteChar: string): number => {
      for (let j = start + 1; j < processed.length; j++) {
        if (processed[j] === quoteChar) {
          return j;
        }
      }
      return -1;
    };
    
    const findBracketEnd = (start: number, openChar: string): number => {
      const closeChar = openChar === '（' ? '）' : openChar === '(' ? ')' : openChar === '【' ? '】' : openChar === '[' ? ']' : openChar;
      let depth = 1;
      for (let j = start + 1; j < processed.length; j++) {
        if (processed[j] === openChar) {
          depth++;
        } else if (processed[j] === closeChar) {
          depth--;
          if (depth === 0) {
            return j;
          }
        }
      }
      return processed.length - 1;
    };
    
    const quotePairs: { start: number; end: number }[] = [];
    const bracketPairs: { start: number; end: number }[] = [];
    
    const quoteChars = ['"', '"', '"', "'", '"'];
    const bracketChars = ['(', '（', '[', '【'];
    
    let tempProcessed = processed;
    for (let j = 0; j < tempProcessed.length; j++) {
      if (quoteChars.includes(tempProcessed[j])) {
        const endPos = findQuoteEnd(j, tempProcessed[j]);
        if (endPos > j) {
          quotePairs.push({ start: j, end: endPos });
          j = endPos;
        }
      }
    }
    
    for (let j = 0; j < tempProcessed.length; j++) {
      if (bracketChars.includes(tempProcessed[j])) {
        const endPos = findBracketEnd(j, tempProcessed[j]);
        if (endPos > j) {
          bracketPairs.push({ start: j, end: endPos });
          j = endPos;
        }
      }
    }
    
    const isInQuote = (pos: number): boolean => {
      return quotePairs.some(pair => pos > pair.start && pos < pair.end);
    };
    
    const isInBracket = (pos: number): boolean => {
      return bracketPairs.some(pair => pos >= pair.start && pos <= pair.end);
    };
    
    const getBracketPair = (pos: number): { start: number; end: number } | null => {
      return bracketPairs.find(pair => pos === pair.start) || null;
    };
    
    const isRegexBracket = (pair: { start: number; end: number }): boolean => {
      const content = processed.substring(pair.start + 1, pair.end);
      const regexChars = ['|', '*', '?', '+', '.', '\\', '^', '$', '{', '}'];
      return regexChars.some(c => content.includes(c));
    };
    
    const isPrefixColon = (pos: number): boolean => {
      const prefixes = ['ps', 'PS', 'Ps', 'pS', 'PS', 'ps', 'Ps', 'PS'];
      const beforeColon = processed.substring(Math.max(0, pos - 10), pos).toLowerCase().trim();
      for (const prefix of prefixes) {
        if (beforeColon.endsWith(prefix) || beforeColon.endsWith(prefix + ' ')) {
          return true;
        }
      }
      return false;
    };
    
    while (i < processed.length) {
      const char = processed[i];
      
      if (isInCodeBlock(i)) {
        const block = codeBlocks.find(b => i >= b.start && i < b.end);
        if (block && i === block.start) {
          if (current.trim()) {
            segments.push(this.removePeriod(current.trim()));
            current = '';
          }
          segments.push(block.content);
          i = block.end;
          continue;
        }
        current += char;
        i++;
        continue;
      }
      
      const bracketPair = getBracketPair(i);
      if (bracketPair && !isRegexBracket(bracketPair)) {
        if (current.trim()) {
          segments.push(this.removePeriod(current.trim()));
          current = '';
        }
        const bracketContent = processed.substring(bracketPair.start, bracketPair.end + 1);
        segments.push(bracketContent);
        i = bracketPair.end + 1;
        continue;
      }
      
      current += char;
      
      const segmentChars = ['。', '！', '？', '：', '；', '～', '…', '.', '!', '?', ';', '~'];
      const isEllipsis = char === '…';
      
      if (isInQuote(i)) {
        i++;
        continue;
      }
      
      if (char === '：' || char === ':') {
        if (isPrefixColon(i)) {
          i++;
          continue;
        }
      }
      
      if (isEllipsis) {
        while (i + 1 < processed.length && processed[i + 1] === '…') {
          current += processed[i + 1];
          i++;
        }
        if (current.trim()) {
          segments.push(this.removePeriod(current.trim()));
          current = '';
        }
      } else if (segmentChars.includes(char)) {
        if (current.trim()) {
          segments.push(this.removePeriod(current.trim()));
          current = '';
        }
      }
      
      i++;
    }
    
    if (current.trim()) {
      segments.push(this.removePeriod(current.trim()));
    }
    
    const finalSegments = segments.filter(s => s.trim());
    
    const deduplicatedSegments = this.removeDuplicateSegments(finalSegments);
    
    console.log(`[SmartSegmentation] 🔪 分段完成: ${deduplicatedSegments.length} 段`);
    deduplicatedSegments.forEach((seg, idx) => {
      console.log(`[SmartSegmentation]   段${idx + 1}: ${seg.substring(0, 50)}${seg.length > 50 ? '...' : ''}`);
    });
    
    return deduplicatedSegments.slice(0, this.maxSegments);
  }

  private removeDuplicateSegments(segments: string[]): string[] {
    if (segments.length <= 1) return segments;
    
    const result: string[] = [];
    const seen = new Set<string>();
    
    for (const seg of segments) {
      const normalized = seg.trim().toLowerCase();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        result.push(seg);
      }
    }
    
    if (result.length < segments.length) {
      console.log(`[SmartSegmentation] 🔄 去重: ${segments.length} -> ${result.length} 段`);
    }
    
    return result;
  }

  buildPrompt(text: string): string {
    return SEGMENTATION_PROMPT_TEMPLATE
      .replace('{style_guide}', STYLE_GUIDES[this.style])
      .replace('{max_segments}', String(this.maxSegments))
      .replace('{text}', text);
  }

  async segmentWithLLM(
    text: string,
    llmCall: (prompt: string) => Promise<string>
  ): Promise<string[]> {
    if (!this.shouldSegment(text)) {
      return [this.removeTrailingPeriod ? this.removePeriod(text) : text];
    }

    const visibleText = this.stripThinkingContent(text);
    if (!visibleText) {
      return [];
    }

    if (visibleText.length < this.minLength) {
      return [this.removeTrailingPeriod ? this.removePeriod(visibleText) : visibleText];
    }

    try {
      const prompt = this.buildPrompt(visibleText);
      const result = await llmCall(prompt);

      let jsonStr = result.trim();
      if (jsonStr.includes('```json')) {
        jsonStr = jsonStr.split('```json')[1].split('```')[0].trim();
      } else if (jsonStr.includes('```')) {
        jsonStr = jsonStr.split('```')[1].split('```')[0].trim();
      }

      const segments = JSON.parse(jsonStr);

      if (!Array.isArray(segments) || segments.length === 0) {
        throw new Error('Invalid segments format');
      }

      const processed = segments.map(s => {
        const str = String(s).trim();
        return this.removeTrailingPeriod ? this.removePeriod(str) : str;
      });

      console.log(`[SmartSegmentation] LLM切分为 ${processed.length} 段`);
      return processed.slice(0, this.maxSegments);

    } catch (e) {
      console.warn('[SmartSegmentation] LLM切分失败，使用简单切分:', e);
      return this.simpleSegment(visibleText);
    }
  }

  segment(text: string): string[] {
    console.log(`[SmartSegmentation] 📥 原始文本: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);
    
    if (!text || !text.trim()) {
      console.log('[SmartSegmentation] ⏭️ 文本为空，跳过分段');
      return [];
    }
    
    let processedText = this.filterDuplicateContent(text);
    processedText = this.convertEnglishPunctuation(processedText);
    
    console.log(`[SmartSegmentation] 🔍 过滤后文本: "${processedText.substring(0, 100)}${processedText.length > 100 ? '...' : ''}"`);
    
    if (!processedText) {
      console.log('[SmartSegmentation] ⏭️ 过滤后内容为空，跳过分段');
      return [];
    }
    
    const visibleText = this.stripThinkingContent(processedText);
    if (!visibleText) {
      console.log('[SmartSegmentation] ⏭️ 可见内容为空，跳过分段');
      return [];
    }

    const segmentChars = ['。', '！', '？', '：', '；', '～', '…', '.', '!', '?', ':', ';', '~', '-', '（', '(', '）', ')'];
    const hasSegmentChar = segmentChars.some(char => visibleText.includes(char));
    
    if (!hasSegmentChar) {
      console.log('[SmartSegmentation] 📝 无分段符号，直接返回');
      return [this.removeTrailingPeriod ? this.removePeriod(visibleText) : visibleText];
    }

    console.log('[SmartSegmentation] 🔪 检测到分段符号，开始执行分段...');
    return this.simpleSegment(visibleText);
  }

  getConfig(): SegmentationConfig {
    return {
      enabled: this.enabled && this.runtimeEnabled,
      style: this.style,
      minLength: this.minLength,
      maxSegments: this.maxSegments,
      removeTrailingPeriod: this.removeTrailingPeriod
    };
  }
}
