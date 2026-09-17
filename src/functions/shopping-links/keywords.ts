import { logger } from '../../shared/logger';
import { getSecretString, parseJsonObjectOrString } from '../../shared/secrets';
import { DynamoItem } from '../../shared/types';
import {
  FetchLike,
  firstString,
  looksLikePlaceholderSecret,
  parseJsonContent,
  timedFetch,
} from './http';

export const DEFAULT_OPENAI_SHOPPING_ENDPOINT =
  'https://api.openai.com/v1/chat/completions';
export const DEFAULT_OPENAI_SHOPPING_MODEL = 'gpt-4.1-mini';
export const DEFAULT_OPENAI_SHOPPING_TIMEOUT_MS = 8_000;
export const MAX_SHOPPING_KEYWORDS = 8;
export const MAX_SHOPPING_IMAGE_BYTES = 4 * 1024 * 1024;

export interface OpenAiShoppingSecret {
  apiKey: string;
  model: string;
  endpoint: string;
}

export interface ItemImageBytes {
  bytes: Uint8Array;
  contentType?: string;
}

export interface KeywordExtractor {
  extract(input: {
    item: DynamoItem;
    image?: ItemImageBytes;
  }): Promise<string[]>;
}

export interface OpenAiKeywordExtractorOptions {
  fetchSecret?: () => Promise<OpenAiShoppingSecret>;
  httpPost?: FetchLike;
}

const SYSTEM_PROMPT = [
  'You write Google Shopping search queries for a clothing item.',
  'Use the photo (when present) plus the supplied metadata.',
  'Return JSON only: {"keywords":["short search phrase", "..."]}',
  `Return 3 to ${MAX_SHOPPING_KEYWORDS} concise retail search phrases.`,
  'Prefer brand + colour + garment type. No hashtags. No URLs.',
  'Do not mention the user. Do not invent a price.',
].join(' ');

export function createOpenAiKeywordExtractor(
  options: OpenAiKeywordExtractorOptions = {},
): KeywordExtractor {
  const fetchSecret = options.fetchSecret ?? loadOpenAiShoppingSecret;
  const httpPost =
    options.httpPost ?? timedFetch(readOpenAiTimeoutMs());

  return {
    async extract(input): Promise<string[]> {
      const secret = await fetchSecret();
      const response = await httpPost(secret.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          model: secret.model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: buildUserContent(input.item, input.image),
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(await openAiHttpError(response, secret.model));
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(await response.text());
      } catch {
        throw new Error('OpenAI shopping keywords returned a non-JSON body');
      }

      const keywords = keywordsFromOpenAiResponse(parsed);
      if (keywords.length === 0) {
        throw new Error('OpenAI shopping keywords response had no usable phrases');
      }
      return keywords;
    },
  };
}

export function parseOpenAiShoppingSecret(
  secretString: string | undefined,
): OpenAiShoppingSecret {
  const endpointFromEnv =
    process.env.OPENAI_SHOPPING_ENDPOINT?.trim() ||
    process.env.OPENAI_API_BASE?.trim();
  const modelFromEnv = process.env.OPENAI_SHOPPING_MODEL?.trim();

  if (!secretString?.trim()) {
    throw new Error('OpenAI shopping secret is empty');
  }
  if (looksLikePlaceholderSecret(secretString)) {
    throw new Error('OpenAI shopping secret is a placeholder');
  }

  const parsed = parseJsonObjectOrString(secretString);
  if (typeof parsed === 'string') {
    if (looksLikePlaceholderSecret(parsed)) {
      throw new Error('OpenAI shopping secret is a placeholder');
    }
    return {
      apiKey: parsed,
      model: modelFromEnv || DEFAULT_OPENAI_SHOPPING_MODEL,
      endpoint: endpointFromEnv || DEFAULT_OPENAI_SHOPPING_ENDPOINT,
    };
  }

  const apiKey = firstString(parsed, [
    'apiKey',
    'api_key',
    'key',
    'openaiApiKey',
    'OPENAI_API_KEY',
  ]);
  const model =
    firstString(parsed, ['model', 'openaiModel']) ||
    modelFromEnv ||
    DEFAULT_OPENAI_SHOPPING_MODEL;
  const endpoint =
    firstString(parsed, ['endpoint', 'url', 'baseUrl']) ||
    endpointFromEnv ||
    DEFAULT_OPENAI_SHOPPING_ENDPOINT;

  if (!apiKey || looksLikePlaceholderSecret(apiKey)) {
    throw new Error('OpenAI shopping secret is missing apiKey');
  }

  return { apiKey, model, endpoint };
}

export function keywordsFromOpenAiResponse(payload: unknown): string[] {
  const content = extractOpenAiMessageContent(payload);
  if (content === undefined) {
    return sanitizeKeywords(extractKeywordList(payload));
  }
  try {
    return sanitizeKeywords(extractKeywordList(parseJsonContent(content)));
  } catch {
    return sanitizeKeywords(splitKeywordText(content));
  }
}

