import { Errors } from '../../shared/errors';
import { optionalNonEmptyString, requireNonEmptyString } from '../../shared/validation';

const SUBJECT_MAX = 200;
const BODY_MAX = 10_000;
const META_MAX_KEYS = 20;
const META_VALUE_MAX = 200;
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SupportMessage {
  subject: string;
  body: string;
  replyTo?: string;
  meta?: Record<string, string>;
}

export function parseSupportMessage(body: unknown): SupportMessage {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw Errors.validation('Request body must be an object.');
  }

  const raw = body as {
    subject?: unknown;
    body?: unknown;
    replyTo?: unknown;
    meta?: unknown;
  };

  const subject = stripHeaderBreaks(
    requireNonEmptyString(raw.subject, 'subject', SUBJECT_MAX),
  );
  const message = requireNonEmptyString(raw.body, 'body', BODY_MAX);
  const replyTo = optionalNonEmptyString(raw.replyTo, 'replyTo', 254);
  if (replyTo && !isEmailAddress(replyTo)) {
    throw Errors.validation('replyTo must be a valid email address.');
  }

  const meta = parseOptionalMeta(raw.meta);
  return {
    subject,
    body: message,
    ...(replyTo ? { replyTo } : {}),
    ...(meta ? { meta } : {}),
  };
}

export function isEmailAddress(value: string): boolean {
  const angled = value.match(/^[^<>]*<([^<>]+)>$/);
  const address = (angled ? angled[1] : value).trim();
  return EMAIL_ADDRESS.test(address);
}

function parseOptionalMeta(
  value: unknown,
): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw Errors.validation('meta must be an object of string values.');
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > META_MAX_KEYS) {
    throw Errors.validation(`meta must have ${META_MAX_KEYS} keys or fewer.`);
  }

  const meta: Record<string, string> = {};
  for (const [key, entry] of entries) {
    const name = requireNonEmptyString(key, 'meta key', 40);
    meta[name] = requireNonEmptyString(entry, `meta.${name}`, META_VALUE_MAX);
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

function stripHeaderBreaks(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}
