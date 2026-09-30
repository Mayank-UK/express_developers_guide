/**
 * Shared payload validators for the DTO `fromJson` functions: they throw on
 * shape violations (rather than coercing) so bad server data surfaces loudly as
 * an InvalidResponseException via the http client's `parseDto` — ported from
 * the previous client/src/api/content_api.ts validators.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function requiredString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`expected string at "${key}"`);
  }
  return value;
}

export function requiredNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`expected number at "${key}"`);
  }
  return value;
}

export function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`expected string at "${key}"`);
  return value;
}

export function requiredArray(source: Record<string, unknown>, key: string): unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) throw new Error(`expected array at "${key}"`);
  return value;
}
