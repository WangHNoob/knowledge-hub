/**
 * In-process sliding-window rate limiter for MCP HTTP (/mcp).
 * Suitable for single-instance pilots; put Nginx/API Gateway in front for multi-node.
 */

export interface McpRateLimitOptions {
  /** Max requests per window per key. 0 disables. */
  maxRequests: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

interface Bucket {
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();

export function checkMcpRateLimit(
  key: string,
  options: McpRateLimitOptions,
  now = Date.now(),
): { allowed: boolean; retryAfterMs: number; remaining: number } {
  if (options.maxRequests <= 0) {
    return { allowed: true, retryAfterMs: 0, remaining: Number.POSITIVE_INFINITY };
  }
  const windowMs = Math.max(1, options.windowMs);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { timestamps: [] };
    buckets.set(key, bucket);
  }
  bucket.timestamps = bucket.timestamps.filter((ts) => now - ts < windowMs);
  if (bucket.timestamps.length >= options.maxRequests) {
    const oldest = bucket.timestamps[0] ?? now;
    return {
      allowed: false,
      retryAfterMs: Math.max(1, windowMs - (now - oldest)),
      remaining: 0,
    };
  }
  bucket.timestamps.push(now);
  return {
    allowed: true,
    retryAfterMs: 0,
    remaining: Math.max(0, options.maxRequests - bucket.timestamps.length),
  };
}

/** Test helper: clear in-memory buckets. */
export function resetMcpRateLimitBuckets(): void {
  buckets.clear();
}
