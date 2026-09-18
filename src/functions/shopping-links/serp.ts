import { getSecretString, parseJsonObjectOrString } from '../../shared/secrets';
import { ShoppingLink } from '../../shared/types';
import {
  FetchLike,
  asRecord,
  firstString,
  headerValue,
  looksLikeHtml,
  looksLikePlaceholderSecret,
  parseJsonContent,
  timedFetch,
  truncateUpstreamBody,
} from './http';

export const DEFAULT_BRIGHT_DATA_ENDPOINT = 'https://api.brightdata.com/request';
export const DEFAULT_BRIGHT_DATA_TIMEOUT_MS = 8_000;
export const DEFAULT_BRIGHT_DATA_COUNTRY = 'gb';
export const DEFAULT_BRIGHT_DATA_LANGUAGE = 'en';
/** Official SERP `/request` `format`: `json` is parsed SERP; `raw` is HTML. */
export const BRIGHT_DATA_SERP_FORMAT = 'json';
/** Bright Data parsed-JSON query value (`html` is the default on `format: raw`). */
export const BRIGHT_DATA_BRD_JSON = 'json';

export interface BrightDataSecret {
  apiToken: string;
  zone: string;
  endpoint: string;
  customer?: string;
  country: string;
  language: string;
}

export interface ShoppingSerpClient {
  search(input: {
    keywords: string[];
    metadataQuery?: string;
    maxLinks: number;
  }): Promise<ShoppingLink[]>;
}

export interface BrightDataSerpOptions {
  fetchSecret?: () => Promise<BrightDataSecret>;
  httpPost?: FetchLike;
}

export class BrightDataSerpError extends Error {
  readonly status?: number;
  readonly contentType?: string;
  readonly bodySnippet?: string;

  constructor(
    message: string,
    options: { status?: number; contentType?: string; body?: string } = {},
  ) {
    super(message);
    this.name = 'BrightDataSerpError';
    if (options.status !== undefined) {
      this.status = options.status;
    }
    if (options.contentType) {
      this.contentType = options.contentType;
    }
    if (options.body !== undefined) {
      this.bodySnippet = truncateUpstreamBody(options.body);
    }
  }
}

export function brightDataFailureLogFields(
  error: unknown,
): Record<string, unknown> {
  if (!(error instanceof BrightDataSerpError)) {
    return {};
  }
  const fields: Record<string, unknown> = {};
  if (error.status !== undefined) {
    fields.status = error.status;
  }
  if (error.contentType) {
    fields.contentType = error.contentType;
  }
  if (error.bodySnippet) {
    fields.bodySnippet = error.bodySnippet;
  }
  return fields;
}

/**
 * Bright Data SERP (Google Shopping) via REST `POST /request`.
 * Tests inject fetchSecret / httpPost — no live Bright Data in CI.
 *
 * `format` must be `json` (OpenAPI: `raw` is HTML). Google Shopping uses
 * `tbm=shop` plus `brd_json=json`. Do not send `udm=28` with `tbm=shop` —
 * that combination returns HTML that Bright Data does not parse.
 */
export function createBrightDataSerpClient(
  options: BrightDataSerpOptions = {},
): ShoppingSerpClient {
  const fetchSecret = options.fetchSecret ?? loadBrightDataSecret;
  const httpPost = options.httpPost ?? timedFetch(readBrightDataTimeoutMs());

  return {
    async search(input): Promise<ShoppingLink[]> {
      const secret = await fetchSecret();
      const query = buildShoppingQuery(input.keywords, input.metadataQuery);
      if (!query) {
        throw new BrightDataSerpError('Bright Data SERP query is empty');
      }

      const targetUrl = buildGoogleShoppingUrl(query, secret);
      const body = buildBrightDataRequestBody(secret, targetUrl);

      const response = await httpPost(secret.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret.apiToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });

      const contentType = headerValue(response.headers, 'content-type');
      const rawBody = await response.text();

      if (!response.ok) {
        throw new BrightDataSerpError(
          `Bright Data SERP HTTP ${response.status}`,
          { status: response.status, contentType, body: rawBody },
        );
      }

      let parsed: unknown;
      try {
        parsed = parseJsonContent(rawBody);
      } catch {
        throw new BrightDataSerpError(
          'Bright Data SERP returned a non-JSON body',
          { status: response.status, contentType, body: rawBody },
        );
      }

      const nestedHtml = nestedHtmlWithoutProducts(parsed);
      if (nestedHtml) {
        throw new BrightDataSerpError(
          'Bright Data SERP returned a non-JSON body',
          {
            status: response.status,
            contentType: contentType ?? 'text/html',
            body: nestedHtml,
          },
        );
      }

      return mapSerpToLinks(parsed, input.maxLinks, query);
    },
  };
}

