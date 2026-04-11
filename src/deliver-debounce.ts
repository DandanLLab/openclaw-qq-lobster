const DEFAULT_WINDOW_MS = 1500;
const DEFAULT_MAX_WAIT_MS = 8000;
const DEFAULT_SEPARATOR = "\n\n---\n\n";

export interface DeliverDebounceOptions {
  enabled?: boolean;
  windowMs?: number;
  maxWaitMs?: number;
  separator?: string;
}

export interface DeliverPayload {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  files?: Array<{ url?: string; name?: string }>;
  [key: string]: unknown;
}

export interface DeliverInfo {
  kind: string;
}

export type DeliverExecutor = (payload: DeliverPayload, info: DeliverInfo) => Promise<void>;

export class DeliverDebouncer {
  private readonly windowMs: number;
  private readonly maxWaitMs: number;
  private readonly separator: string;
  private readonly executor: DeliverExecutor;
  private readonly log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
  };
  private readonly prefix: string;

  private bufferedTexts: string[] = [];
  private lastInfo: DeliverInfo | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private disposed = false;

  constructor(
    config: DeliverDebounceOptions | undefined,
    executor: DeliverExecutor,
    log?: { info: (msg: string) => void; error: (msg: string) => void },
    prefix = "[debounce]",
  ) {
    this.windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxWaitMs = config?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.separator = config?.separator ?? DEFAULT_SEPARATOR;
    this.executor = executor;
    this.log = log;
    this.prefix = prefix;
  }

  async deliver(payload: DeliverPayload, info: DeliverInfo): Promise<void> {
    if (this.disposed) return;

    const hasMedia = Boolean(
      (payload.mediaUrls && payload.mediaUrls.length > 0) ||
        payload.mediaUrl ||
        (payload.files && payload.files.length > 0),
    );
    const text = (payload.text ?? "").trim();

    if (hasMedia) {
      this.log?.info(
        `${this.prefix} Media deliver detected, flushing ${this.bufferedTexts.length} buffered text(s) first`,
      );
      await this.flush();
      await this.executor(payload, info);
      return;
    }

    if (!text) {
      await this.executor(payload, info);
      return;
    }

    this.bufferedTexts.push(text);
    this.lastInfo = info;

    this.log?.info(
      `${this.prefix} Buffered text #${this.bufferedTexts.length} (${text.length} chars), window=${this.windowMs}ms`,
    );

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.flush().catch((err) => {
        this.log?.error(`${this.prefix} Flush error (debounce timer): ${err}`);
      });
    }, this.windowMs);

    if (this.bufferedTexts.length === 1) {
      if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = setTimeout(() => {
        this.log?.info(`${this.prefix} Max wait (${this.maxWaitMs}ms) reached, force flushing`);
        this.flush().catch((err) => {
          this.log?.error(`${this.prefix} Flush error (max wait timer): ${err}`);
        });
      }, this.maxWaitMs);
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.bufferedTexts.length === 0) return;
    this.flushing = true;

    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.maxWaitTimer) { clearTimeout(this.maxWaitTimer); this.maxWaitTimer = null; }

    const texts = this.bufferedTexts;
    const info = this.lastInfo!;
    this.bufferedTexts = [];
    this.lastInfo = null;

    try {
      const merged = texts.length === 1 ? texts[0] : texts.join(this.separator);
      if (texts.length === 1) {
        this.log?.info(`${this.prefix} Flushing single buffered text (${texts[0].length} chars)`);
      } else {
        this.log?.info(
          `${this.prefix} Merged ${texts.length} buffered texts into one (${merged.length} chars)`,
        );
      }
      await this.executor({ text: merged }, info);
    } catch (err) {
      this.bufferedTexts = [...texts, ...this.bufferedTexts];
      this.lastInfo = info;
      this.log?.error(`${this.prefix} Flush executor failed, ${texts.length} message(s) restored to buffer: ${err}`);
      throw err;
    } finally {
      this.flushing = false;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.maxWaitTimer) { clearTimeout(this.maxWaitTimer); this.maxWaitTimer = null; }
    if (this.bufferedTexts.length > 0) {
      this.flushing = false;
      await this.flush();
    }
  }

  get hasPending(): boolean { return this.bufferedTexts.length > 0; }
  get pendingCount(): number { return this.bufferedTexts.length; }
}

export function createDeliverDebouncer(
  config: DeliverDebounceOptions | undefined,
  executor: DeliverExecutor,
  log?: { info: (msg: string) => void; error: (msg: string) => void },
  prefix?: string,
): DeliverDebouncer | null {
  if (config?.enabled === false) return null;
  return new DeliverDebouncer(config, executor, log, prefix);
}
