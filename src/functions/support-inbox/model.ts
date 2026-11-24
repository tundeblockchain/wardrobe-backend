import { nanoid } from 'nanoid';
import { nowIso } from '../../shared/ids';
import type { FeedbackInput } from './validation';
import { keys } from './keys';
import { transactPutSupportItems } from './table';

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

  return [meta, message];
}

export async function persistConversation(
  input: PersistConversationInput,
): Promise<{ conversationId: string }> {
  await transactPutSupportItems(conversationItems(input));
  return { conversationId: input.conversationId };
}
