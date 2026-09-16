import { Errors } from '../../shared/errors';
import {
  DEFAULT_SHOPPING_HOME_LIMIT,
  DEFAULT_SHOPPING_LINKS_PER_ITEM,
  MAX_SHOPPING_HOME_LIMIT,
  MAX_SHOPPING_LINKS_PER_ITEM,
} from '../../shared/types';
import { optionalQueryString } from '../../shared/validation';

export interface ShoppingLinksQuery {
  limit: number;
  linksPerItem: number;
}

/**
 * Home query: `limit` (default 5, max 10) and `linksPerItem` (default 8, max 12).
 * Item-scoped uses `linksPerItem` the same way. Blank values are omitted.
 * Invalid numbers are `400 VALIDATION_ERROR`.
 */
export function parseShoppingLinksQuery(
  query: Record<string, string | undefined> | undefined,
  options: { includeLimit: boolean },
): ShoppingLinksQuery {
  const linksPerItem = parseBoundedInt(
    optionalQueryString(query?.linksPerItem, 'linksPerItem'),
    'linksPerItem',
    DEFAULT_SHOPPING_LINKS_PER_ITEM,
    1,
    MAX_SHOPPING_LINKS_PER_ITEM,
  );

  const limitRaw = optionalQueryString(query?.limit, 'limit');
  if (!options.includeLimit && limitRaw === undefined) {
    return { limit: DEFAULT_SHOPPING_HOME_LIMIT, linksPerItem };
  }

  const limit = parseBoundedInt(
    limitRaw,
    'limit',
    DEFAULT_SHOPPING_HOME_LIMIT,
    1,
    MAX_SHOPPING_HOME_LIMIT,
  );

  return { limit, linksPerItem };
}

function parseBoundedInt(
  raw: string | undefined,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw Errors.validation(`${field} must be an integer.`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw Errors.validation(`${field} must be between ${min} and ${max}.`);
  }
  return value;
}
