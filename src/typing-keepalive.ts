import type { OneBotClient } from "./client.js";

const TYPING_INTERVAL_MS = 50_000;

export class TypingKeepAlive {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly client: OneBotClient,
    private readonly isGroup: boolean,
    private readonly groupId?: number,
    private readonly userId?: number,
  ) {}

  start(): void {
    if (this.stopped) return;
    if (this.isGroup) return;
    this.send();
    this.timer = setInterval(() => {
      if (this.stopped) { this.stop(); return; }
      this.send();
    }, TYPING_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private send(): void {
    if (!this.userId) return;
    (this.client as any)
      .sendAction?.("set_input_status", {
        user_id: this.userId,
        event_type: 1,
      })
      .catch(() => {});
  }
}
