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
 * FCM device tokens (WARDROBE-286). Token is hashed in SK because a raw
 * token may exceed DynamoDB's 1024-byte key limit (body allows 1..4096).
 *   PK DEVICE#<uid> / SK TOKEN#<sha256(token)>
 *
 * META holds status (open|replied|closed), type, email, uid?, platform,
 * appVersion?, device?, screenshotKey?, createdAt, updatedAt, lastMessageAt,
 * lastMessagePreview, lastMessageAuthor, lastAdminMessageId?, lastEmailStatus?,
 * lastReadAt?, lastAdminMessageAt?.
 * MSG items hold author, body, createdAt, screenshotKey?, emailStatus?,
 * pushStatus?.
 * Sparse GSIs: StatusLastMessageIndex (status + lastMessageAt) and
 * UidLastMessageIndex (uid + lastMessageAt). MSG, RATE, and DEVICE items
 * omit GSI keys.
 */

export const STATUS_LAST_MESSAGE_INDEX = 'StatusLastMessageIndex';
export const UID_LAST_MESSAGE_INDEX = 'UidLastMessageIndex';

export const keys = {
  conversationPk: (conversationId: string) => `CONV#${conversationId}`,
  metaSk: 'META',
  messageSkPrefix: 'MSG#',
  messageSk: (createdAt: string, messageId: string) =>
    `MSG#${createdAt}#${messageId}`,
  rateLimitPk: (scope: string, hashedId: string) => `RATE#${scope}#${hashedId}`,
  rateLimitSk: (windowStart: number) => `WINDOW#${windowStart}`,
  devicePk: (uid: string) => `DEVICE#${uid}`,
  deviceSkPrefix: 'TOKEN#',
  deviceSk: (tokenHash: string) => `TOKEN#${tokenHash}`,
};
