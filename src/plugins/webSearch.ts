import type { PluginContext, PluginResult } from './index.js';

interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

export class WebSearch {
  private bingApiKey: string = '';
  private bingEndpoint: string = 'https://api.bing.microsoft.com/v7.0/search';
  private duckDuckGoEnabled: boolean = true;
  private maxResults: number = 5;
  private enabled: boolean = true;

  async initialize(config: any): Promise<void> {
    this.bingApiKey = config.bingApiKey || '';
    this.bingEndpoint = config.bingEndpoint || 'https://api.bing.microsoft.com/v7.0/search';
    this.duckDuckGoEnabled = config.duckDuckGoEnabled ?? true;
    this.maxResults = config.searchMaxResults ?? 5;
    this.enabled = config.enableWebSearch ?? true;
    console.log('[WebSearch] 初始化完成, Bing API:', this.bingApiKey ? '已配置' : '未配置');
  }

  async handle(ctx: PluginContext): Promise<PluginResult> {
    if (!this.enabled) {
      return { handled: false };
    }

    const { text } = ctx;
    
    let query = '';
    const patterns = [
      /^\/search\s+(.+)$/i,
      /^\/搜索\s+(.+)$/i,
      /^搜索\s+(.+)$/,
      /^搜一下\s+(.+)$/,
      /^查一下\s+(.+)$/,
      /^bing\s+(.+)$/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        query = match[1].trim();
        break;
      }
    }

    if (!query) {
      return { handled: false };
    }

    try {
      const results = await this.search(query);
      if (results.length === 0) {
        return { handled: true, response: `没找到关于「${query}」的结果呢～` };
      }

      const response = this.formatResults(query, results);
      return { handled: true, response };
    } catch (e) {
      console.error('[WebSearch] 搜索失败:', e);
      return { handled: false, error: String(e), response: '搜索出错了，稍后再试吧～' };
    }
  }

  async search(query: string): Promise<SearchResult[]> {
    if (this.bingApiKey) {
      return this.bingSearch(query);
    }
    
    if (this.duckDuckGoEnabled) {
      return this.duckDuckGoSearch(query);
    }

    return [];
  }

  private async bingSearch(query: string): Promise<SearchResult[]> {
    try {
      const url = `${this.bingEndpoint}?q=${encodeURIComponent(query)}&count=${this.maxResults}&mkt=zh-CN`;
      
      const response = await fetch(url, {
        headers: {
          'Ocp-Apim-Subscription-Key': this.bingApiKey
        }
      });

      if (!response.ok) {
        throw new Error(`Bing API error: ${response.status}`);
      }

      const data = await response.json() as any;
      const results: SearchResult[] = [];

      if (data.webPages?.value) {
        for (const item of data.webPages.value.slice(0, this.maxResults)) {
          results.push({
            title: item.name,
            snippet: item.snippet,
            url: item.url
          });
        }
      }

      return results;
    } catch (e) {
      console.error('[WebSearch] Bing搜索失败:', e);
      return [];
    }
  }

  private async duckDuckGoSearch(query: string): Promise<SearchResult[]> {
    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
      
      const response = await fetch(url);
      const data = await response.json() as any;
      const results: SearchResult[] = [];

      if (data.RelatedTopics) {
        for (const topic of data.RelatedTopics.slice(0, this.maxResults)) {
          if (topic.Text && topic.FirstURL) {
            results.push({
              title: topic.Text.split(' - ')[0] || '相关结果',
              snippet: topic.Text,
              url: topic.FirstURL
            });
          }
        }
      }

      if (data.AbstractText) {
        results.unshift({
          title: data.Heading || '摘要',
          snippet: data.AbstractText,
          url: data.AbstractURL || ''
        });
      }

      return results.slice(0, this.maxResults);
    } catch (e) {
      console.error('[WebSearch] DuckDuckGo搜索失败:', e);
      return [];
    }
  }

  private formatResults(query: string, results: SearchResult[]): string {
    let response = `🔍 搜索「${query}」的结果：\n\n`;
    
    results.forEach((result, index) => {
      response += `${index + 1}. ${result.title}\n`;
      if (result.snippet) {
        response += `   ${result.snippet.substring(0, 100)}${result.snippet.length > 100 ? '...' : ''}\n`;
      }
      if (result.url) {
        const shortUrl = result.url.length > 50 ? result.url.substring(0, 47) + '...' : result.url;
        response += `   🔗 ${shortUrl}\n`;
      }
      response += '\n';
    });

    return response.trim();
  }

  async searchAndSummarize(query: string, llmCall?: (prompt: string) => Promise<string>): Promise<string> {
    const results = await this.search(query);
    
    if (results.length === 0) {
      return `没找到关于「${query}」的相关信息。`;
    }

    if (llmCall) {
      const context = results.map(r => `标题: ${r.title}\n摘要: ${r.snippet}\n链接: ${r.url}`).join('\n\n');
      const prompt = `基于以下搜索结果，用简洁的中文回答用户的问题「${query}」：\n\n${context}\n\n请给出一个综合性的回答：`;
      
      try {
        return await llmCall(prompt);
      } catch (e) {
        console.error('[WebSearch] LLM总结失败:', e);
      }
    }

    return this.formatResults(query, results);
  }
}
