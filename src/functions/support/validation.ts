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

export const WEBSITE_NAME_MAX = 100;
export const WEBSITE_MESSAGE_MAX = 5_000;
export const WEBSITE_SUBJECT_MAX = 200;
export const WEBSITE_EMAIL_MAX = 254;

export interface WebsiteContactMessage {
  name: string;
  email: string;
  message: string;
  subject: string;
}

export function isHoneypotTripped(company: unknown): boolean {
  if (company === undefined || company === null) {
    return false;
  }
  if (typeof company === 'string') {
    return company.trim().length > 0;
  }
  return true;
}

export function parseWebsiteContact(body: unknown): WebsiteContactMessage {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw Errors.validation('Request body must be an object.');
  }

  const raw = body as {
    name?: unknown;
    email?: unknown;
    message?: unknown;
    subject?: unknown;
  };

  const name = stripHeaderBreaks(
    requireNonEmptyString(raw.name, 'name', WEBSITE_NAME_MAX),
  );
  if (name.length === 0) {
    throw Errors.validation('name is required.');
  }
  if (name.length > WEBSITE_NAME_MAX) {
    throw Errors.validation(`name must be ${WEBSITE_NAME_MAX} characters or fewer.`);
  }

  const email = requireNonEmptyString(raw.email, 'email', WEBSITE_EMAIL_MAX);
  if (!isEmailAddress(email)) {
    throw Errors.validation('email must be a valid email address.');
  }

  const message = requireNonEmptyString(raw.message, 'message', WEBSITE_MESSAGE_MAX);

  const subjectRaw = optionalNonEmptyString(
    raw.subject,
    'subject',
    WEBSITE_SUBJECT_MAX,
  );
  const subject = stripHeaderBreaks(
    subjectRaw ?? `Website contact from ${name}`,
  );
  if (subject.length === 0) {
    throw Errors.validation('subject is required.');
  }
  if (subject.length > WEBSITE_SUBJECT_MAX) {
    throw Errors.validation(
      `subject must be ${WEBSITE_SUBJECT_MAX} characters or fewer.`,
    );
  }

  return { name, email, message, subject };
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