export function buildBrightDataRequestBody(
  secret: Pick<BrightDataSecret, 'zone' | 'country'>,
  targetUrl: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    zone: secret.zone,
    url: targetUrl,
    format: BRIGHT_DATA_SERP_FORMAT,
  };
  if (secret.country) {
    body.country = secret.country;
  }
  return body;
}

export function parseBrightDataSecret(
  secretString: string | undefined,
): BrightDataSecret {
  if (!secretString?.trim()) {
    throw new Error('Bright Data secret is empty');
  }
  if (looksLikePlaceholderSecret(secretString)) {
    throw new Error('Bright Data secret is a placeholder');
  }

  const parsed = parseJsonObjectOrString(secretString);
  if (typeof parsed === 'string') {
    throw new Error('Bright Data secret must be JSON with apiToken and zone');
  }

  const apiToken = firstString(parsed, [
    'apiToken',
    'api_token',
    'token',
    'apiKey',
    'api_key',
    'key',
    'BRIGHT_DATA_API_TOKEN',
  ]);
  const zone = firstString(parsed, ['zone', 'zoneName', 'zone_name']);
  const endpoint =
    firstString(parsed, ['endpoint', 'url', 'baseUrl']) ||
    process.env.BRIGHT_DATA_ENDPOINT?.trim() ||
    DEFAULT_BRIGHT_DATA_ENDPOINT;
  const customer = firstString(parsed, ['customer', 'customerId', 'customer_id']);
  const country = (
    firstString(parsed, ['country', 'gl', 'geo']) ||
    process.env.BRIGHT_DATA_COUNTRY?.trim() ||
    DEFAULT_BRIGHT_DATA_COUNTRY
  ).toLowerCase();
  const language = (
    firstString(parsed, ['language', 'hl', 'lang']) ||
    process.env.BRIGHT_DATA_LANGUAGE?.trim() ||
    DEFAULT_BRIGHT_DATA_LANGUAGE
  ).toLowerCase();

  if (!apiToken || looksLikePlaceholderSecret(apiToken)) {
    throw new Error('Bright Data secret is missing apiToken');
  }
  if (!zone || looksLikePlaceholderSecret(zone)) {
    throw new Error('Bright Data secret is missing zone');
  }

  const secret: BrightDataSecret = {
    apiToken,
    zone,
    endpoint,
    country,
    language,
  };
  if (customer) {
    secret.customer = customer;
  }
  return secret;
}

export function buildShoppingQuery(
  keywords: string[],
  metadataQuery?: string,
): string {
  const parts = [...keywords.map((word) => word.trim()), metadataQuery?.trim()].filter(
    (value): value is string => Boolean(value),
  );
  return parts[0] ?? '';
}

export function buildGoogleShoppingUrl(
  query: string,
  secret: Pick<BrightDataSecret, 'country' | 'language'>,
): string {
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('tbm', 'shop');
  url.searchParams.set('hl', secret.language);
  url.searchParams.set('gl', secret.country);
  url.searchParams.set('brd_json', BRIGHT_DATA_BRD_JSON);
  return url.toString();
}

export function mapSerpToLinks(
  payload: unknown,
  maxLinks: number,
  fallbackQuery: string,
): ShoppingLink[] {
  const rows = collectProductRows(unwrapSerpPayload(payload));
  const links: ShoppingLink[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const mapped = toShoppingLink(row, fallbackQuery);
    if (!mapped) {
      continue;
    }
    const signature = `${mapped.url}|${mapped.title.toLowerCase()}`;
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    links.push(mapped);
    if (links.length >= maxLinks) {
      break;
    }
  }

  return links;
}

function unwrapSerpPayload(payload: unknown): unknown {
  const record = asRecord(payload);
  if (!record) {
    return payload;
  }
  const nestedBody = record.body ?? record.data ?? record.result;
  if (typeof nestedBody === 'string') {
    try {
      return parseJsonContent(nestedBody);
    } catch {
      return payload;
    }
  }
  if (nestedBody && typeof nestedBody === 'object') {
    return nestedBody;
  }
  return payload;
}

/** Unlocker-style `{ body: "<html>..." }` with no shopping rows is still a non-JSON SERP. */
function nestedHtmlWithoutProducts(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (!record || typeof record.body !== 'string' || !looksLikeHtml(record.body)) {
    return undefined;
  }
  if (collectProductRows(unwrapSerpPayload(payload)).length > 0) {
    return undefined;
  }
  return record.body;
}

function collectProductRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((entry) => {
      const rec = asRecord(entry);
      return rec ? [rec] : [];
    });
  }
  const record = asRecord(payload);
  if (!record) {
    return [];
  }

  const buckets = [
    record.shopping,
    record.products,
    record.organic,
    record.items,
    record.results,
    record.shopping_results,
    record.inline_shopping,
  ];
  const rows: Record<string, unknown>[] = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) {
      continue;
    }
    for (const entry of bucket) {
      const rec = asRecord(entry);
      if (rec) {
        rows.push(rec);
      }
    }
  }
  return rows;
}

function toShoppingLink(
  row: Record<string, unknown>,
  fallbackQuery: string,
): ShoppingLink | undefined {
  const title = firstString(row, ['title', 'name', 'product_title', 'productName']);
  if (!title) {
    return undefined;
  }

  const url =
    firstHttpUrl(row, [
      'url',
      'link',
      'href',
      'product_link',
      'product_url',
      'productLink',
      'offer_link',
    ]) ?? googleShoppingFallbackUrl(title, fallbackQuery);

  const link: ShoppingLink = { title, url };

  const merchant = merchantName(row);
  if (merchant) {
    link.merchant = merchant;
  }

  const price = priceString(row);
  if (price) {
    link.price = price;
  }

  const currency = currencyCode(row, price);
  if (currency) {
    link.currency = currency;
  }

  const imageUrl = firstHttpUrl(row, [
    'imageUrl',
    'image_url',
    'thumbnail',
    'thumbnail_url',
    'image',
    'img',
  ]);
  if (imageUrl) {
    link.imageUrl = imageUrl;
  }

  return link;
}

function merchantName(row: Record<string, unknown>): string | undefined {
  const direct = firstString(row, [
    'merchant',
    'shop',
    'source',
    'store',
    'seller',
    'vendor',
  ]);
  if (direct) {
    return direct;
  }
  for (const key of ['merchant', 'shop', 'source', 'store', 'seller']) {
    const nested = asRecord(row[key]);
    const name = nested
      ? firstString(nested, ['name', 'title', 'shop', 'source'])
      : undefined;
    if (name) {
      return name;
    }
  }
  return undefined;
}

function priceString(row: Record<string, unknown>): string | undefined {
  const direct = firstString(row, ['price', 'price_str', 'extracted_price']);
  if (direct) {
    return direct;
  }
  const nested = asRecord(row.price);
  if (nested) {
    return (
      firstString(nested, ['raw', 'value', 'display', 'amount', 'current']) ??
      (typeof nested.value === 'number' ? String(nested.value) : undefined)
    );
  }
  if (typeof row.price === 'number' && Number.isFinite(row.price)) {
    return String(row.price);
  }
  return undefined;
}

function currencyCode(row: Record<string, unknown>, price?: string): string | undefined {
  const explicit = firstString(row, ['currency', 'currencyCode', 'currency_code']);
  if (explicit) {
    return explicit.toUpperCase();
  }
  const nested = asRecord(row.price);
  const nestedCode = nested
    ? firstString(nested, ['currency', 'currencyCode', 'code'])
    : undefined;
  if (nestedCode) {
    return nestedCode.toUpperCase();
  }
  if (!price) {
    return undefined;
  }
  if (price.includes('£')) {
    return 'GBP';
  }
  if (price.includes('€')) {
    return 'EUR';
  }
  if (price.includes('$')) {
    return 'USD';
  }
  return undefined;
}

function firstHttpUrl(
  record: Record<string, unknown>,
  keysToTry: string[],
): string | undefined {
  for (const key of keysToTry) {
    const value = record[key];
    if (typeof value === 'string' && isHttpUrl(value)) {
      return value.trim();
    }
    const nested = asRecord(value);
    if (nested) {
      const nestedUrl = firstString(nested, ['url', 'href', 'link', 'src']);
      if (nestedUrl && isHttpUrl(nestedUrl)) {
        return nestedUrl;
      }
    }
  }
  return undefined;
}

function isHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('https://') || trimmed.startsWith('http://');
}

function googleShoppingFallbackUrl(title: string, fallbackQuery: string): string {
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('tbm', 'shop');
  url.searchParams.set('q', title || fallbackQuery);
  return url.toString();
}

async function loadBrightDataSecret(): Promise<BrightDataSecret> {
  const secretId = process.env.BRIGHT_DATA_SECRET_ARN;
  if (!secretId) {
    throw new Error('BRIGHT_DATA_SECRET_ARN is not configured');
  }
  return parseBrightDataSecret(await getSecretString(secretId));
}

function readBrightDataTimeoutMs(): number {
  const raw = process.env.BRIGHT_DATA_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_BRIGHT_DATA_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_BRIGHT_DATA_TIMEOUT_MS;
}
