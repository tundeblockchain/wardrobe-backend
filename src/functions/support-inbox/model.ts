import { nanoid } from 'nanoid';
import { nowIso } from '../../shared/ids';
import {
  SUPPORT_EMAIL_RETRY_CLAIM_STATUS,
  supportEmailRetryClaimStaleBefore,
  type SupportEmailStatus,
} from '../../shared/support-inbox-names';
import type { FeedbackInput } from './validation';
import { keys } from './keys';
import { conversationPatchAfterMessage } from './status';
import {
  closeConversation as closeConversationItem,
  transactPutAdminReply,
  transactPutSupportItems,
} from './table';

export function newConversationId(): string {
  return `conv_${nanoid(16)}`;
}

export function newMessageId(): string {
  return `msg_${nanoid(12)}`;
}

export interface PersistConversationInput extends FeedbackInput {
  conversationId: string;
  messageId?: string;
  uid?: string;
  createdAt?: string;
}

export function conversationItems(
  input: PersistConversationInput,
): [Record<string, unknown>, Record<string, unknown>] {
  const createdAt = input.createdAt ?? nowIso();
  const messageId = input.messageId ?? newMessageId();
  const pk = keys.conversationPk(input.conversationId);

  const meta: Record<string, unknown> = {
    PK: pk,
    SK: keys.metaSk,
    entityType: 'CONVERSATION',
    conversationId: input.conversationId,
    status: 'open',
    type: input.type,
    email: input.email,
    platform: input.platform,
    createdAt,
    updatedAt: createdAt,
    lastMessageAt: createdAt,
    lastMessagePreview: conversationPatchAfterMessage({
      author: 'user',
      body: input.message,
      createdAt,
    }).lastMessagePreview,
    lastMessageAuthor: 'user',
  };
  if (input.uid) {
    meta.uid = input.uid;
  }
  if (input.appVersion) {
    meta.appVersion = input.appVersion;
  }
  if (input.device) {
    meta.device = input.device;
  }
  if (input.screenshotKey) {
    meta.screenshotKey = input.screenshotKey;
  }

  const message: Record<string, unknown> = {
    PK: pk,
    SK: keys.messageSk(createdAt, messageId),
    entityType: 'MESSAGE',
    conversationId: input.conversationId,
    messageId,
    author: 'user',
    body: input.message,
    createdAt,
  };
  if (input.screenshotKey) {
    message.screenshotKey = input.screenshotKey;
  }

  return [meta, message];
}

export interface PersistConversationResult {
  conversationId: string;
  messageSk: string;
}

export async function persistConversation(
  input: PersistConversationInput,
): Promise<PersistConversationResult> {
  const items = conversationItems(input);
  await transactPutSupportItems(items);
  return {
    conversationId: input.conversationId,
    messageSk: String(items[1].SK),
  };
}

export interface PersistAdminReplyInput {
  conversationId: string;
  body: string;
  messageId?: string;
  createdAt?: string;
}

export interface PersistAdminReplyResult {
  conversationId: string;
  messageId: string;
  messageSk: string;
  body: string;
}

export function adminReplyMessageItem(
  input: PersistAdminReplyInput,
): Record<string, unknown> {
  const createdAt = input.createdAt ?? nowIso();
  const messageId = input.messageId ?? newMessageId();
  return {
    PK: keys.conversationPk(input.conversationId),
    SK: keys.messageSk(createdAt, messageId),
    entityType: 'MESSAGE',
    conversationId: input.conversationId,
    messageId,
    author: 'admin',
    body: input.body,
    createdAt,
  };
}

/**
 * Store an admin reply (MSG first via transact with META status=replied).
 * WARDROBE-286 user follow-up should call `conversationPatchAfterMessage`
 * with author `user` (status back to open) instead of duplicating this.
 */
export async function persistAdminReply(
  input: PersistAdminReplyInput,
): Promise<PersistAdminReplyResult> {
  const createdAt = input.createdAt ?? nowIso();
  const messageId = input.messageId ?? newMessageId();
  const message = adminReplyMessageItem({
    ...input,
    createdAt,
    messageId,
  });
  const patch = conversationPatchAfterMessage({
    author: 'admin',
    body: input.body,
    createdAt,
  });
  await transactPutAdminReply({
    conversationId: input.conversationId,
    message,
    ...patch,
    lastAdminMessageId: messageId,
  });
  return {
    conversationId: input.conversationId,
    messageId,
    messageSk: String(message.SK),
    body: input.body,
  };
}

export async function persistConversationClose(
  conversationId: string,
): Promise<{ conversationId: string; status: 'closed' }> {
  await closeConversationItem(conversationId);
  return { conversationId, status: 'closed' };
}

export function isRetryableAdminEmail(
  message: Record<string, unknown>,
): boolean {
  if (message.author !== 'admin') {
    return false;
  }
  const status = message.emailStatus as
    | SupportEmailStatus
    | typeof SUPPORT_EMAIL_RETRY_CLAIM_STATUS
    | undefined;
  if (status === 'failed') {
    return true;
  }
  if (status !== SUPPORT_EMAIL_RETRY_CLAIM_STATUS) {
    return false;
  }
  const claimedAt =
    typeof message.updatedAt === 'string' ? message.updatedAt : '';
  return (
    Boolean(claimedAt) &&
    claimedAt < supportEmailRetryClaimStaleBefore(nowIso())
  );
}

/**
 * Whether a retried admin message is the conversation's latest admin
 * message. Prefers META `lastAdminMessageId` when present; otherwise
 * compares `lastMessageAt` to the message `createdAt`.
 */
export function isLatestAdminMessage(
  conversation: Record<string, unknown>,
  message: Record<string, unknown>,
): boolean {
  if (conversation.lastMessageAuthor !== 'admin') {
    return false;
  }
  const messageId =
    typeof message.messageId === 'string' ? message.messageId : '';
  const lastAdminMessageId =
    typeof conversation.lastAdminMessageId === 'string'
      ? conversation.lastAdminMessageId
      : '';
  if (lastAdminMessageId && messageId) {
    return lastAdminMessageId === messageId;
  }
  const createdAt =
    typeof message.createdAt === 'string' ? message.createdAt : '';
  return Boolean(createdAt) && conversation.lastMessageAt === createdAt;
}
