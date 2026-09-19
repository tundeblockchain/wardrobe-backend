import { keys } from '../../shared/dynamodb';
import { nowIso } from '../../shared/ids';
import {
  DEVICE_PLATFORMS,
  Device,
  DevicePlatform,
  DynamoItem,
  JOB_EVENT_JOB_TYPES,
  JOB_EVENT_STATUSES,
  JOB_EVENT_TTL_SECONDS,
  JobEvent,
  JobEventJobType,
  JobEventStatus,
} from '../../shared/types';
import { jobEventId } from './ids';

/** Worker → inbox write. Same deep-link fields Flutter reads on GET /me/events. */
export interface JobDoneInput {
  userId: string;
  jobType: JobEventJobType;
  status: JobEventStatus;
  wardrobeId: string;
  itemId?: string;
  outfitId?: string;
  renderId?: string;
  aiProfileId?: string;
  error?: string;
}

export function isJobEventStatus(value: unknown): value is JobEventStatus {
  return (
    typeof value === 'string' &&
    (JOB_EVENT_STATUSES as readonly string[]).includes(value)
  );
}

export function isJobEventJobType(value: unknown): value is JobEventJobType {
  return (
    typeof value === 'string' &&
    (JOB_EVENT_JOB_TYPES as readonly string[]).includes(value)
  );
}

export function isDevicePlatform(value: unknown): value is DevicePlatform {
  return (
    typeof value === 'string' &&
    (DEVICE_PLATFORMS as readonly string[]).includes(value)
  );
}

export function jobEventTtl(nowSeconds = Math.floor(Date.now() / 1000)): number {
  return nowSeconds + JOB_EVENT_TTL_SECONDS;
}

export function toJobEventItem(input: JobDoneInput, createdAt = nowIso()): DynamoItem {
  const eventId = jobEventId(input);
  const item: DynamoItem = {
    PK: keys.userPk(input.userId),
    SK: keys.eventSk(eventId),
    entityType: 'JOB_EVENT',
    userId: input.userId,
    eventId,
    jobType: input.jobType,
    status: input.status,
    wardrobeId: input.wardrobeId,
    createdAt,
    updatedAt: createdAt,
    ttl: jobEventTtl(),
  };
  if (input.itemId) {
    item.itemId = input.itemId;
  }
  if (input.outfitId) {
    item.outfitId = input.outfitId;
  }
  if (input.renderId) {
    item.renderId = input.renderId;
  }
  if (input.aiProfileId) {
    item.aiProfileId = input.aiProfileId;
  }
  if (input.status === 'FAILED' && input.error) {
    item.error = input.error;
  }
  return item;
}

export function toJobEventDto(item: DynamoItem): JobEvent {
  const dto: JobEvent = {
    eventId: String(item.eventId ?? ''),
    jobType: item.jobType as JobEventJobType,
    status: item.status as JobEventStatus,
    wardrobeId: String(item.wardrobeId ?? ''),
    createdAt: String(item.createdAt ?? ''),
  };
  if (typeof item.itemId === 'string' && item.itemId) {
    dto.itemId = item.itemId;
  }
  if (typeof item.outfitId === 'string' && item.outfitId) {
    dto.outfitId = item.outfitId;
  }
  if (typeof item.renderId === 'string' && item.renderId) {
    dto.renderId = item.renderId;
  }
  if (typeof item.aiProfileId === 'string' && item.aiProfileId) {
    dto.aiProfileId = item.aiProfileId;
  }
  if (typeof item.error === 'string' && item.error) {
    dto.error = item.error;
  }
  if (typeof item.acknowledgedAt === 'string' && item.acknowledgedAt) {
    dto.acknowledgedAt = item.acknowledgedAt;
  }
  return dto;
}

export function isOwnedJobEvent(
  item: DynamoItem | undefined,
  userId: string,
): item is DynamoItem {
  return (
    !!item &&
    item.entityType === 'JOB_EVENT' &&
    item.userId === userId &&
    typeof item.eventId === 'string'
  );
}

export function isUnreadJobEvent(item: DynamoItem): boolean {
  return typeof item.acknowledgedAt !== 'string' || item.acknowledgedAt.length === 0;
}

export function toDeviceDto(item: DynamoItem): Device {
  return {
    deviceId: String(item.deviceId ?? ''),
    platform: item.platform as DevicePlatform,
    updatedAt: String(item.updatedAt ?? ''),
  };
}

export function isOwnedDevice(
  item: DynamoItem | undefined,
  userId: string,
): item is DynamoItem {
  return (
    !!item &&
    item.entityType === 'DEVICE' &&
    item.userId === userId &&
    typeof item.deviceId === 'string'
  );
}

export { jobEventId };
