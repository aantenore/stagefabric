import {
  compareBrowserStrings,
  sha256Text,
  type Sha256Digest,
} from './crypto.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SAFE_FLAGS = /^[imsu]*$/;
const MAX_POLICY_SOURCES = 4_096;

export interface RedactionRule {
  readonly ruleId: string;
  readonly category: string;
  readonly priority: number;
  readonly pattern: string;
  readonly flags?: string;
  readonly replacement: string;
}

export interface ClassifiedSensitiveSpan {
  /** UTF-16 code-unit offset, matching browser String APIs. */
  readonly start: number;
  /** Exclusive UTF-16 code-unit offset. */
  readonly end: number;
  readonly category: string;
}

export interface SensitiveSpanClassifier {
  readonly classifierId: string;
  classify(
    input: string,
    options: { readonly signal?: AbortSignal },
  ): Promise<readonly ClassifiedSensitiveSpan[]>;
}

export interface ConfiguredSensitiveSpanClassifier {
  readonly classifier: SensitiveSpanClassifier;
  readonly priority: number;
}

export interface RedactionCascadePolicy {
  readonly policyId: string;
  readonly policyDigest: Sha256Digest;
  readonly rules: readonly RedactionRule[];
  readonly classifiers?: readonly ConfiguredSensitiveSpanClassifier[];
  readonly classifierReplacements?: Readonly<Record<string, string>>;
  readonly defaultClassifierReplacement: string;
  readonly maxCandidateSpans: number;
  /** Bounds operator-owned regular-expression work inside the worker. */
  readonly maxInputCodeUnits: number;
  /** Regex rules are permitted only in a killable Dedicated Worker. */
  readonly executionBoundary: 'dedicated-worker';
}

export interface AppliedRedaction {
  readonly start: number;
  readonly end: number;
  readonly category: string;
  readonly sourceKind: 'rule' | 'classifier';
  readonly sourceId: string;
  readonly priority: number;
}

export interface RedactionCascadeResult {
  readonly output: string;
  readonly redactions: readonly AppliedRedaction[];
  readonly policyId: string;
  readonly policyDigest: Sha256Digest;
}

export interface VerifiedRedactedOutput {
  readonly policyId: string;
  readonly policyDigest: Sha256Digest;
  readonly outputDigest: Sha256Digest;
  readonly evaluatedRuleIds: readonly string[];
  readonly evaluatedClassifierIds: readonly string[];
}

const verifiedOutputs = new WeakSet<object>();
interface EvaluatedSourceIds {
  readonly ruleIds: readonly string[];
  readonly classifierIds: readonly string[];
}

const redactionResultSources = new WeakMap<object, EvaluatedSourceIds>();
const verifiedRedactionOrigins = new WeakMap<object, object>();

export type RedactionCascadeFailureCode =
  | 'aborted'
  | 'candidate_limit_exceeded'
  | 'classifier_failed'
  | 'input_limit_exceeded'
  | 'invalid_classifier_span'
  | 'invalid_policy'
  | 'invalid_redaction_result'
  | 'invalid_rule';

export class RedactionCascadeError extends Error {
  readonly code: RedactionCascadeFailureCode;

  constructor(code: RedactionCascadeFailureCode) {
    super(code);
    this.name = 'RedactionCascadeError';
    this.code = code;
  }
}

