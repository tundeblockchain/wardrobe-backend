import type { CdkCustomResourceEvent } from 'aws-lambda';
import { DynamoItem } from '../../src/shared/types';
import {
  GENERIC_MODEL_CATALOG_VERSION,
  genericModelIds,
} from '../../src/functions/ai-profiles/catalog';

const mockGetItem = jest.fn();
const mockPutItem = jest.fn();

jest.mock('../../src/shared/dynamodb', () => ({
  getItem: (...args: unknown[]) => mockGetItem(...args),
  putItem: (...args: unknown[]) => mockPutItem(...args),
  keys: {
    genericModelPk: () => 'AIPROFILE#GENERIC_MODEL',
    aiProfileSk: (id: string) => `AIPROFILE#${id}`,
    gsi1GenericTypePk: () => 'TYPE#GENERIC_MODEL',
    gsi1AiProfileSk: (id: string) => `AIPROFILE#${id}`,
  },
}));

import {
  GENERIC_MODEL_SEED_PHYSICAL_ID,
  handler,
} from '../../src/functions/ai-profiles/seed-handler';

function event(
  requestType: 'Create' | 'Update' | 'Delete',
): CdkCustomResourceEvent {
  const base = {
    ServiceToken: 'token',
    ResponseURL: 'https://example.com',
    StackId: 'stack',
    RequestId: 'req',
    LogicalResourceId: 'GenericModelCatalogSeed',
    ResourceType: 'Custom::GenericModelCatalog',
    ResourceProperties: {
      ServiceToken: 'token',
      CatalogVersion: GENERIC_MODEL_CATALOG_VERSION,
      TableName: 'wardrobe-app-dev',
    },
  };

  if (requestType === 'Create') {
    return { ...base, RequestType: 'Create' };
  }
  if (requestType === 'Delete') {
    return {
      ...base,
      RequestType: 'Delete',
      PhysicalResourceId: GENERIC_MODEL_SEED_PHYSICAL_ID,
    };
  }
  return {
    ...base,
    RequestType: 'Update',
    PhysicalResourceId: GENERIC_MODEL_SEED_PHYSICAL_ID,
    OldResourceProperties: base.ResourceProperties,
  };
}

describe('generic model seed custom-resource handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetItem.mockResolvedValue(undefined);
    mockPutItem.mockResolvedValue(undefined);
  });

  it('seeds the catalog on Create', async () => {
    const result = await handler(event('Create'));

    expect(result.PhysicalResourceId).toBe(GENERIC_MODEL_SEED_PHYSICAL_ID);
    expect(result.Data).toEqual({
      CatalogVersion: GENERIC_MODEL_CATALOG_VERSION,
      SeededIds: genericModelIds().join(','),
      Created: String(genericModelIds().length),
      Updated: '0',
    });
    expect(mockPutItem).toHaveBeenCalledTimes(genericModelIds().length);
    const first = mockPutItem.mock.calls[0][0] as DynamoItem;
    expect(first.type).toBe('GENERIC_MODEL');
    expect(first.status).toBe('READY');
  });

  it('re-seeds on Update and is a no-op on Delete', async () => {
    const update = await handler(event('Update'));
    expect(update.PhysicalResourceId).toBe(GENERIC_MODEL_SEED_PHYSICAL_ID);
    expect(mockPutItem).toHaveBeenCalled();

    mockPutItem.mockClear();
    mockGetItem.mockClear();

    const del = await handler(event('Delete'));
    expect(del.PhysicalResourceId).toBe(GENERIC_MODEL_SEED_PHYSICAL_ID);
    expect(mockGetItem).not.toHaveBeenCalled();
    expect(mockPutItem).not.toHaveBeenCalled();
  });
});
