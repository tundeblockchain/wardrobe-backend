import {
  LAST_MESSAGE_PREVIEW_CHARS,
  type SupportConversationStatus,
  type SupportMessageAuthor,
} from '../../shared/support-inbox-names';

/**
 * Status after a stored message.
 *
 * - new user feedback => open
 * - admin reply => replied (WARDROBE-284)
 * - user follow-up => open again (WARDROBE-286; helper only — no user
 *   endpoints in this change)
 *
 * Close is not a message: see `statusAfterClose`.
 */
export function statusAfterStoredMessage(
  author: SupportMessageAuthor,
): SupportConversationStatus {
  return author === 'admin' ? 'replied' : 'open';
}

/**
 * Hook for WARDROBE-286: a later user message reopens the thread.
 * Not wired to HTTP yet. Callers should use this instead of hardcoding
 * `open` so Stage 3 follow-up stays consistent with admin replies.
 */
export function statusAfterUserFollowUp(): SupportConversationStatus {
  return statusAfterStoredMessage('user');
}

export function statusAfterClose(): SupportConversationStatus {
  return 'closed';
}

export function lastMessagePreview(
  body: string,
  maxChars: number = LAST_MESSAGE_PREVIEW_CHARS,
): string {
  return body.slice(0, maxChars);
}

/**
 * META denormalized fields written with every stored message.
 * Admin replies and (later) user follow-ups share this so list/GSI stay
 * in sync. WARDROBE-286 should reuse this instead of a one-off update.
 */
export function conversationPatchAfterMessage(input: {
  author: SupportMessageAuthor;
  body: string;
  createdAt: string;
}): {
  status: SupportConversationStatus;
  lastMessageAt: string;
  lastMessagePreview: string;
  lastMessageAuthor: SupportMessageAuthor;
  lastAdminMessageAt?: string;
} {
  const patch: {
    status: SupportConversationStatus;
    lastMessageAt: string;
    lastMessagePreview: string;
    lastMessageAuthor: SupportMessageAuthor;
    lastAdminMessageAt?: string;
  } = {
    status: statusAfterStoredMessage(input.author),
    lastMessageAt: input.createdAt,
    lastMessagePreview: lastMessagePreview(input.body),
    lastMessageAuthor: input.author,
  };
  if (input.author === 'admin') {
    patch.lastAdminMessageAt = input.createdAt;
  }
  return patch;
}

/**
 * `unread` is true when the latest admin message is newer than lastReadAt.
 * Missing lastReadAt counts as never read. No admin message => not unread.
 */
export function conversationUnread(item: Record<string, unknown>): boolean {
  const lastAdminAt =
    optionalNonEmpty(item.lastAdminMessageAt) ??
    (item.lastMessageAuthor === 'admin'
      ? optionalNonEmpty(item.lastMessageAt)
      : undefined);
  if (!lastAdminAt) {
    return false;
  }
  const lastReadAt = optionalNonEmpty(item.lastReadAt);
  return !lastReadAt || lastAdminAt > lastReadAt;
}

function optionalNonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
