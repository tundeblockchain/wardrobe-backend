import type {
  CdkCustomResourceEvent,
  CdkCustomResourceResponse,
} from 'aws-lambda';
import { getItem, putItem } from '../../shared/dynamodb';
import { GENERIC_MODEL_CATALOG_VERSION, genericModelIds } from './catalog';
import { seedGenericModels } from './seed';

export const GENERIC_MODEL_SEED_PHYSICAL_ID = 'wardrobe-generic-model-catalog';

/**
 * CloudFormation custom-resource handler (WARDROBE-45).
 *
 * Create / Update writes READY GENERIC_MODEL rows. Delete is a no-op so
 * staging/prod catalog rows survive stack replacement (table is RETAIN).
 */
export async function handler(
  event: CdkCustomResourceEvent,
): Promise<CdkCustomResourceResponse> {
  const physicalId =
    event.RequestType === 'Create'
      ? GENERIC_MODEL_SEED_PHYSICAL_ID
      : event.PhysicalResourceId;

  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: physicalId };
  }

  const results = await seedGenericModels({ getItem, putItem });
  const created = results.filter((row) => row.action === 'created').length;
  const updated = results.filter((row) => row.action === 'updated').length;

  return {
    PhysicalResourceId: GENERIC_MODEL_SEED_PHYSICAL_ID,
    Data: {
      CatalogVersion: GENERIC_MODEL_CATALOG_VERSION,
      SeededIds: genericModelIds().join(','),
      Created: String(created),
      Updated: String(updated),
    },
  };
}
