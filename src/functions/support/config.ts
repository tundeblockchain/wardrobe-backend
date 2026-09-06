import { getSecretString, parseJsonObjectOrString } from '../../shared/secrets';

/**
 * Runtime support-mail config (WARDROBE-38).
 *
 * Conceptual keys (never commit real values):
 *   RESEND_API_KEY
 *   RESEND_WEBHOOK_SECRET
 *   SUPPORT_FROM_EMAIL
 *   SUPPORT_FORWARD_TO
 *
 * Production Lambdas receive only secret ARNs. Tests may set the four keys
 * as env vars. Env overrides win over Secrets Manager.
 */
export interface SupportMailConfig {
  apiKey: string;
  webhookSecret: string;
  fromEmail: string;
  forwardTo: string;
}

export async function loadSupportMailConfig(): Promise<SupportMailConfig> {
  const fromResendSecret = await readOptionalSecretObject(
    process.env.RESEND_SECRET_ARN,
  );
  const fromMailSecret = await readOptionalSecretObject(
    process.env.SUPPORT_MAIL_SECRET_ARN,
  );
  const merged = { ...fromResendSecret, ...fromMailSecret };

  const apiKey =
    envString('RESEND_API_KEY') ??
    firstString(merged, ['apiKey', 'api_key', 'key', 'RESEND_API_KEY']);
  const webhookSecret =
    envString('RESEND_WEBHOOK_SECRET') ??
    firstString(merged, [
      'webhookSecret',
      'webhook_secret',
      'signingSecret',
      'RESEND_WEBHOOK_SECRET',
    ]);
  const fromEmail =
    envString('SUPPORT_FROM_EMAIL') ??
    firstString(merged, ['fromEmail', 'from', 'SUPPORT_FROM_EMAIL']);
  const forwardTo =
    envString('SUPPORT_FORWARD_TO') ??
    firstString(merged, ['forwardTo', 'to', 'SUPPORT_FORWARD_TO']);

  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }
  if (!webhookSecret) {
    throw new Error('RESEND_WEBHOOK_SECRET is not configured');
  }
  if (!fromEmail) {
    throw new Error('SUPPORT_FROM_EMAIL is not configured');
  }
  if (!forwardTo) {
    throw new Error('SUPPORT_FORWARD_TO is not configured');
  }

  return { apiKey, webhookSecret, fromEmail, forwardTo };
}

export function parseSupportMailSecret(
  secretString: string,
): Partial<SupportMailConfig> {
  const parsed = parseJsonObjectOrString(secretString);
  if (typeof parsed === 'string') {
    return { apiKey: parsed };
  }

  return {
    apiKey: firstString(parsed, ['apiKey', 'api_key', 'key', 'RESEND_API_KEY']),
    webhookSecret: firstString(parsed, [
      'webhookSecret',
      'webhook_secret',
      'signingSecret',
      'RESEND_WEBHOOK_SECRET',
    ]),
    fromEmail: firstString(parsed, [
      'fromEmail',
      'from',
      'SUPPORT_FROM_EMAIL',
    ]),
    forwardTo: firstString(parsed, [
      'forwardTo',
      'to',
      'SUPPORT_FORWARD_TO',
    ]),
  };
}

async function readOptionalSecretObject(
  secretId: string | undefined,
): Promise<Record<string, unknown>> {
  if (!secretId?.trim()) {
    return {};
  }
  const parsed = parseSupportMailSecret(await getSecretString(secretId));
  return Object.fromEntries(
    Object.entries(parsed).filter(([, value]) => value !== undefined),
  );
}

function envString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function firstString(
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
