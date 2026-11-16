import type { ReceivedEmail } from '../../shared/resend';

export {
  createResendClient,
  DEFAULT_RESEND_TIMEOUT_MS,
  fetchReceivedEmail,
  PermanentResendError,
  RESEND_API_BASE,
  RESEND_SEND_PATH,
  RESEND_USER_AGENT,
  sendEmail,
  type FetchLike,
  type ReceivedEmail,
  type SendEmailInput,
  type SendEmailResult,
} from '../../shared/resend';

export type SupportKind = 'contact' | 'bug';
export type SupportSource = 'app' | 'website';

export function formatOutboundMail(input: {
  kind: SupportKind;
  source?: SupportSource;
  userId?: string;
  name?: string;
  subject: string;
  body: string;
  replyTo?: string;
  meta?: Record<string, string>;
}): { subject: string; text: string; html: string } {
  const website = input.source === 'website';
  const label = input.kind === 'bug' ? 'Bug report' : 'Contact us';
  const subject = website
    ? `[Website] ${input.subject}`
    : `[Wardrobe ${label}] ${input.subject}`;
  const lines = [
    `Kind: ${input.kind}`,
    website ? 'Source: website' : undefined,
    !website && input.userId ? `User ID: ${input.userId}` : undefined,
    website && input.name ? `Name: ${input.name}` : undefined,
    input.replyTo ? `Reply-To: ${input.replyTo}` : undefined,
    '',
    input.body,
  ];

  const metaEntries = Object.entries(input.meta ?? {});
  if (metaEntries.length > 0) {
    lines.push('', '---', 'App / device');
    for (const [key, value] of metaEntries) {
      lines.push(`${key}: ${value}`);
    }
  }

  const text = lines.filter((line) => line !== undefined).join('\n');
  const html = `<pre style="font-family:ui-monospace,monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`;
  return { subject, text, html };
}

export function formatInboundForward(input: {
  webhookFrom?: string;
  webhookTo?: string[];
  webhookSubject?: string;
  email?: ReceivedEmail;
}): { subject: string; text: string; html?: string } {
  const from = input.email?.from ?? input.webhookFrom ?? '(unknown sender)';
  const to = (input.email?.to ?? input.webhookTo ?? []).join(', ') || '(unknown)';
  const originalSubject =
    input.email?.subject ?? input.webhookSubject ?? '(no subject)';
  const subject = originalSubject.toLowerCase().startsWith('fwd:')
    ? originalSubject
    : `Fwd: ${originalSubject}`;

  const attachmentNames = (input.email?.attachments ?? [])
    .map((attachment) => attachment.filename)
    .filter((name): name is string => Boolean(name && name.trim()));

  const header = [
    'Forwarded inbound mail (Resend webhook)',
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${originalSubject}`,
    attachmentNames.length
      ? `Attachments: ${attachmentNames.join(', ')}`
      : undefined,
    '',
  ]
    .filter((line) => line !== undefined)
    .join('\n');

  const bodyText = input.email?.text?.trim();
  const bodyHtml = input.email?.html?.trim();
  const text = bodyText
    ? `${header}${bodyText}`
    : bodyHtml
      ? `${header}(HTML body; see HTML part)`
      : `${header}(Body unavailable — Resend receiving fetch failed or was empty. This is a metadata notification.)`;

  if (bodyHtml) {
    const html = `<pre style="font-family:ui-monospace,monospace;white-space:pre-wrap">${escapeHtml(header)}</pre>${bodyHtml}`;
    return { subject, text, html };
  }

  return { subject, text };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
