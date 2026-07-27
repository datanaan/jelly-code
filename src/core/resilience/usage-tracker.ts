/**
 * Token usage tracker. In-memory aggregation.
 * For production: persist to Redis daily (see plan §3.4 future work).
 */
export interface TokenUsage {
  endpoint: string;
  promptTokens: number;
  completionTokens: number;
  timestamp: number;
}

export interface UsageSummary {
  totalTokens: number;
  callCount: number;
  lastUsed: number;
}

export function estimateTokens(text: string): number {
  // Rough approximation: ~4 chars per token for English/code
  return Math.ceil(text.length / 4);
}

export class UsageTracker {
  private records = new Map<string, UsageSummary>();

  record(usage: TokenUsage): void {
    const total = usage.promptTokens + usage.completionTokens;
    const existing = this.records.get(usage.endpoint);
    if (existing) {
      existing.totalTokens += total;
      existing.callCount += 1;
      existing.lastUsed = usage.timestamp;
    } else {
      this.records.set(usage.endpoint, {
        totalTokens: total,
        callCount: 1,
        lastUsed: usage.timestamp,
      });
    }
  }

  summary(): Map<string, UsageSummary> {
    return new Map(this.records);
  }

  reset(): void {
    this.records.clear();
  }
}
