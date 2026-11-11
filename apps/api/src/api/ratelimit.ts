import { ApiError } from './errors.js';

/** In-memory per-key token bucket. Single process only (the API runs as one container). */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private nowMs: () => number = Date.now) {}

  /** Consume one token from `bucket` for `key`; returns 0 if allowed, else seconds until a token is free. */
  take(key: string, bucket: string, perMinute: number): number {
    const t = this.nowMs();
    const id = `${bucket}:${key}`;
    const b = this.buckets.get(id) ?? { tokens: perMinute, at: t };
    b.tokens = Math.min(perMinute, b.tokens + ((t - b.at) / 60_000) * perMinute);
    b.at = t;
    this.buckets.set(id, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      if (this.buckets.size > 10_000) this.sweep(t);
      return 0;
    }
    return Math.max(1, Math.ceil(((1 - b.tokens) / perMinute) * 60));
  }

  private sweep(t: number): void {
    for (const [k, b] of this.buckets) if (t - b.at > 120_000) this.buckets.delete(k);
  }
}

export const RATE = { destinationTest: 10, jobCreate: 30, destinationCreate: 20, trackerRefresh: 6 } as const;

/** Throws 429 + Retry-After when `userId` exceeded `perMinute` calls of `bucket`. */
export function enforce(limiter: RateLimiter, userId: number, bucket: string, perMinute: number): void {
  const wait = limiter.take(String(userId), bucket, perMinute);
  if (wait > 0) throw new ApiError(429, 'limit_exceeded', 'Too many requests, slow down', { 'Retry-After': String(wait) });
}
