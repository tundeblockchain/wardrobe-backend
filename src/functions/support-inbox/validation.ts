import {
  SUPPORT_FEEDBACK_TYPES,
  SUPPORT_KEY_PREFIX,
  SUPPORT_PLATFORMS,
  SUPPORT_UPLOAD_CONTENT_TYPES,
  type SupportFeedbackType,
  type SupportPlatform,
  type SupportUploadContentType,
} from '../../shared/support-inbox-names';
import { SupportValidationError } from './http';

export const MESSAGE_MAX_CHARS = 5_000;
export const EMAIL_MAX_CHARS = 254;
export const DEVICE_MAX_CHARS = 200;
export const APP_VERSION_MAX_CHARS = 64;
export const SCREENSHOT_KEY_MAX_CHARS = 512;

const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface FeedbackInput {
  type: SupportFeedbackType;
  message: string;
  email: string;
  screenshotKey?: string;
  appVersion?: string;
  platform: SupportPlatform;
  device?: string;
}

export type ParsedFeedback =
  | { honeypot: true }
  | { honeypot: false; value: FeedbackInput };

export function parseUploadUrlBody(body: unknown): {
  contentType: SupportUploadContentType;
} {
  const fields: Record<string, string> = {};
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new SupportValidationError({ body: 'must be an object' });
  }

  const raw = body as { contentType?: unknown };
  const contentType = parseContentType(raw.contentType, fields);
  if (Object.keys(fields).length > 0 || !contentType) {
    throw new SupportValidationError(fields);
  }
  return { contentType };
}

export function parseFeedbackBody(body: unknown): ParsedFeedback {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new SupportValidationError({ body: 'must be an object' });
  }

  const raw = body as Record<string, unknown>;
  if (isHoneypotTripped(raw.website)) {
    return { honeypot: true };
  }

  const fields: Record<string, string> = {};
  const type = parseType(raw.type, fields);
  const message = parseMessage(raw.message, fields);
  const email = parseEmail(raw.email, fields);
  const platform = parsePlatform(raw.platform, fields);
  const screenshotKey = parseOptionalScreenshotKey(raw.screenshotKey, fields);
  const appVersion = parseOptionalBoundedString(
    raw.appVersion,
    'appVersion',
    APP_VERSION_MAX_CHARS,
    fields,
  );
  const device = parseOptionalBoundedString(
    raw.device,
    'device',
    DEVICE_MAX_CHARS,
    fields,
  );

  if (Object.keys(fields).length > 0) {
    throw new SupportValidationError(fields);
  }

  return {
    honeypot: false,
    value: {
      type: type as SupportFeedbackType,
      message: message as string,
      email: email as string,
      platform: platform as SupportPlatform,
      ...(screenshotKey ? { screenshotKey } : {}),
      ...(appVersion ? { appVersion } : {}),
      ...(device ? { device } : {}),
    },
  };
}

export function parseReplyBody(body: unknown): { message: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new SupportValidationError({ body: 'must be an object' });
  }

  const fields: Record<string, string> = {};
  const message = parseMessage(
    (body as { message?: unknown }).message,
    fields,
  );
  if (Object.keys(fields).length > 0 || !message) {
    throw new SupportValidationError(
      Object.keys(fields).length > 0
        ? fields
        : { message: 'must be 1-5000 characters' },
    );
  }
  return { message };
}

export function isHoneypotTripped(website: unknown): boolean {
  if (website === undefined || website === null) {
    return false;
  }
  if (typeof website === 'string') {
    return website.trim().length > 0;
  }
  return true;
}

export function isSafeSupportObjectKey(key: string): boolean {
  if (!key.startsWith(SUPPORT_KEY_PREFIX)) {
    return false;
  }
  if (key.length <= SUPPORT_KEY_PREFIX.length) {
    return false;
  }
  if (key.length > SCREENSHOT_KEY_MAX_CHARS) {
    return false;
  }
  if (
    key.includes('..') ||
    key.includes('\\') ||
    key.includes('\0') ||
    key.includes('//')
  ) {
    return false;
  }
  return true;
}

function parseContentType(
  value: unknown,
  fields: Record<string, string>,
): SupportUploadContentType | undefined {
  if (typeof value !== 'string') {
    fields.contentType = 'must be image/png or image/jpeg';
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    !SUPPORT_UPLOAD_CONTENT_TYPES.includes(
      normalized as SupportUploadContentType,
    )
  ) {
    fields.contentType = 'must be image/png or image/jpeg';
    return undefined;
  }
  return normalized as SupportUploadContentType;
}

function parseType(
  value: unknown,
  fields: Record<string, string>,
): SupportFeedbackType | undefined {
  if (typeof value !== 'string') {
    fields.type = 'must be bug or query';
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!SUPPORT_FEEDBACK_TYPES.includes(normalized as SupportFeedbackType)) {
    fields.type = 'must be bug or query';
    return undefined;
  }
  return normalized as SupportFeedbackType;
}

function parseMessage(
  value: unknown,
  fields: Record<string, string>,
): string | undefined {
  if (typeof value !== 'string') {
    fields.message = 'must be a string of 1-5000 characters';
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length < 1) {
    fields.message = 'must be 1-5000 characters';
    return undefined;
  }
  if (trimmed.length > MESSAGE_MAX_CHARS) {
    fields.message = 'must be 1-5000 characters';
    return undefined;
  }
  return trimmed;
}

function parseEmail(
  value: unknown,
  fields: Record<string, string>,
): string | undefined {
  if (typeof value !== 'string') {
    fields.email = 'must be a valid email';
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > EMAIL_MAX_CHARS) {
    fields.email = 'must be a valid email';
    return undefined;
  }
  if (!EMAIL_ADDRESS.test(trimmed) || /[\r\n]/.test(trimmed)) {
    fields.email = 'must be a valid email';
    return undefined;
  }
  return trimmed;
}

function parsePlatform(
  value: unknown,
  fields: Record<string, string>,
): SupportPlatform | undefined {
  if (typeof value !== 'string') {
    fields.platform = 'must be ios, android, or web';
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!SUPPORT_PLATFORMS.includes(normalized as SupportPlatform)) {
    fields.platform = 'must be ios, android, or web';
    return undefined;
  }
  return normalized as SupportPlatform;
}

function parseOptionalScreenshotKey(
  value: unknown,
  fields: Record<string, string>,
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    fields.screenshotKey = 'must be a support/ object key';
    return undefined;
  }
  const trimmed = value.trim();
  if (!isSafeSupportObjectKey(trimmed)) {
    fields.screenshotKey = 'must be a support/ object key';
    return undefined;
  }
  return trimmed;
}

function parseOptionalBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
  fields: Record<string, string>,
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    fields[field] = `must be a string of at most ${maxLength} characters`;
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > maxLength) {
    fields[field] = `must be at most ${maxLength} characters`;
    return undefined;
  }
  return trimmed;
}
