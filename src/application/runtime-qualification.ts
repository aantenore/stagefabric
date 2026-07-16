import { z } from 'zod';

import { compareCodePointStrings } from '../domain/canonical.js';
import {
  runtimeTargetBindingSchema,
  verifyRuntimeBindingsDigest,
  type RuntimeOperationBinding,
  type RuntimeTargetBinding,
} from '../domain/runtime-bindings.js';
import {
  computeRuntimeQualificationProfileDigest,
  RUNTIME_QUALIFICATION_PRODUCER,
  RUNTIME_QUALIFICATION_SCOPE,
  runtimeQualifierArtifactSchema,
  runtimeQualificationReasonCodeSchema,
  runtimeQualificationRequestSchema,
  sealRuntimeQualificationReport,
  type RuntimeQualificationReasonCode,
  type RuntimeQualificationReport,
  type RuntimeQualificationResult,
  type RuntimeQualifierArtifact,
} from '../domain/runtime-qualification.js';
import type {
  RuntimeOperationQualification,
  RuntimeOperationQualifier,
  RuntimeQualificationCredentialResolver,
} from '../ports/runtime-operation-qualifier.js';

export type RuntimeQualificationErrorCode =
  | 'binding_digest_mismatch'
  | 'qualification_budget_exceeded'
  | 'qualification_failed'
  | 'qualifier_registry_invalid'
  | 'request_invalid'
  | 'selection_invalid';

/** Content-free gate/configuration error. */
export class RuntimeQualificationError extends Error {
  readonly code: RuntimeQualificationErrorCode;

  constructor(code: RuntimeQualificationErrorCode) {
    super(code);
    this.name = 'RuntimeQualificationError';
    this.code = code;
  }
}

export interface QualifyRuntimeOperationsOptions {
  readonly qualifiers: readonly RuntimeOperationQualifier[];
  readonly resolveCredential?: RuntimeQualificationCredentialResolver;
}

export const MAX_RUNTIME_QUALIFICATION_CREDENTIAL_BYTES = 16 * 1_024;
export const MAX_RUNTIME_OPERATION_QUALIFIERS = 64;

interface SelectedOperationEvidence {
  readonly operation: string;
  readonly operationKind: RuntimeOperationBinding['kind'];
  readonly maxOutputTokens: number | undefined;
}

interface SelectedOperation {
  readonly evidence: SelectedOperationEvidence;
  readonly qualifierOperation: RuntimeOperationBinding;
}

interface SelectedTarget {
  /** Private primitives used after async extension code returns. */
  readonly evidence: {
    readonly targetId: string;
    readonly providerKind: string;
    readonly providerName: string;
    readonly credentialReference: string | undefined;
  };
  /** Separate recursively frozen values exposed to the qualifier port. */
  readonly qualifierTarget: RuntimeTargetBinding;
  readonly operations: readonly SelectedOperation[];
}

interface RegisteredQualifier {
  readonly artifact: RuntimeQualifierArtifact;
  readonly qualify: RuntimeOperationQualifier['qualify'];
}

const qualifierOutputSchema = z
  .object({
    operation: z.string().min(1).max(128),
    operationKind: z.enum(['generate-text', 'embedding']),
    status: z.enum(['qualified', 'rejected']),
    reasonCode: runtimeQualificationReasonCodeSchema,
  })
  .strict()
  .superRefine((result, context) => {
    const consistent =
      (result.status === 'qualified' && result.reasonCode === 'qualified') ||
      (result.status === 'rejected' && result.reasonCode !== 'qualified');
    if (!consistent) {
      context.addIssue({
        code: 'custom',
        message: 'inconsistent qualifier output',
        path: ['reasonCode'],
      });
    }
  });

const qualifierOutputsSchema = z.array(qualifierOutputSchema);
const DEADLINE = Symbol('runtime_qualification_deadline');
const CREDENTIAL_UNAVAILABLE = Symbol(
  'runtime_qualification_credential_unavailable',
);