interface Candidate extends AppliedRedaction {
  readonly replacement: string;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

function validPriority(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
}

function validReplacement(value: string): boolean {
  return value.length > 0 && value.length <= 1_024;
}

function isCodePointBoundary(input: string, offset: number): boolean {
  if (offset <= 0 || offset >= input.length) return true;
  const previous = input.charCodeAt(offset - 1);
  const current = input.charCodeAt(offset);
  return !(
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
  );
}

function validatePolicy(policy: RedactionCascadePolicy): void {
  if (
    !Array.isArray(policy.rules) ||
    policy.rules.length > MAX_POLICY_SOURCES ||
    (policy.classifiers !== undefined &&
      (!Array.isArray(policy.classifiers) ||
        policy.classifiers.length > MAX_POLICY_SOURCES)) ||
    !validId(policy.policyId) ||
    !/^sha256:[a-f0-9]{64}$/.test(policy.policyDigest) ||
    !Number.isSafeInteger(policy.maxCandidateSpans) ||
    policy.maxCandidateSpans < 1 ||
    policy.maxCandidateSpans > 100_000 ||
    !Number.isSafeInteger(policy.maxInputCodeUnits) ||
    policy.maxInputCodeUnits < 1 ||
    policy.maxInputCodeUnits > 16 * 1_024 * 1_024 ||
    policy.executionBoundary !== 'dedicated-worker' ||
    !validReplacement(policy.defaultClassifierReplacement)
  ) {
    throw new RedactionCascadeError('invalid_policy');
  }

  const sourceIds = new Set<string>();
  for (const rule of policy.rules) {
    if (
      !validId(rule.ruleId) ||
      !validId(rule.category) ||
      !validPriority(rule.priority) ||
      rule.pattern.length === 0 ||
      rule.pattern.length > 16_384 ||
      !SAFE_FLAGS.test(rule.flags ?? '') ||
      new Set(rule.flags ?? '').size !== (rule.flags ?? '').length ||
      !validReplacement(rule.replacement) ||
      sourceIds.has(rule.ruleId)
    ) {
      throw new RedactionCascadeError('invalid_rule');
    }
    sourceIds.add(rule.ruleId);
    try {
      new RegExp(rule.pattern, `${rule.flags ?? ''}g`);
    } catch {
      throw new RedactionCascadeError('invalid_rule');
    }
  }

  for (const configured of policy.classifiers ?? []) {
    if (
      !validId(configured.classifier.classifierId) ||
      !validPriority(configured.priority) ||
      sourceIds.has(configured.classifier.classifierId)
    ) {
      throw new RedactionCascadeError('invalid_policy');
    }
    sourceIds.add(configured.classifier.classifierId);
  }

  for (const [category, replacement] of Object.entries(
    policy.classifierReplacements ?? {},
  )) {
    if (!validId(category) || !validReplacement(replacement)) {
      throw new RedactionCascadeError('invalid_policy');
    }
  }
}

function snapshotClassifierReplacements(
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new RedactionCascadeError('invalid_policy');
    }

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > MAX_POLICY_SOURCES) {
      throw new RedactionCascadeError('invalid_policy');
    }

    const snapshot = Object.create(null) as Record<string, string>;
    for (const key of ownKeys) {
      if (typeof key !== 'string') {
        throw new RedactionCascadeError('invalid_policy');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'string'
      ) {
        throw new RedactionCascadeError('invalid_policy');
      }
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof RedactionCascadeError) throw error;
    throw new RedactionCascadeError('invalid_policy');
  }
}

function snapshotPolicyArray<T>(value: readonly T[]): readonly T[] {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertyDescriptor(value, Symbol.iterator) !== undefined
    ) {
      throw new RedactionCascadeError('invalid_policy');
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      lengthDescriptor === undefined ||
      !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > MAX_POLICY_SOURCES
    ) {
      throw new RedactionCascadeError('invalid_policy');
    }
    const snapshot: T[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, 'value') ||
        descriptor.enumerable !== true
      ) {
        throw new RedactionCascadeError('invalid_policy');
      }
      snapshot.push(descriptor.value as T);
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof RedactionCascadeError) throw error;
    throw new RedactionCascadeError('invalid_policy');
  }
}

