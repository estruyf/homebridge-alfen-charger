/**
 * The charger's JSON is not always valid JSON.
 *
 * Two quirks are documented in the reference implementations: a trailing comma
 * before a closing brace (handled explicitly in the Home Assistant integration)
 * and bare `nan` where a float is expected (worked around in LordGaav's client).
 * Responses also come back as `alfen/json; charset=utf-8`, so nothing upstream
 * will have parsed them for us.
 */

export class AlfenJsonError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = 'AlfenJsonError';
  }
}

/**
 * Parse a response body, repairing the known firmware quirks if the strict
 * parse fails. Returns undefined for an empty body, which the charger sends for
 * a successful logout and for some property writes.
 */
export function parseAlfenJson<T = unknown>(raw: string): T | undefined {
  const text = raw.trim();
  if (text.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    // Fall through to the repair path.
  }

  const repaired = repairAlfenJson(text);
  try {
    return JSON.parse(repaired) as T;
  } catch (err) {
    throw new AlfenJsonError(
      `Could not parse charger response as JSON: ${(err as Error).message}`,
      truncate(text, 400),
    );
  }
}

/**
 * Apply the known repairs. Only called after a strict parse has already failed,
 * so the risk of mangling an otherwise valid document does not arise.
 */
export function repairAlfenJson(text: string): string {
  return (
    text
      // Bare nan/inf where a number belongs - only after ':' or ',' or '[' so
      // the words are not rewritten inside a string value.
      .replace(/([:[,]\s*)(-?)(nan|NaN|inf|Infinity)\b/g, '$1null')
      // Trailing comma before a closing brace or bracket.
      .replace(/,(\s*[}\]])/g, '$1')
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

/** One entry of a `GET /api/prop` response. */
export interface AlfenProperty {
  id: string;
  value: unknown;
  access?: number;
  type?: number;
  len?: number;
  cat?: string;
}

interface PropertyEnvelopeV2 {
  version: number;
  properties: AlfenProperty[];
  total?: number;
}

/**
 * Normalise a property response into a map of id -> value.
 *
 * Version 2 (every NG9xx firmware in the wild) wraps the entries in
 * `{version, properties, total}`. Version 1 returned a flat object keyed by
 * name; it is handled too because LordGaav's client still supports it.
 */
export function extractProperties(payload: unknown): Map<string, unknown> {
  const result = new Map<string, unknown>();
  if (payload === null || typeof payload !== 'object') {
    return result;
  }

  const envelope = payload as Partial<PropertyEnvelopeV2> & Record<string, unknown>;
  if (Array.isArray(envelope.properties)) {
    for (const property of envelope.properties) {
      if (property && typeof property.id === 'string') {
        result.set(property.id, property.value);
      }
    }
    return result;
  }

  // Version 1: {"count": n, "version": 1, "<name>": {id, value, ...}, ...}
  for (const [key, entry] of Object.entries(envelope)) {
    if (key === 'version' || key === 'count' || key === 'total') {
      continue;
    }
    if (entry && typeof entry === 'object' && 'id' in entry) {
      const property = entry as AlfenProperty;
      if (typeof property.id === 'string') {
        result.set(property.id, property.value);
      }
    }
  }
  return result;
}

/** Coerce a property value to a number, tolerating numeric strings and nulls. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
