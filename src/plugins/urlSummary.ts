import type { PluginContext, PluginResult } from './index.js';

interface UrlSummaryCache {
  url: string;
  title: string;
  summary: string;
  timestamp: number;
}

export class UrlSummary {
  private enabled: boolean = true;
  private timeout: number = 10000;
  private maxLength: number = 400;
  private cacheEnabled: boolean = true;
  private cacheTTL: number = 3600000;
  private cache: Map<string, UrlSummaryCache> = new Map();
  private maxCacheSize: number = 500;

  private blockedHosts: Set<string> = new Set([
    'localhost', '127.0.0.1', '0.0.0.0', '::1',
    '169.254.169.254'
  ]);

  private blockedPorts: Set<number> = new Set([22, 23, 135, 139, 445, 3389]);

  async initialize(config: any): Promise<void> {
    this.enabled = config.enableUrlSummary ?? true;
    this.timeout = config.urlSummaryTimeout ?? 10000;
    this.maxLength = config.urlSummaryMaxLength ?? 400;
    this.cacheEnabled = config.urlSummaryCacheEnabled ?? true;
    this.cacheTTL = (config.urlSummaryCacheTTL ?? 3600) * 1000;
    console.log('[UrlSummary] 初始化完成');
  }

  async handle(ctx: PluginContext): Promise<PluginResult> {
    if (!this.enabled) {
      return { handled: false };
    }

    const { text } = ctx;
    const urls = this.extractUrls(text);

    if (urls.length === 0) {
      return { handled: false };
    }

    const summaries: string[] = [];
    for (const url of urls.slice(0, 3)) {
      const summary = await this.getUrlSummary(url);
      if (summary) {
        summaries.push(summary);
      }
    }

    if (summaries.length === 0) {
      return { handled: false };
    }

    return { handled: true, response: summaries.join('\n\n---\n\n') };
  }

  private extractUrls(text: string): string[] {
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
    const matches = text.match(urlRegex) || [];
    
    return [...new Set(matches)].filter(url => this.isValidUrl(url));
  }

  private isValidUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return false;
      }

      const hostname = parsed.hostname.toLowerCase();
      if (this.blockedHosts.has(hostname)) {
        return false;
      }

      const port = parsed.port ? parseInt(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
      if (this.blockedPorts.has(port)) {
        return false;
      }

      if (this.isPrivateIP(hostname)) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  private isPrivateIP(hostname: string): boolean {
    const privatePatterns = [
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
      /^192\.168\./,
      /^127\./,
      /^169\.254\./,
      /^::1$/,
      /^fc00:/i,
      /^fe80:/i
    ];

    return privatePatterns.some(pattern => pattern.test(hostname));
  }

  private async getUrlSummary(url: string): Promise<string | null> {
    if (this.cacheEnabled) {
      const cached = this.cache.get(url);
      if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
        return this.formatSummary(cached.title, cached.summary, url);
      }
    }

    try {
      const { title, summary } = await this.fetchAndSummarize(url);
      
      if (this.cacheEnabled) {
        this.cache.set(url, { url, title, summary, timestamp: Date.now() });
        if (this.cache.size > this.maxCacheSize) {
          const oldestKey = this.cache.keys().next().value;
          if (oldestKey) this.cache.delete(oldestKey);
        }
      }

      return this.formatSummary(title, summary, url);
    } catch (e) {
      console.error('[UrlSummary] 获取摘要失败:', url, e);
      return null;
    }
  }

  private async fetchAndSummarize(url: string): Promise<{ title: string; summary: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; OpenClaw-URL-Summary/1.0)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        },
        redirect: 'follow'
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) {
        return { title: url, summary: '非网页内容' };
      }

      const html = await response.text();
      return this.parseHtml(html, url);
    } catch (e) {
      clearTimeout(timeoutId);
      throw e;
    }
  }

  private parseHtml(html: string, url: string): { title: string; summary: string } {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? this.decodeHtml(titleMatch[1].trim()) : url;

    const metaDesc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                     html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
    
    if (metaDesc) {
      const desc = this.decodeHtml(metaDesc[1].trim());
      return { title, summary: desc.substring(0, this.maxLength) };
    }

    const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
    if (ogDesc) {
      const desc = this.decodeHtml(ogDesc[1].trim());
      return { title, summary: desc.substring(0, this.maxLength) };
    }

    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) {
      let content = bodyMatch[1];
      content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
      content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
      content = content.replace(/<[^>]+>/g, ' ');
      content = content.replace(/\s+/g, ' ').trim();
      content = this.decodeHtml(content);
      
      return { title, summary: content.substring(0, this.maxLength) };
    }

    return { title, summary: '无法提取内容' };
  }

  private decodeHtml(text: string): string {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
  }

  private formatSummary(title: string, summary: string, url: string): string {
    const shortUrl = url.length > 50 ? url.substring(0, 47) + '...' : url;
    let result = `🔗 **${title}**\n`;
    result += `> ${summary.replace(/\n/g, '\n> ')}\n`;
    result += `📎 ${shortUrl}`;
    return result;
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize
    };
  }
}
