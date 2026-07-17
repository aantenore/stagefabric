export type Sha256Digest = `sha256:${string}`;

/** Locale-independent code-point ordering for stable browser contracts. */
export function compareBrowserStrings(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);

  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function serializeCanonical(value: unknown, path: string): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`non-finite number at ${path}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item, index) => serializeCanonical(item, `${path}[${index}]`))
      .join(',')}]`;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`non-plain object at ${path}`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareBrowserStrings);
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${serializeCanonical(record[key], `${path}.${key}`)}`,
      )
      .join(',')}}`;
  }
  throw new TypeError(`unsupported ${typeof value} at ${path}`);
}

export function browserCanonicalJson(value: unknown): string {
  return serializeCanonical(value, '$');
}

function subtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error('web_crypto_unavailable');
  }
  return subtle;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function sha256Bytes(value: BufferSource): Promise<Sha256Digest> {
  const digest = await subtleCrypto().digest('SHA-256', value);
  return `sha256:${toHex(digest)}`;
}

export async function sha256Text(value: string): Promise<Sha256Digest> {
  return sha256Bytes(new TextEncoder().encode(value));
}

export async function sha256Canonical(value: unknown): Promise<Sha256Digest> {
  return sha256Text(browserCanonicalJson(value));
}