function rejectedResults(
  selected: SelectedTarget,
  reasonCode: Exclude<RuntimeQualificationReasonCode, 'qualified'>,
  qualifier: RuntimeQualifierArtifact | null,
  operations: readonly SelectedOperation[] = selected.operations,
): readonly RuntimeQualificationResult[] {
  return operations.map(({ evidence }) => ({
    targetId: selected.evidence.targetId,
    operation: evidence.operation,
    operationKind: evidence.operationKind,
    status: 'rejected',
    reasonCode,
    qualifier: qualifier === null ? null : { ...qualifier },
  }));
}

function qualifierRegistry(
  options: QualifyRuntimeOperationsOptions,
): ReadonlyMap<string, RegisteredQualifier> {
  try {
    const qualifiers = options.qualifiers;
    if (!Array.isArray(qualifiers)) throw new TypeError('invalid_registry');
    const qualifierCount = qualifiers.length;
    if (
      !Number.isSafeInteger(qualifierCount) ||
      qualifierCount < 0 ||
      qualifierCount > MAX_RUNTIME_OPERATION_QUALIFIERS
    ) {
      throw new TypeError('invalid_registry');
    }

    const registry = new Map<string, RegisteredQualifier>();
    for (let index = 0; index < qualifierCount; index += 1) {
      const qualifier = qualifiers[index];
      if (qualifier === undefined || qualifier === null) {
        throw new TypeError('invalid_qualifier');
      }
      const artifact = runtimeQualifierArtifactSchema.safeParse({
        kind: qualifier.kind,
        version: qualifier.version,
      });
      const method = qualifier.qualify;
      if (
        !artifact.success ||
        typeof method !== 'function' ||
        registry.has(artifact.data.kind)
      ) {
        throw new TypeError('invalid_qualifier');
      }
      registry.set(artifact.data.kind, {
        artifact: artifact.data,
        qualify: (request) =>
          Promise.resolve(
            Reflect.apply(method, qualifier, [request]) as Awaited<
              ReturnType<RuntimeOperationQualifier['qualify']>
            >,
          ),
      });
    }
    return registry;
  } catch {
    throw new RuntimeQualificationError('qualifier_registry_invalid');
  }
}

