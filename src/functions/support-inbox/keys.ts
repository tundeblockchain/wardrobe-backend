/**
 * Support inbox table keys (WARDROBE-281). Separate from the main
 * wardrobe-app single table.
 *
 * Conversation:
 *   PK CONV#<id> / SK META
 *   PK CONV#<id> / SK MSG#<isoTs>#<messageId>
 *
 * Rate-limit windows (TTL on `ttl`):
 *   PK RATE#<scope>#<sha256> / SK WINDOW#<unixWindowStart>
 *
 * META holds status (open|replied|closed), type, email, uid?, platform,
 * appVersion?, device?, screenshotKey?, createdAt, updatedAt, lastMessageAt.
 * The first MSG item is updated after the Resend attempt with
 * emailStatus "sent" | "failed" | "skipped".
 * Sparse GSIs: StatusLastMessageIndex (status + lastMessageAt) and
 * UidLastMessageIndex (uid + lastMessageAt). MSG and RATE items omit GSI keys.
 */

export const STATUS_LAST_MESSAGE_INDEX = 'StatusLastMessageIndex';
export const UID_LAST_MESSAGE_INDEX = 'UidLastMessageIndex';

export const keys = {
  conversationPk: (conversationId: string) => `CONV#${conversationId}`,
  metaSk: 'META',
  messageSk: (createdAt: string, messageId: string) =>
    `MSG#${createdAt}#${messageId}`,
  rateLimitPk: (scope: string, hashedId: string) => `RATE#${scope}#${hashedId}`,
  rateLimitSk: (windowStart: number) => `WINDOW#${windowStart}`,
};