/** Captures every policy field before classifier work yields to another task. */
function snapshotPolicy(
  policy: RedactionCascadePolicy,
): RedactionCascadePolicy {
  try {
    if (typeof policy !== 'object' || policy === null) {
      throw new RedactionCascadeError('invalid_policy');
    }
    const rulesSource = snapshotPolicyArray(policy.rules);
    const configuredClassifiers = policy.classifiers;
    const classifiersSource =
      configuredClassifiers === undefined
        ? undefined
        : snapshotPolicyArray(configuredClassifiers);
    const rules = Object.freeze(
      rulesSource.map((rule) =>
        Object.freeze({
          ruleId: rule.ruleId,
          category: rule.category,
          priority: rule.priority,
          pattern: rule.pattern,
          ...(rule.flags === undefined ? {} : { flags: rule.flags }),
          replacement: rule.replacement,
        }),
      ),
    );
    const classifiers =
      classifiersSource === undefined
        ? undefined
        : Object.freeze(
            classifiersSource.map((configured) => {
              const source = configured.classifier;
              const classifierId = source.classifierId;
              const classify = source.classify;
              if (typeof classify !== 'function') {
                throw new RedactionCascadeError('invalid_policy');
              }
              const classifier = Object.freeze({
                classifierId,
                classify: (
                  input: string,
                  options: { readonly signal?: AbortSignal },
                ): Promise<readonly ClassifiedSensitiveSpan[]> =>
                  Reflect.apply(classify, source, [input, options]) as Promise<
                    readonly ClassifiedSensitiveSpan[]
                  >,
              });
              return Object.freeze({
                classifier,
                priority: configured.priority,
              });
            }),
          );
    const classifierReplacements = snapshotClassifierReplacements(
      policy.classifierReplacements,
    );
    const snapshot: RedactionCascadePolicy = Object.freeze({
      policyId: policy.policyId,
      policyDigest: policy.policyDigest,
      rules,
      ...(classifiers === undefined ? {} : { classifiers }),
      ...(classifierReplacements === undefined
        ? {}
        : { classifierReplacements }),
      defaultClassifierReplacement: policy.defaultClassifierReplacement,
      maxCandidateSpans: policy.maxCandidateSpans,
      maxInputCodeUnits: policy.maxInputCodeUnits,
      executionBoundary: policy.executionBoundary,
    });
    validatePolicy(snapshot);
    return snapshot;
  } catch (error) {
    if (error instanceof RedactionCascadeError) throw error;
    throw new RedactionCascadeError('invalid_policy');
  }
}

function evaluatedSourceIds(
  policy: RedactionCascadePolicy,
): EvaluatedSourceIds {
  return Object.freeze({
    ruleIds: Object.freeze(
      policy.rules.map((rule) => rule.ruleId).sort(compareBrowserStrings),
    ),
    classifierIds: Object.freeze(
      (policy.classifiers ?? [])
        .map((configured) => configured.classifier.classifierId)
        .sort(compareBrowserStrings),
    ),
  });
}

function sameSourceIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((sourceId, index) => sourceId === right[index])
  );
}

function assertCandidateLimit(
  candidates: readonly Candidate[],
  maxCandidateSpans: number,
): void {
  if (candidates.length > maxCandidateSpans) {
    throw new RedactionCascadeError('candidate_limit_exceeded');
  }
}

function ruleCandidates(
  input: string,
  policy: RedactionCascadePolicy,
): Candidate[] {
  const candidates: Candidate[] = [];
  const rules = [...policy.rules].sort(
    (left, right) =>
      right.priority - left.priority ||
      compareBrowserStrings(left.ruleId, right.ruleId),
  );

  for (const rule of rules) {
    const expression = new RegExp(rule.pattern, `${rule.flags ?? ''}g`);
    for (const match of input.matchAll(expression)) {
      if (match.index === undefined || match[0].length === 0) continue;
      candidates.push({
        start: match.index,
        end: match.index + match[0].length,
        category: rule.category,
        sourceKind: 'rule',
        sourceId: rule.ruleId,
        priority: rule.priority,
        replacement: rule.replacement,
      });
      assertCandidateLimit(candidates, policy.maxCandidateSpans);
    }
  }
  return candidates;
}

function snapshotClassifierSpan(value: unknown): ClassifiedSensitiveSpan {
  if (typeof value !== 'object' || value === null) {
    throw new RedactionCascadeError('invalid_classifier_span');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RedactionCascadeError('invalid_classifier_span');
  }

  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== 3 ||
    !ownKeys.includes('start') ||
    !ownKeys.includes('end') ||
    !ownKeys.includes('category')
  ) {
    throw new RedactionCascadeError('invalid_classifier_span');
  }

  const descriptors = ['start', 'end', 'category'].map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      throw new RedactionCascadeError('invalid_classifier_span');
    }
    return descriptor;
  });

  return Object.freeze({
    start: descriptors[0]!.value as number,
    end: descriptors[1]!.value as number,
    category: descriptors[2]!.value as string,
  });
}

