import {
  StageInputPolicyError,
  type StageInputGuard,
  type StageInputGuardRequest,
} from '../ports/stage-input-guard.js';

export interface SensitiveDataPattern {
  readonly id: string;
  readonly expression: RegExp;
}

export interface SensitiveDataGuardOptions {
  readonly patterns: readonly SensitiveDataPattern[];
  readonly inspectPlacement: (request: StageInputGuardRequest) => boolean;
  readonly maxNodes?: number;
  readonly maxDepth?: number;
  /** Per-string UTF-8 byte ceiling. Defaults to 1 MiB. */
  readonly maxStringBytes?: number;
}

export const DEFAULT_SENSITIVE_DATA_MAX_STRING_BYTES = 1_048_576;

const REGEXP_SOURCE_GETTER = Object.getOwnPropertyDescriptor(
  RegExp.prototype,
  'source',
)?.get;
const REGEXP_FLAG_GETTERS = [
  ['hasIndices', 'd'],
  ['global', 'g'],
  ['ignoreCase', 'i'],
  ['multiline', 'm'],
  ['dotAll', 's'],
  ['unicode', 'u'],
  ['unicodeSets', 'v'],
  ['sticky', 'y'],
] as const;

function clonePatternExpression(expression: RegExp): RegExp {
  try {
    if (
      Object.getPrototypeOf(expression) !== RegExp.prototype ||
      REGEXP_SOURCE_GETTER === undefined
    ) {
      throw new TypeError();
    }
    const ownKeys = Reflect.ownKeys(expression);
    const lastIndex = Object.getOwnPropertyDescriptor(expression, 'lastIndex');
    if (
      ownKeys.length !== 1 ||
      ownKeys[0] !== 'lastIndex' ||
      lastIndex === undefined ||
      !Object.hasOwn(lastIndex, 'value') ||
      lastIndex.enumerable === true
    ) {
      throw new TypeError();
    }
    const source = Reflect.apply(REGEXP_SOURCE_GETTER, expression, []);
    let flags = '';
    for (const [property, flag] of REGEXP_FLAG_GETTERS) {
      const getter = Object.getOwnPropertyDescriptor(
        RegExp.prototype,
        property,
      )?.get;
      if (
        getter !== undefined &&
        Reflect.apply(getter, expression, []) === true
      ) {
        flags += flag;
      }
    }
    return new RegExp(source, flags);
  } catch {
    throw new TypeError('sensitive_data_pattern_invalid');
  }
}

function inspectionLimit(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new TypeError('sensitive_data_guard_limit_invalid');
  }
  return candidate;
}

/** Counts UTF-8 bytes incrementally and stops before copying a large string. */
function exceedsUtf8ByteLimit(value: string, maxBytes: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > maxBytes) return true;
  }
  return false;
}

function containsMatch(
  value: unknown,
  patterns: readonly SensitiveDataPattern[],
  budget: { nodes: number },
  maxNodes: number,
  maxDepth: number,
  maxStringBytes: number,
  ancestors = new WeakSet<object>(),
  depth = 0,
): boolean {
  budget.nodes += 1;
  if (budget.nodes > maxNodes || depth > maxDepth) {
    throw new StageInputPolicyError('inspection_limit_exceeded');
  }
  if (typeof value === 'string') {
    if (exceedsUtf8ByteLimit(value, maxStringBytes)) {
      throw new StageInputPolicyError('inspection_string_limit_exceeded');
    }
    return patterns.some(({ expression }) => {
      expression.lastIndex = 0;
      return expression.test(value);
    });
  }
  if (value === null || typeof value !== 'object') return false;

  if (ancestors.has(value)) {
    throw new StageInputPolicyError('inspection_cycle_detected');
  }
  ancestors.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) {
        throw new StageInputPolicyError('inspection_unsafe_value');
      }
    } else if (prototype !== Object.prototype && prototype !== null) {
      throw new StageInputPolicyError('inspection_unsafe_value');
    }

    for (const key of Reflect.ownKeys(descriptors)) {
      if (Array.isArray(value) && key === 'length') continue;
      if (typeof key !== 'string') {
        throw new StageInputPolicyError('inspection_unsafe_value');
      }
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !('value' in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new StageInputPolicyError('inspection_unsafe_value');
      }
      if (
        containsMatch(
          key,
          patterns,
          budget,
          maxNodes,
          maxDepth,
          maxStringBytes,
          ancestors,
          depth + 1,
        )
      ) {
        return true;
      }
      if (
        containsMatch(
          descriptor.value,
          patterns,
          budget,
          maxNodes,
          maxDepth,
          maxStringBytes,
          ancestors,
          depth + 1,
        )
      ) {
        return true;
      }
    }
    return false;
  } catch (error) {
    if (error instanceof StageInputPolicyError) throw error;
    throw new StageInputPolicyError('inspection_unsafe_value');
  } finally {
    ancestors.delete(value);
  }
}

export class SensitiveDataGuard implements StageInputGuard {
  readonly #options: Required<
    Pick<SensitiveDataGuardOptions, 'maxNodes' | 'maxDepth' | 'maxStringBytes'>
  > &
    Omit<SensitiveDataGuardOptions, 'maxNodes' | 'maxDepth' | 'maxStringBytes'>;

  constructor(options: SensitiveDataGuardOptions) {
    const patterns = options.patterns.map(({ id, expression }) => {
      if (!(expression instanceof RegExp)) {
        throw new TypeError('sensitive_data_pattern_invalid');
      }
      return Object.freeze({
        id,
        expression: clonePatternExpression(expression),
      });
    });
    this.#options = {
      ...options,
      patterns: Object.freeze(patterns),
      maxNodes: inspectionLimit(options.maxNodes, 10_000),
      maxDepth: inspectionLimit(options.maxDepth, 32),
      maxStringBytes: inspectionLimit(
        options.maxStringBytes,
        DEFAULT_SENSITIVE_DATA_MAX_STRING_BYTES,
      ),
    };
  }

  inspect(request: StageInputGuardRequest): void {
    if (!this.#options.inspectPlacement(request)) return;
    if (
      containsMatch(
        request.inputs,
        this.#options.patterns,
        { nodes: 0 },
        this.#options.maxNodes,
        this.#options.maxDepth,
        this.#options.maxStringBytes,
      )
    ) {
      throw new StageInputPolicyError('sensitive_data_detected');
    }
  }
}