export function sanitizeKeywords(values: string[]): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const raw of values) {
    const phrase = raw.replace(/\s+/g, ' ').trim();
    if (phrase.length < 2 || phrase.length > 80) {
      continue;
    }
    const key = phrase.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    keywords.push(phrase);
    if (keywords.length >= MAX_SHOPPING_KEYWORDS) {
      break;
    }
  }
  return keywords;
}

export function itemMetadataForKeywords(item: DynamoItem): Record<string, unknown> {
  const ai = asAiMap(item.ai);
  const colours = stringList(item.colours) ?? stringList(ai?.detectedColours);
  return {
    name: typeof item.name === 'string' ? item.name : undefined,
    category: item.category ?? ai?.detectedCategory,
    subcategory: item.subcategory ?? ai?.detectedSubcategory,
    colours,
    brand: typeof item.brand === 'string' ? item.brand : undefined,
  };
}

export function preferredItemImageKey(item: DynamoItem): string | undefined {
  if (typeof item.processedKey === 'string' && item.processedKey.trim()) {
    return item.processedKey.trim();
  }
  if (typeof item.originalKey === 'string' && item.originalKey.trim()) {
    return item.originalKey.trim();
  }
  return undefined;
}

async function loadOpenAiShoppingSecret(): Promise<OpenAiShoppingSecret> {
  const secretId = process.env.OPENAI_SHOPPING_SECRET_ARN;
  if (!secretId) {
    throw new Error('OPENAI_SHOPPING_SECRET_ARN is not configured');
  }
  return parseOpenAiShoppingSecret(await getSecretString(secretId));
}

function buildUserContent(
  item: DynamoItem,
  image?: ItemImageBytes,
): string | Array<Record<string, unknown>> {
  const metadata = {
    item: itemMetadataForKeywords(item),
    instruction: 'Produce Google Shopping search keywords for similar products.',
  };
  const text = JSON.stringify(metadata);

  if (!image || image.bytes.length === 0) {
    return text;
  }
  if (image.bytes.length > MAX_SHOPPING_IMAGE_BYTES) {
    logger.warn('Shopping-links image exceeds OpenAI size cap; using metadata only', {
      itemId: item.itemId,
      bytes: image.bytes.length,
    });
    return text;
  }

  const mime = resolveShoppingImageMimeType(image.bytes, image.contentType);
  const dataUrl = `data:${mime};base64,${Buffer.from(image.bytes).toString('base64')}`;
  return [
    { type: 'text', text },
    { type: 'image_url', image_url: { url: dataUrl } },
  ];
}

function extractOpenAiMessageContent(payload: unknown): string | undefined {
  const record = asObject(payload);
  if (!record) {
    return undefined;
  }
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }
  const first = asObject(choices[0]);
  const message = asObject(first?.message);
  const content = message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts = content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      const rec = asObject(part);
      return typeof rec?.text === 'string' ? rec.text : '';
    })
    .join('');
  return parts.trim() ? parts : undefined;
}

function extractKeywordList(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return payload.filter((value): value is string => typeof value === 'string');
  }
  const record = asObject(payload);
  if (!record) {
    return [];
  }
  const keywords = record.keywords ?? record.queries ?? record.searchQueries;
  if (typeof keywords === 'string') {
    return splitKeywordText(keywords);
  }
  if (Array.isArray(keywords)) {
    return keywords.flatMap((value) =>
      typeof value === 'string' ? [value] : [],
    );
  }
  return [];
}

function splitKeywordText(text: string): string[] {
  return text
    .split(/[\n,;|]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asAiMap(value: unknown): Record<string, unknown> | undefined {
  return asObject(value);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.map(String).filter((entry) => entry.trim());
  return items.length > 0 ? items : undefined;
}

function resolveShoppingImageMimeType(
  bytes: Uint8Array,
  contentType?: string,
): string {
  const normalized = contentType?.trim().toLowerCase();
  if (normalized === 'image/jpg') {
    return 'image/jpeg';
  }
  if (
    normalized === 'image/jpeg' ||
    normalized === 'image/png' ||
    normalized === 'image/webp' ||
    normalized === 'image/gif' ||
    normalized === 'image/heic' ||
    normalized === 'image/heif'
  ) {
    return normalized;
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

async function openAiHttpError(
  response: { status: number; text(): Promise<string> },
  model: string,
): Promise<string> {
  let detail = '';
  try {
    detail = (await response.text()).trim().slice(0, 300);
  } catch {
    detail = '';
  }
  const suffix = detail ? `: ${detail}` : '';
  return `OpenAI shopping keywords HTTP ${response.status} (model=${model})${suffix}`;
}

function readOpenAiTimeoutMs(): number {
  const raw = process.env.OPENAI_SHOPPING_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_OPENAI_SHOPPING_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_OPENAI_SHOPPING_TIMEOUT_MS;
}
