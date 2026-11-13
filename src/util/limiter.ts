/**
 * Token-bucket rate limiting with a foreground reserve (SPEC §2 "Rate budgets").
 *
 * Foreground work (planner, answerer) may use the whole bucket. Background work
 * (extractor, verifier) may only use what's above the reserved fraction, so post-stream
 * checks can never starve the user's next turn.
 */
export type Priority = "foreground" | "background";

export class TokenBucket {
  private tokens: number;
  private last: number;
  private cooldownUntil = 0;

  constructor(
    readonly capacity: number,
    /** Tokens restored per millisecond. */
    private readonly refillPerMs: number,
    private readonly reserveFraction = 0.7,
  ) {
    this.tokens = capacity;
    this.last = Date.now();
  }

  /** Build a bucket from a per-minute budget. */
  static perMinute(perMinute: number, reserveFraction = 0.7): TokenBucket {
    return new TokenBucket(perMinute, perMinute / 60_000, reserveFraction);
  }

  /** Build a bucket from a per-second budget. */
  static perSecond(perSecond: number, reserveFraction = 0.7): TokenBucket {
    return new TokenBucket(perSecond, perSecond / 1000, reserveFraction);
  }

  private refill(): void {
    const t = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.refillPerMs);
    this.last = t;
  }

  private floor(priority: Priority): number {
    return priority === "foreground" ? 0 : this.capacity * this.reserveFraction;
  }

  /** Milliseconds until `cost` could be taken at this priority (0 = now). Infinity if it never fits. */
  waitTime(cost: number, priority: Priority): number {
    this.refill();
    const c = Math.min(cost, this.capacity); // an oversized request still runs once the bucket is full
    const cool = Math.max(0, this.cooldownUntil - Date.now());
    const need = c + this.floor(priority) - this.tokens;
    if (priority === "background" && c > this.capacity * (1 - this.reserveFraction)) return Infinity;
    return Math.max(cool, need <= 0 ? 0 : need / this.refillPerMs);
  }

  /** Take `cost` now if possible. */
  tryTake(cost: number, priority: Priority): boolean {
    if (this.waitTime(cost, priority) > 0) return false;
    this.tokens -= Math.min(cost, this.capacity);
    return true;
  }

  /** Wait (up to the signal's deadline) and take. Throws if the signal aborts first. */
  async take(cost: number, priority: Priority, signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (this.tryTake(cost, priority)) return;
      const w = this.waitTime(cost, priority);
      if (!Number.isFinite(w)) throw new Error("request larger than the background budget");
      await sleep(Math.min(Math.max(w, 25), 2_000), signal);
    }
  }

  /** Return tokens that were reserved but not used (estimate − actual). */
  refund(n: number): void {
    if (n <= 0) return;
    this.refill();
    this.tokens = Math.min(this.capacity, this.tokens + n);
  }

  /** Provider reported its own remaining budget; never believe we have more than it says. */
  sync(remaining: number): void {
    this.refill();
    this.tokens = Math.min(this.tokens, remaining);
  }

  /** Provider told us to back off (429 Retry-After). */
  coolDown(ms: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + ms);
  }

  /** Remaining tokens, for /stats. */
  remaining(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

/** Fixed-window daily counter (Groq's 1,000 requests/day per model). */
export class DailyQuota {
  private day = "";
  private used = 0;
  constructor(readonly limit: number) {}
  private roll(): void {
    const d = new Date().toISOString().slice(0, 10); // provider days are UTC
    if (d !== this.day) {
      this.day = d;
      this.used = 0;
    }
  }
  available(): boolean {
    this.roll();
    return this.used < this.limit;
  }
  consume(): void {
    this.roll();
    this.used++;
  }
  /** Provider reported its own remaining count; trust it. */
  sync(remaining: number): void {
    this.roll();
    this.used = Math.max(this.used, this.limit - remaining);
  }
  remaining(): number {
    this.roll();
    return this.limit - this.used;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Rough token estimate (≈4 chars per token) used for TPM budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Simple circuit breaker: opens after `threshold` consecutive failures for `openMs`. */
export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  constructor(private readonly threshold = 3, private readonly openMs = 30_000) {}
  isOpen(): boolean {
    return Date.now() < this.openUntil;
  }
  success(): void {
    this.failures = 0;
  }
  failure(): void {
    if (++this.failures >= this.threshold) {
      this.openUntil = Date.now() + this.openMs;
      this.failures = 0;
    }
  }
}
