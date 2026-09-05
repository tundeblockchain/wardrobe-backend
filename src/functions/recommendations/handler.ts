import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import { getOwnedWardrobe, keys, queryByPk } from '../../shared/dynamodb';
import { Errors } from '../../shared/errors';
import { errorResponse, ok } from '../../shared/http';
import { OutfitRecommendationsResponse } from '../../shared/types';
import { createHttpOutfitRecommender } from './http-recommender';
import {
  createRuleBasedRecommender,
  OutfitRecommender,
  toRecommendableItem,
} from './strategy';

export interface RecommendationsHandlerDeps {
  recommender?: OutfitRecommender;
}

/**
 * GET /wardrobes/{wardrobeId}/recommendations
 *
 * Owner-only derived suggestions. Never persists outfits — Flutter can
 * POST /wardrobes/{wardrobeId}/outfits if the user saves one.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  return handleRecommendations(event);
}

export async function handleRecommendations(
  event: APIGatewayProxyEventV2,
  deps: RecommendationsHandlerDeps = {},
): Promise<APIGatewayProxyResultV2> {
  try {
    const userId = getUserId(event);
    const method = event.requestContext.http.method;
    const wardrobeId = event.pathParameters?.wardrobeId?.trim();

    if (!wardrobeId) {
      throw Errors.validation('wardrobeId is required.');
    }

    if (method !== 'GET') {
      throw Errors.validation(`Unsupported method: ${method}`);
    }

    const recommendations = await listRecommendations(userId, wardrobeId, deps);
    const body: OutfitRecommendationsResponse = { recommendations };
    return ok(body);
  } catch (error) {
    return errorResponse(error);
  }
}

async function listRecommendations(
  userId: string,
  wardrobeId: string,
  deps: RecommendationsHandlerDeps,
) {
  await getOwnedWardrobe(userId, wardrobeId);

  const records = await queryByPk(keys.wardrobePk(wardrobeId), 'ITEM#');
  const items = records
    .filter(
      (item) =>
        item.entityType === 'ITEM' &&
        item.userId === userId &&
        item.wardrobeId === wardrobeId,
    )
    .map(toRecommendableItem)
    .filter((item): item is NonNullable<typeof item> => item !== undefined);

  const recommender = deps.recommender ?? createDefaultRecommender();
  return recommender.recommend(items);
}

/**
 * Default is rule-based so production and CI work without a vendor.
 * Set RECOMMENDER_STRATEGY=http to use the optional Secrets Manager hook.
 */
export function createDefaultRecommender(): OutfitRecommender {
  if (process.env.RECOMMENDER_STRATEGY === 'http') {
    return createHttpOutfitRecommender();
  }
  return createRuleBasedRecommender();
}