function credentialResolver(
  options: QualifyRuntimeOperationsOptions,
): RuntimeQualificationCredentialResolver | undefined {
  try {
    const resolver = options.resolveCredential;
    return typeof resolver === 'function' ? resolver : undefined;
  } catch {
    return undefined;
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

function selectedTargets(
  request: z.infer<typeof runtimeQualificationRequestSchema>,
): readonly SelectedTarget[] {
  const targetsById = new Map(
    request.bindings.targets.map((target) => [target.targetId, target]),
  );
  let operationCount = 0;
  const selected = request.profile.targets.map((selection) => {
    const target = targetsById.get(selection.targetId);
    if (target === undefined) {
      throw new RuntimeQualificationError('selection_invalid');
    }
    const qualifierTarget = deepFreeze(
      runtimeTargetBindingSchema.parse(target),
    );
    const operationsById = new Map(
      qualifierTarget.operations.map((operation) => [
        operation.operation,
        operation,
      ]),
    );
    const operations = selection.operations.map((operationName) => {
      const qualifierOperation = operationsById.get(operationName);
      if (qualifierOperation === undefined) {
        throw new RuntimeQualificationError('selection_invalid');
      }
      return Object.freeze({
        evidence: Object.freeze({
          operation: qualifierOperation.operation,
          operationKind: qualifierOperation.kind,
          maxOutputTokens:
            qualifierOperation.kind === 'generate-text'
              ? qualifierOperation.maxOutputTokens
              : undefined,
        }),
        qualifierOperation,
      });
    });
    operationCount += operations.length;
    return Object.freeze({
      evidence: Object.freeze({
        targetId: qualifierTarget.targetId,
        providerKind: qualifierTarget.provider.kind,
        providerName: qualifierTarget.provider.name,
        credentialReference: qualifierTarget.provider.apiKeyEnv,
      }),
      qualifierTarget,
      operations: Object.freeze(
        [...operations].sort((left, right) =>
          compareCodePointStrings(
            left.evidence.operation,
            right.evidence.operation,
          ),
        ),
      ),
    });
  });

  if (
    selected.length > request.profile.limits.maxTargets ||
    operationCount > request.profile.limits.maxOperations
  ) {
    throw new RuntimeQualificationError('qualification_budget_exceeded');
  }

  return selected.sort((left, right) =>
    compareCodePointStrings(left.evidence.targetId, right.evidence.targetId),
  );
}

function raceWithDeadline<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(DEADLINE);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(DEADLINE);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function validatedQualifierResults(
  selected: SelectedTarget,
  operations: readonly SelectedOperation[],
  output: readonly RuntimeOperationQualification[],
  qualifier: RuntimeQualifierArtifact,
): readonly RuntimeQualificationResult[] | undefined {
  const parsed = qualifierOutputsSchema.safeParse(output);
  if (!parsed.success || parsed.data.length !== operations.length) {
    return undefined;
  }

  const outputByOperation = new Map<
    string,
    z.infer<typeof qualifierOutputSchema>
  >();
  for (const result of parsed.data) {
    if (outputByOperation.has(result.operation)) return undefined;
    outputByOperation.set(result.operation, result);
  }

  const normalized: RuntimeQualificationResult[] = [];
  for (const { evidence } of operations) {
    const result = outputByOperation.get(evidence.operation);
    if (
      result === undefined ||
      result.operationKind !== evidence.operationKind
    ) {
      return undefined;
    }
    normalized.push({
      targetId: selected.evidence.targetId,
      ...result,
      qualifier: { ...qualifier },
    });
  }
  return normalized;
}

async function resolvedCredential(
  selected: SelectedTarget,
  resolver: RuntimeQualificationCredentialResolver | undefined,
  signal: AbortSignal,
): Promise<string | undefined | typeof CREDENTIAL_UNAVAILABLE> {
  const reference = selected.evidence.credentialReference;
  if (reference === undefined) return undefined;
  if (resolver === undefined) return CREDENTIAL_UNAVAILABLE;

  try {
    const credential: unknown = await raceWithDeadline(
      Promise.resolve().then(() =>
        resolver({
          targetId: selected.evidence.targetId,
          providerKind: selected.evidence.providerKind,
          providerName: selected.evidence.providerName,
          reference,
          signal,
        }),
      ),
      signal,
    );
    return typeof credential === 'string' &&
      credential.length > 0 &&
      credential.length <= MAX_RUNTIME_QUALIFICATION_CREDENTIAL_BYTES &&
      !credential.includes('\r') &&
      !credential.includes('\n') &&
      credential.trim() !== '' &&
      new TextEncoder().encode(credential).byteLength <=
        MAX_RUNTIME_QUALIFICATION_CREDENTIAL_BYTES
      ? credential
      : CREDENTIAL_UNAVAILABLE;
  } catch (error) {
    if (error === DEADLINE) throw error;
    return CREDENTIAL_UNAVAILABLE;
  }
}

async function qualifySelectedTarget(
  selected: SelectedTarget,
  registry: ReadonlyMap<string, RegisteredQualifier>,
  policy: z.infer<
    typeof runtimeQualificationRequestSchema
  >['bindings']['policy'],
  maxGenerationOutputTokensPerCall: number,
  resolver: RuntimeQualificationCredentialResolver | undefined,
  signal: AbortSignal,
): Promise<readonly RuntimeQualificationResult[]> {
  const qualifier = registry.get(selected.evidence.providerKind);
  if (qualifier === undefined) {
    return rejectedResults(selected, 'qualifier_unavailable', null);
  }

  const admitted: SelectedOperation[] = [];
  const configurationUnqualified: SelectedOperation[] = [];
  for (const operation of selected.operations) {
    const evidence = operation.evidence;
    if (
      evidence.operationKind === 'generate-text' &&
      (evidence.maxOutputTokens === undefined ||
        evidence.maxOutputTokens > maxGenerationOutputTokensPerCall)
    ) {
      configurationUnqualified.push(operation);
    } else {
      admitted.push(operation);
    }
  }
  const preflightResults = rejectedResults(
    selected,
    'operation_configuration_unqualified',
    qualifier.artifact,
    configurationUnqualified,
  );
  if (admitted.length === 0) return preflightResults;

  try {
    const credential = await resolvedCredential(selected, resolver, signal);
    if (credential === CREDENTIAL_UNAVAILABLE) {
      return [
        ...preflightResults,
        ...rejectedResults(
          selected,
          'credential_unavailable',
          qualifier.artifact,
          admitted,
        ),
      ];
    }
    const qualifierOperations = Object.freeze(
      admitted.map((operation) => operation.qualifierOperation),
    );
    const qualifierTarget = deepFreeze(
      runtimeTargetBindingSchema.parse({
        ...selected.qualifierTarget,
        operations: qualifierOperations,
      }),
    );
    const output = await raceWithDeadline(
      qualifier.qualify({
        target: qualifierTarget,
        operations: qualifierOperations,
        policy: {
          requestTimeoutMs: policy.requestTimeoutMs,
          maxResponseBytes: policy.maxResponseBytes,
          maxGenerationOutputTokensPerCall,
        },
        ...(credential === undefined ? {} : { credential }),
        signal,
      }),
      signal,
    );
    return [
      ...preflightResults,
      ...(validatedQualifierResults(
        selected,
        admitted,
        output,
        qualifier.artifact,
      ) ??
        rejectedResults(
          selected,
          'qualifier_failure',
          qualifier.artifact,
          admitted,
        )),
    ];
  } catch (error) {
    return [
      ...preflightResults,
      ...rejectedResults(
        selected,
        error === DEADLINE ? 'deadline_exceeded' : 'qualifier_failure',
        qualifier.artifact,
        admitted,
      ),
    ];
  }
}

/**
 * Runs an explicit, bounded qualification selection. Results are sorted and
 * sealed after provider-specific detail has been reduced to stable reason
 * codes. The report is evidence only and is never consumed by the planner.
 */
export async function qualifyRuntimeOperations(
  input: unknown,
  options: QualifyRuntimeOperationsOptions,
): Promise<RuntimeQualificationReport> {
  const parsed = runtimeQualificationRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new RuntimeQualificationError('request_invalid');
  }
  const request = parsed.data;
  if (!verifyRuntimeBindingsDigest(request.bindings)) {
    throw new RuntimeQualificationError('binding_digest_mismatch');
  }

  const registry = qualifierRegistry(options);
  const resolver = credentialResolver(options);
  const selected = selectedTargets(request);
  const resultsByTarget = Array.from<
    readonly RuntimeQualificationResult[] | undefined
  >({ length: selected.length });
  const deadline = new AbortController();
  const timeout = setTimeout(
    () => deadline.abort(),
    request.profile.limits.totalTimeoutMs,
  );
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (!deadline.signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      const target = selected[index];
      if (target === undefined) return;
      resultsByTarget[index] = await qualifySelectedTarget(
        target,
        registry,
        request.bindings.policy,
        request.profile.limits.maxGenerationOutputTokensPerCall,
        resolver,
        deadline.signal,
      );
    }
  };

  try {
    const workerCount = Math.min(
      selected.length,
      request.profile.limits.maxConcurrency,
    );
    await Promise.all(Array.from({ length: workerCount }, worker));
  } finally {
    clearTimeout(timeout);
    deadline.abort();
  }

  const results = selected.flatMap((target, index) => {
    const qualifier = registry.get(target.evidence.providerKind);
    return (
      resultsByTarget[index] ??
      (qualifier === undefined
        ? rejectedResults(target, 'qualifier_unavailable', null)
        : rejectedResults(target, 'deadline_exceeded', qualifier.artifact))
    );
  });
  return sealRuntimeQualificationReport({
    apiVersion: request.profile.apiVersion,
    kind: 'RuntimeQualificationReport',
    bindingDigest: request.bindings.digest,
    profileDigest: computeRuntimeQualificationProfileDigest(request.profile),
    qualificationScope: RUNTIME_QUALIFICATION_SCOPE,
    producer: { ...RUNTIME_QUALIFICATION_PRODUCER },
    qualified: results.every((result) => result.status === 'qualified'),
    results,
  });
}