function snapshotClassifierSpans(
  value: unknown,
  remainingCandidateSpans: number,
): readonly ClassifiedSensitiveSpan[] {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertyDescriptor(value, Symbol.iterator) !== undefined
    ) {
      throw new RedactionCascadeError('invalid_classifier_span');
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      lengthDescriptor === undefined ||
      !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      throw new RedactionCascadeError('invalid_classifier_span');
    }
    if (lengthDescriptor.value > remainingCandidateSpans) {
      throw new RedactionCascadeError('candidate_limit_exceeded');
    }

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== lengthDescriptor.value + 1) {
      throw new RedactionCascadeError('invalid_classifier_span');
    }

    const snapshot: ClassifiedSensitiveSpan[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        throw new RedactionCascadeError('invalid_classifier_span');
      }
      snapshot.push(snapshotClassifierSpan(descriptor.value));
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (
      error instanceof RedactionCascadeError &&
      error.code === 'candidate_limit_exceeded'
    ) {
      throw error;
    }
    throw new RedactionCascadeError('invalid_classifier_span');
  }
}

async function classifierCandidates(
  input: string,
  policy: RedactionCascadePolicy,
  signal: AbortSignal | undefined,
  candidates: Candidate[],
): Promise<void> {
  const classifiers = [...(policy.classifiers ?? [])].sort((left, right) =>
    compareBrowserStrings(
      left.classifier.classifierId,
      right.classifier.classifierId,
    ),
  );

  let results: readonly (readonly ClassifiedSensitiveSpan[])[];
  const classifierOptions: { readonly signal?: AbortSignal } =
    signal === undefined ? {} : { signal };
  try {
    results = await Promise.all(
      classifiers.map((configured) =>
        configured.classifier.classify(input, classifierOptions),
      ),
    );
  } catch {
    if (signal?.aborted === true) {
      throw new RedactionCascadeError('aborted');
    }
    throw new RedactionCascadeError('classifier_failed');
  }

  for (
    let classifierIndex = 0;
    classifierIndex < results.length;
    classifierIndex += 1
  ) {
    const spans = snapshotClassifierSpans(
      results[classifierIndex],
      policy.maxCandidateSpans - candidates.length,
    );
    const configured = classifiers[classifierIndex]!;
    for (const span of spans) {
      if (
        !Number.isSafeInteger(span.start) ||
        !Number.isSafeInteger(span.end) ||
        span.start < 0 ||
        span.start >= span.end ||
        span.end > input.length ||
        !isCodePointBoundary(input, span.start) ||
        !isCodePointBoundary(input, span.end) ||
        !validId(span.category)
      ) {
        throw new RedactionCascadeError('invalid_classifier_span');
      }
      candidates.push({
        start: span.start,
        end: span.end,
        category: span.category,
        sourceKind: 'classifier',
        sourceId: configured.classifier.classifierId,
        priority: configured.priority,
        replacement:
          policy.classifierReplacements?.[span.category] ??
          policy.defaultClassifierReplacement,
      });
      assertCandidateLimit(candidates, policy.maxCandidateSpans);
    }
  }
}

function overlaps(left: Candidate, right: Candidate): boolean {
  return left.start < right.end && right.start < left.end;
}

function resolveCandidates(candidates: readonly Candidate[]): Candidate[] {
  const precedence = [...candidates].sort(
    (left, right) =>
      right.priority - left.priority ||
      right.end - right.start - (left.end - left.start) ||
      left.start - right.start ||
      compareBrowserStrings(left.sourceId, right.sourceId) ||
      compareBrowserStrings(left.category, right.category),
  );
  const accepted: Candidate[] = [];
  for (const candidate of precedence) {
    if (!accepted.some((existing) => overlaps(candidate, existing))) {
      accepted.push(candidate);
    }
  }
  return accepted.sort(
    (left, right) =>
      left.start - right.start ||
      compareBrowserStrings(left.sourceId, right.sourceId),
  );
}

