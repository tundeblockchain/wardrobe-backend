import { createHash } from 'crypto';
import {
  DEFAULT_FEEDBACK_EMAIL_RATE_LIMIT,
  DEFAULT_FEEDBACK_IP_RATE_LIMIT,
  DEFAULT_RATE_WINDOW_SECONDS,
  DEFAULT_UPLOAD_IP_RATE_LIMIT,
  SUPPORT_FEEDBACK_EMAIL_RATE_LIMIT_ENV,
  SUPPORT_FEEDBACK_IP_RATE_LIMIT_ENV,
  SUPPORT_INBOX_RATE_WINDOW_SECONDS_ENV,
  SUPPORT_UPLOAD_IP_RATE_LIMIT_ENV,
} from '../../shared/support-inbox-names';
import { SupportRateLimitError } from './http';
import { keys } from './keys';
import { incrementSupportCounter } from './table';

export const RATE_SCOPE_UPLOAD_IP = 'UPLOAD_IP';
export const RATE_SCOPE_FEEDBACK_IP = 'FEEDBACK_IP';
export const RATE_SCOPE_FEEDBACK_EMAIL = 'FEEDBACK_EMAIL';

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  count: number;
}

export type IncrementSupportCounterFn = typeof incrementSupportCounter;

export function hashRateLimitId(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function readSupportInboxRateLimits(
  env: NodeJS.ProcessEnv = process.env,
): {
  feedbackIp: number;
  feedbackEmail: number;
  uploadIp: number;
  windowSeconds: number;
} {
  return {
    feedbackIp: readPositiveInt(
      env[SUPPORT_FEEDBACK_IP_RATE_LIMIT_ENV],
      DEFAULT_FEEDBACK_IP_RATE_LIMIT,
    ),
    feedbackEmail: readPositiveInt(
      env[SUPPORT_FEEDBACK_EMAIL_RATE_LIMIT_ENV],
      DEFAULT_FEEDBACK_EMAIL_RATE_LIMIT,
    ),
    uploadIp: readPositiveInt(
      env[SUPPORT_UPLOAD_IP_RATE_LIMIT_ENV],
      DEFAULT_UPLOAD_IP_RATE_LIMIT,
    ),
    windowSeconds: readPositiveInt(
      env[SUPPORT_INBOX_RATE_WINDOW_SECONDS_ENV],
      DEFAULT_RATE_WINDOW_SECONDS,
    ),
  };
}

export async function consumeUploadIpRateLimit(
  sourceIp: string,
  increment: IncrementSupportCounterFn = incrementSupportCounter,
  nowMs = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<RateLimitDecision> {
  const { uploadIp, windowSeconds } = readSupportInboxRateLimits(env);
  return consumeWindow({
    scope: RATE_SCOPE_UPLOAD_IP,
    id: sourceIp.trim() || 'unknown',
    limit: uploadIp,
    windowSeconds,
    increment,
    nowMs,
  });
}

export async function consumeFeedbackRateLimit(
  sourceIp: string,
  email: string,
  increment: IncrementSupportCounterFn = incrementSupportCounter,
  nowMs = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<RateLimitDecision> {
  const { feedbackIp, feedbackEmail, windowSeconds } =
    readSupportInboxRateLimits(env);
  const ipDecision = await consumeWindow({
    scope: RATE_SCOPE_FEEDBACK_IP,
    id: sourceIp.trim() || 'unknown',
    limit: feedbackIp,
    windowSeconds,
    increment,
    nowMs,
  });
  const emailDecision = await consumeWindow({
    scope: RATE_SCOPE_FEEDBACK_EMAIL,
    id: email.trim().toLowerCase(),
    limit: feedbackEmail,
    windowSeconds,
    increment,
    nowMs,
  });

  if (ipDecision.allowed && emailDecision.allowed) {
    return ipDecision;
  }

  return {
    allowed: false,
    retryAfterSeconds: Math.max(
      ipDecision.retryAfterSeconds,
      emailDecision.retryAfterSeconds,
    ),
    count: Math.max(ipDecision.count, emailDecision.count),
  };
}

export function assertAllowed(decision: RateLimitDecision): void {
  if (!decision.allowed) {
    throw new SupportRateLimitError(decision.retryAfterSeconds);
  }
}

async function consumeWindow(input: {
  scope: string;
  id: string;
  limit: number;
  windowSeconds: number;
  increment: IncrementSupportCounterFn;
  nowMs: number;
}): Promise<RateLimitDecision> {
  const nowSeconds = Math.floor(input.nowMs / 1000);
  const windowStart =
    Math.floor(nowSeconds / input.windowSeconds) * input.windowSeconds;
  const windowEnd = windowStart + input.windowSeconds;
  const ttl = windowEnd + 60;
  const hashed = hashRateLimitId(input.id);

  const count = await input.increment({
    pk: keys.rateLimitPk(input.scope, hashed),
    sk: keys.rateLimitSk(windowStart),
    ttl,
  });

  return {
    allowed: count <= input.limit,
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
