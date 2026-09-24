import { createHash } from 'crypto';
import { incrementCounter, keys } from '../../shared/dynamodb';

export const DEFAULT_CONTACT_RATE_LIMIT = 5;
export const DEFAULT_CONTACT_RATE_WINDOW_SECONDS = 3600;
export const RATE_LIMIT_SCOPE = 'SUPPORT_CONTACT';

export interface RateLimitConfig {
  limit: number;
  windowSeconds: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  count: number;
}

export type IncrementCounterFn = typeof incrementCounter;

export function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex');
}

export function readContactRateLimitConfig(
  env: NodeJS.ProcessEnv = process.env,
): RateLimitConfig {
  return {
    limit: readPositiveInt(env.SUPPORT_CONTACT_RATE_LIMIT, DEFAULT_CONTACT_RATE_LIMIT),
    windowSeconds: readPositiveInt(
      env.SUPPORT_CONTACT_RATE_WINDOW_SECONDS,
      DEFAULT_CONTACT_RATE_WINDOW_SECONDS,
    ),
  };
}

export async function consumeContactRateLimit(
  sourceIp: string,
  increment: IncrementCounterFn = incrementCounter,
  nowMs = Date.now(),
): Promise<RateLimitDecision> {
  const { limit, windowSeconds } = readContactRateLimitConfig();
  const nowSeconds = Math.floor(nowMs / 1000);
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  const windowEnd = windowStart + windowSeconds;
  const ttl = windowEnd + 60;
  const hashed = hashIp(sourceIp.trim() || 'unknown');

  const count = await increment({
    pk: keys.rateLimitPk(RATE_LIMIT_SCOPE, hashed),
    sk: keys.rateLimitSk(windowStart),
    ttl,
    entityType: 'RATE_LIMIT',
  });

  return {
    allowed: count <= limit,
    retryAfterSeconds: Math.max(1, windowEnd - nowSeconds),
    count,
  };
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
