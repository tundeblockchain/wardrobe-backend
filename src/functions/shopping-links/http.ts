export type FetchHeaders =
  | { get(name: string): string | null }
  | Record<string, string>;

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: FetchHeaders;
  text(): Promise<string>;
}>;

export const UPSTREAM_BODY_SNIPPET_MAX = 500;

export function headerValue(
  headers: FetchHeaders | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(name: string): string | null }).get(name);
    return value?.trim() || undefined;
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    if (key.toLowerCase() === target && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/** Truncated, whitespace-collapsed snippet. Never includes Authorization / apiToken values. */
export function truncateUpstreamBody(
  body: string,
  max = UPSTREAM_BODY_SNIPPET_MAX,
): string {
  const redacted = redactSecretMaterial(body).replace(/\s+/g, ' ').trim();
  if (redacted.length <= max) {
    return redacted;
  }
  return `${redacted.slice(0, max)}…`;
}

export function redactSecretMaterial(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /("?(?:apiToken|api_token|token|apiKey|api_key|Authorization)"?\s*[:=]\s*")[^"]*/gi,
      '$1[redacted]',
    );
}

export function looksLikeHtml(text: string): boolean {
  return /^(<!doctype\s+html\b|<html\b)/i.test(text.trim());
}

export class UpstreamTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly label: string;
  readonly model?: string;

  constructor(
    timeoutMs: number,
    label: string,
    options: { model?: string; cause?: unknown } = {},
  ) {
    const modelPart = options.model ? ` (model=${options.model})` : '';
    super(`${label} timed out after ${timeoutMs}ms${modelPart}`, {
      cause: options.cause,
    });
    this.name = 'UpstreamTimeoutError';
    this.timeoutMs = timeoutMs;
    this.label = label;
    if (options.model) {
      this.model = options.model;
    }
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const name = (error as { name?: string }).name;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return true;
  }
  return error instanceof Error && /operation was aborted/i.test(error.message);
}

export function timeoutErrorFromAbort(
  error: unknown,
  timeoutMs: number,
  label: string,
  extras: { model?: string } = {},
): unknown {
  if (error instanceof UpstreamTimeoutError) {
    if (extras.model && !error.model) {
      return new UpstreamTimeoutError(error.timeoutMs, error.label, {
        model: extras.model,
        cause: error.cause ?? error,
      });
    }
    return error;
  }
  if (isAbortError(error)) {
    return new UpstreamTimeoutError(timeoutMs, label, {
      ...extras,
      cause: error,
    });
  }
  return error;
}

export function upstreamFailureLogFields(
  error: unknown,
): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { errorData: error };
  }
  const fields: Record<string, unknown> = { errorName: error.name };
  if (error instanceof UpstreamTimeoutError) {
    fields.timeoutMs = error.timeoutMs;
    fields.step = error.label;
    if (error.model) {
      fields.model = error.model;
    }
  }
  const cause = error.cause;
  if (cause instanceof Error) {
    fields.cause = cause.message;
    fields.causeName = cause.name;
  } else if (cause !== undefined) {
    fields.cause = String(cause);
  }
  return fields;
}

export function timedFetch(
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
  label = 'Upstream request',
): FetchLike {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    if (init?.signal) {
      if (init.signal.aborted) {
        controller.abort();
      } else {
        init.signal.addEventListener('abort', () => controller.abort(), {
          once: true,
        });
      }
    }

    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      throw timeoutErrorFromAbort(error, timeoutMs, label);
    } finally {
      clearTimeout(timer);
    }
  };
}

export function firstString(
  record: Record<string, unknown>,
  keysToTry: string[],
): string | undefined {
  for (const key of keysToTry) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function looksLikePlaceholderSecret(value: string): boolean {
  const lower = value.trim().toLowerCase();
  if (!lower) {
    return true;
  }
  return (
    lower.includes('placeholder') ||
    lower.includes('replace the generated') ||
    lower.includes('your-') ||
    lower.includes('changeme') ||
    lower.includes('<api') ||
    lower === 'todo'
  );
}

export function parseJsonContent(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(trimmed);
}
