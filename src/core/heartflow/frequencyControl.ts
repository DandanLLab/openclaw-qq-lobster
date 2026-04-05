export class FrequencyControlManager {
  private lastReplyTime: number = 0;
  private replyCount: number = 0;
  private noReplyCount: number = 0;
  private readonly minInterval: number = 1000;
  private readonly maxRepliesPerMinute: number = 10;
  private replyTimestamps: number[] = [];

  canReply(): boolean {
    const now = Date.now();
    this.replyTimestamps = this.replyTimestamps.filter(t => now - t < 60000);
    
    if (this.replyTimestamps.length >= this.maxRepliesPerMinute) {
      return false;
    }

    if (now - this.lastReplyTime < this.minInterval) {
      return false;
    }

    return true;
  }

  recordReply(): void {
    const now = Date.now();
    this.lastReplyTime = now;
    this.replyCount++;
    this.noReplyCount = 0;
    this.replyTimestamps.push(now);
  }

  recordNoReply(): void {
    this.noReplyCount++;
  }

  getTalkFrequencyAdjust(): number {
    if (this.noReplyCount >= 5) {
      return 0.1;
    } else if (this.noReplyCount >= 3) {
      return 0.5;
    }
    return 1.0;
  }

  getStats(): { replyCount: number; noReplyCount: number; lastReplyTime: number } {
    return {
      replyCount: this.replyCount,
      noReplyCount: this.noReplyCount,
      lastReplyTime: this.lastReplyTime,
    };
  }

  reset(): void {
    this.lastReplyTime = 0;
    this.replyCount = 0;
    this.noReplyCount = 0;
    this.replyTimestamps = [];
  }
}
