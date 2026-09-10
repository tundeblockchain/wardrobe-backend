import {
  AI_PROFILE_BODY_FIELD_NAMES,
  AiProfileBodyContext,
  AiProfileBodyFieldName,
} from '../../shared/types';

/**
 * Read persisted WARDROBE-80 / WARDROBE-82 fields. Invalid / empty stored
 * values are soft-omitted so a bad catalog row cannot break get / list /
 * try-on.
 */
export function pickAiProfileBodyContext(
  item: Record<string, unknown>,
): AiProfileBodyContext {
  const context: AiProfileBodyContext = {};

  const heightCm = asFiniteNumber(item.heightCm);
  const weightKg = asFiniteNumber(item.weightKg);
  const bustCm = asFiniteNumber(item.bustCm);
  const hipsCm = asFiniteNumber(item.hipsCm);
  const ageYears = asFiniteNumber(item.ageYears);
  const clothingSize = asNonEmptyString(item.clothingSize);
  const braSize = asNonEmptyString(item.braSize);
  const bodyType = asNonEmptyString(item.bodyType);
  const gender = asNonEmptyString(item.gender);

  if (heightCm !== undefined) {
    context.heightCm = heightCm;
  }
  if (weightKg !== undefined) {
    context.weightKg = weightKg;
  }
  if (bustCm !== undefined) {
    context.bustCm = bustCm;
  }
  if (hipsCm !== undefined) {
    context.hipsCm = hipsCm;
  }
  if (ageYears !== undefined && Number.isInteger(ageYears)) {
    context.ageYears = ageYears;
  }
  if (clothingSize) {
    context.clothingSize = clothingSize;
  }
  if (braSize) {
    context.braSize = braSize;
  }
  if (bodyType) {
    context.bodyType = bodyType;
  }
  if (gender) {
    context.gender = gender;
  }

  return context;
}

export function applyAiProfileBodyContext<T extends Record<string, unknown>>(
  target: T,
  context: AiProfileBodyContext | undefined,
): T {
  if (!context) {
    return target;
  }
  for (const field of AI_PROFILE_BODY_FIELD_NAMES) {
    const value = context[field];
    if (value !== undefined) {
      (target as Record<string, unknown>)[field] = value;
    }
  }
  return target;
}

export function isEmptyAiProfileBodyContext(
  context: AiProfileBodyContext | undefined,
): boolean {
  if (!context) {
    return true;
  }
  return AI_PROFILE_BODY_FIELD_NAMES.every(
    (field) => context[field] === undefined,
  );
}

export function sameAiProfileBodyContext(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const a = pickAiProfileBodyContext(left);
  const b = pickAiProfileBodyContext(right);
  return AI_PROFILE_BODY_FIELD_NAMES.every((field) => a[field] === b[field]);
}

const PROMPT_LABELS: Record<AiProfileBodyFieldName, string> = {
  heightCm: 'height',
  weightKg: 'weight',
  bustCm: 'bust',
  hipsCm: 'hips',
  clothingSize: 'clothing size',
  braSize: 'bra size',
  ageYears: 'age',
  bodyType: 'body type',
  gender: 'gender',
};

const PROMPT_UNITS: Partial<Record<AiProfileBodyFieldName, string>> = {
  heightCm: 'cm',
  weightKg: 'kg',
  bustCm: 'cm',
  hipsCm: 'cm',
  ageYears: 'years',
};

/**
 * Prompt lines for Gemini try-on. Soft-omits the whole section when empty.
 */
export function formatAiProfileBodyContextForPrompt(
  context: AiProfileBodyContext | undefined,
): string[] {
  if (isEmptyAiProfileBodyContext(context) || !context) {
    return [];
  }

  const lines = [
    'Person body context (ground the body in these measurements; do not invent missing ones):',
  ];

  for (const field of AI_PROFILE_BODY_FIELD_NAMES) {
    const value = context[field];
    if (value === undefined) {
      continue;
    }
    const unit = PROMPT_UNITS[field];
    const rendered = unit ? `${value} ${unit}` : String(value);
    lines.push(`- ${PROMPT_LABELS[field]}: ${rendered}`);
  }

  return lines;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}