export async function redactWithCascade(
  input: string,
  policy: RedactionCascadePolicy,
  options: { readonly signal?: AbortSignal } = {},
): Promise<RedactionCascadeResult> {
  const policySnapshot = snapshotPolicy(policy);
  const signal = options.signal;
  if (input.length > policySnapshot.maxInputCodeUnits) {
    throw new RedactionCascadeError('input_limit_exceeded');
  }
  if (isAborted(signal)) {
    throw new RedactionCascadeError('aborted');
  }

  const candidates = ruleCandidates(input, policySnapshot);
  await classifierCandidates(input, policySnapshot, signal, candidates);
  if (isAborted(signal)) {
    throw new RedactionCascadeError('aborted');
  }

  const selected = resolveCandidates(candidates);
  let cursor = 0;
  let output = '';
  for (const candidate of selected) {
    output += input.slice(cursor, candidate.start);
    output += candidate.replacement;
    cursor = candidate.end;
  }
  output += input.slice(cursor);

  const result = Object.freeze({
    output,
    redactions: Object.freeze(
      selected.map(({ replacement: _replacement, ...redaction }) =>
        Object.freeze(redaction),
      ),
    ),
    policyId: policySnapshot.policyId,
    policyDigest: policySnapshot.policyDigest,
  });
  redactionResultSources.set(result, evaluatedSourceIds(policySnapshot));
  return result;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

/**
 * Re-runs the complete policy against the sanitized output. Receipt issuance
 * accepts only the unforgeable handle returned here. Run this function inside
 * the same killable Dedicated Worker as the cascade; the host protocol
 * terminates the worker on timeout so a pathological operator regex cannot
 * block the application thread.
 */
export async function verifyRedactedOutput(
  output: string,
  policy: RedactionCascadePolicy,
  options: { readonly signal?: AbortSignal } = {},
): Promise<VerifiedRedactedOutput> {
  const policySnapshot = snapshotPolicy(policy);
  const signal = options.signal;
  if (output.length > policySnapshot.maxInputCodeUnits) {
    throw new RedactionCascadeError('input_limit_exceeded');
  }
  if (isAborted(signal)) {
    throw new RedactionCascadeError('aborted');
  }

  const candidates = ruleCandidates(output, policySnapshot);
  await classifierCandidates(output, policySnapshot, signal, candidates);
  if (isAborted(signal)) {
    throw new RedactionCascadeError('aborted');
  }
  if (resolveCandidates(candidates).length !== 0) {
    throw new RedactionCascadeError('invalid_policy');
  }

  const sources = evaluatedSourceIds(policySnapshot);
  const verification = Object.freeze({
    policyId: policySnapshot.policyId,
    policyDigest: policySnapshot.policyDigest,
    outputDigest: await sha256Text(output),
    evaluatedRuleIds: sources.ruleIds,
    evaluatedClassifierIds: sources.classifierIds,
  });
  verifiedOutputs.add(verification);
  return verification;
}

/**
 * Verifies the exact output of one branded cascade result and binds the
 * resulting proof to that same execution. Receipt issuance accepts only this
 * paired evidence, so applied-redaction metadata cannot be substituted.
 */
export async function verifyRedactionResult(
  result: RedactionCascadeResult,
  policy: RedactionCascadePolicy,
  options: { readonly signal?: AbortSignal } = {},
): Promise<VerifiedRedactedOutput> {
  const resultSources = redactionResultSources.get(result);
  if (resultSources === undefined) {
    throw new RedactionCascadeError('invalid_redaction_result');
  }
  const verification = await verifyRedactedOutput(
    result.output,
    policy,
    options,
  );
  if (
    result.policyId !== verification.policyId ||
    result.policyDigest !== verification.policyDigest ||
    !sameSourceIds(resultSources.ruleIds, verification.evaluatedRuleIds) ||
    !sameSourceIds(
      resultSources.classifierIds,
      verification.evaluatedClassifierIds,
    )
  ) {
    throw new RedactionCascadeError('invalid_redaction_result');
  }
  verifiedRedactionOrigins.set(verification, result);
  return verification;
}

export function isVerifiedRedactionEvidence(
  verification: VerifiedRedactedOutput,
  result: RedactionCascadeResult,
): boolean {
  return (
    typeof verification === 'object' &&
    verification !== null &&
    typeof result === 'object' &&
    result !== null &&
    redactionResultSources.has(result) &&
    verifiedRedactionOrigins.get(verification) === result
  );
}

export function isVerifiedRedactedOutput(
  value: VerifiedRedactedOutput,
): boolean {
  return verifiedOutputs.has(value);
}
