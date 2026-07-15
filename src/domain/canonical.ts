import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export function compareCodePointStrings(left: string, right: string): number {
  const leftPoints = Array.from(
    left,
    (character) => character.codePointAt(0) ?? 0,
  );
  const rightPoints = Array.from(
    right,
    (character) => character.codePointAt(0) ?? 0,
  );
  const length = Math.min(leftPoints.length, rightPoints.length);

  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) {
      return difference;
    }
  }

  return leftPoints.length - rightPoints.length;
}

function serialize(value: unknown, path: string): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `canonical JSON does not support non-finite numbers at ${path}`,
      );
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item, index) => serialize(item, `${path}[${index}]`)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        `canonical JSON only supports plain objects at ${path}`,
      );
    }

    const object = value as Record<string, unknown>;
    const keys = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort(compareCodePointStrings);
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${serialize(object[key], `${path}.${key}`)}`,
      )
      .join(',')}}`;
  }

  throw new TypeError(
    `canonical JSON does not support ${typeof value} at ${path}`,
  );
}

export function canonicalJson(value: unknown): string {
  return serialize(value, '$');
}

export function sha256Digest(value: unknown): `sha256:${string}` {
  const digest = bytesToHex(
    sha256(new TextEncoder().encode(canonicalJson(value))),
  );
  return `sha256:${digest}`;
}
