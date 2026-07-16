import { z } from 'zod';

import { compareCodePointStrings, sha256Digest } from './canonical.js';
import { runtimeBindingsSchema } from './runtime-bindings.js';
import { sha256DigestSchema, STAGEFABRIC_API_VERSION } from './schema.js';

export const RUNTIME_QUALIFICATION_LIMITS = {
  totalTimeoutMs: { min: 100, max: 600_000 },
  maxConcurrency: { min: 1, max: 16 },
  maxTargets: { min: 1, max: 256 },
  maxOperations: { min: 1, max: 1_024 },
  maxGenerationOutputTokensPerCall: { min: 1, max: 4_096 },
} as const;

export const RUNTIME_QUALIFICATION_SCOPE = 'configured-wire-shape-v1' as const;

export const RUNTIME_QUALIFICATION_PRODUCER = Object.freeze({
  id: 'stagefabric-runtime-qualification',
  version: '1',
} as const);

const targetIdentifierSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    'must be a safe target identifier',
  );

const operationIdentifierSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/,
    'must be a safe operation identifier',
  );

function requireUniqueStrings(
  values: readonly string[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: 'custom',
        message: 'duplicate operation selection',
        path: [index],
      });
    }
    seen.add(value);
  }
}

export const runtimeQualificationTargetSelectionSchema = z
  .object({
    targetId: targetIdentifierSchema,
    operations: z
      .array(operationIdentifierSchema)
      .min(1)
      .max(RUNTIME_QUALIFICATION_LIMITS.maxOperations.max)
      .superRefine(requireUniqueStrings),
  })
  .strict();

export const runtimeQualificationProfileSchema = z
  .object({
    apiVersion: z.literal(STAGEFABRIC_API_VERSION),
    kind: z.literal('RuntimeQualificationProfile'),
    limits: z
      .object({
        totalTimeoutMs: z
          .number()
          .int()
          .min(RUNTIME_QUALIFICATION_LIMITS.totalTimeoutMs.min)
          .max(RUNTIME_QUALIFICATION_LIMITS.totalTimeoutMs.max),
        maxConcurrency: z
          .number()
          .int()
          .min(RUNTIME_QUALIFICATION_LIMITS.maxConcurrency.min)
          .max(RUNTIME_QUALIFICATION_LIMITS.maxConcurrency.max),
        maxTargets: z
          .number()
          .int()
          .min(RUNTIME_QUALIFICATION_LIMITS.maxTargets.min)
          .max(RUNTIME_QUALIFICATION_LIMITS.maxTargets.max),
        maxOperations: z
          .number()
          .int()
          .min(RUNTIME_QUALIFICATION_LIMITS.maxOperations.min)
          .max(RUNTIME_QUALIFICATION_LIMITS.maxOperations.max),
        maxGenerationOutputTokensPerCall: z
          .number()
          .int()
          .min(
            RUNTIME_QUALIFICATION_LIMITS.maxGenerationOutputTokensPerCall.min,
          )
          .max(
            RUNTIME_QUALIFICATION_LIMITS.maxGenerationOutputTokensPerCall.max,
          ),
      })
      .strict(),
    targets: z
      .array(runtimeQualificationTargetSelectionSchema)
      .min(1)
      .max(RUNTIME_QUALIFICATION_LIMITS.maxTargets.max),
  })
  .strict()
  .superRefine((profile, context) => {
    const seen = new Set<string>();
    for (const [index, target] of profile.targets.entries()) {
      if (seen.has(target.targetId)) {
        context.addIssue({
          code: 'custom',
          message: 'duplicate target selection',
          path: ['targets', index, 'targetId'],
        });
      }
      seen.add(target.targetId);
    }
  });

export const runtimeQualificationRequestSchema = z
  .object({
    bindings: runtimeBindingsSchema,
    profile: runtimeQualificationProfileSchema,
  })
  .strict();

export const runtimeQualificationReasonCodeSchema = z.enum([
  'qualified',
  'credential_unavailable',
  'deadline_exceeded',
  'model_unavailable',
  'network_failure',
  'operation_configuration_unqualified',
  'operation_output_invalid',
  'operation_rejected',
  'provider_rejected',
  'qualifier_failure',
  'qualifier_unavailable',
  'request_rejected',
  'request_timeout',
  'response_invalid',
  'response_too_large',
  'upstream_redirect',
]);

const qualifierKindSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'must be a safe qualifier kind');

export const runtimeQualifierVersionSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/,
    'must be a safe qualifier version',
  );

export const runtimeQualifierArtifactSchema = z
  .object({
    kind: qualifierKindSchema,
    version: runtimeQualifierVersionSchema,
  })
  .strict();

export const runtimeQualificationProducerSchema = z
  .object({
    id: z.literal(RUNTIME_QUALIFICATION_PRODUCER.id),
    version: z.literal(RUNTIME_QUALIFICATION_PRODUCER.version),
  })
  .strict();

export const runtimeQualificationResultSchema = z
  .object({
    targetId: targetIdentifierSchema,
    operation: operationIdentifierSchema,
    operationKind: z.enum(['generate-text', 'embedding']),
    status: z.enum(['qualified', 'rejected']),
    reasonCode: runtimeQualificationReasonCodeSchema,
    qualifier: runtimeQualifierArtifactSchema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    const consistent =
      (result.status === 'qualified' && result.reasonCode === 'qualified') ||
      (result.status === 'rejected' && result.reasonCode !== 'qualified');
    if (!consistent) {
      context.addIssue({
        code: 'custom',
        message: 'status and reasonCode must agree',
        path: ['reasonCode'],
      });
    }
    const qualifierUnavailable = result.reasonCode === 'qualifier_unavailable';
    if ((result.qualifier === null) !== qualifierUnavailable) {
      context.addIssue({
        code: 'custom',
        message: 'qualifier artifact must identify the selected qualifier',
        path: ['qualifier'],
      });
    }
  });

const runtimeQualificationReportContentShape = {
  apiVersion: z.literal(STAGEFABRIC_API_VERSION),
  kind: z.literal('RuntimeQualificationReport'),
  bindingDigest: sha256DigestSchema,
  profileDigest: sha256DigestSchema,
  qualificationScope: z.literal(RUNTIME_QUALIFICATION_SCOPE),
  producer: runtimeQualificationProducerSchema,
  qualified: z.boolean(),
  results: z.array(runtimeQualificationResultSchema).min(1),
} as const;

function validateReport(
  report: {
    qualified: boolean;
    results: readonly {
      targetId: string;
      operation: string;
      status: 'qualified' | 'rejected';
    }[];
  },
  context: z.RefinementCtx,
): void {
  const allQualified = report.results.every(
    (result) => result.status === 'qualified',
  );
  if (report.qualified !== allQualified) {
    context.addIssue({
      code: 'custom',
      message: 'qualified must reflect every result',
      path: ['qualified'],
    });
  }

  const seen = new Set<string>();
  for (const [index, result] of report.results.entries()) {
    const key = `${result.targetId.length}:${result.targetId}${result.operation}`;
    if (seen.has(key)) {
      context.addIssue({
        code: 'custom',
        message: 'duplicate qualification result',
        path: ['results', index],
      });
    }
    seen.add(key);
  }
}

export const runtimeQualificationReportContentSchema = z
  .object(runtimeQualificationReportContentShape)
  .strict()
  .superRefine(validateReport);

export const runtimeQualificationReportSchema = z
  .object({
    ...runtimeQualificationReportContentShape,
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine(validateReport);

export type RuntimeQualificationTargetSelection = z.infer<
  typeof runtimeQualificationTargetSelectionSchema
>;
export type RuntimeQualificationProfile = z.infer<
  typeof runtimeQualificationProfileSchema
>;
export type RuntimeQualificationRequest = z.infer<
  typeof runtimeQualificationRequestSchema
>;
export type RuntimeQualificationReasonCode = z.infer<
  typeof runtimeQualificationReasonCodeSchema
>;
export type RuntimeQualifierArtifact = z.infer<
  typeof runtimeQualifierArtifactSchema
>;
export type RuntimeQualificationProducer = z.infer<
  typeof runtimeQualificationProducerSchema
>;
export type RuntimeQualificationResult = z.infer<
  typeof runtimeQualificationResultSchema
>;
export type RuntimeQualificationReportContent = z.infer<
  typeof runtimeQualificationReportContentSchema
>;
export type RuntimeQualificationReport = z.infer<
  typeof runtimeQualificationReportSchema
>;

function normalizedProfile(
  profile: RuntimeQualificationProfile,
): RuntimeQualificationProfile {
  return {
    apiVersion: profile.apiVersion,
    kind: profile.kind,
    limits: {
      totalTimeoutMs: profile.limits.totalTimeoutMs,
      maxConcurrency: profile.limits.maxConcurrency,
      maxTargets: profile.limits.maxTargets,
      maxOperations: profile.limits.maxOperations,
      maxGenerationOutputTokensPerCall:
        profile.limits.maxGenerationOutputTokensPerCall,
    },
    targets: [...profile.targets]
      .map((target) => ({
        targetId: target.targetId,
        operations: [...target.operations].sort(compareCodePointStrings),
      }))
      .sort((left, right) =>
        compareCodePointStrings(left.targetId, right.targetId),
      ),
  };
}

function normalizedResults(
  results: readonly RuntimeQualificationResult[],
): readonly RuntimeQualificationResult[] {
  return [...results].sort((left, right) => {
    const targetOrder = compareCodePointStrings(left.targetId, right.targetId);
    return targetOrder === 0
      ? compareCodePointStrings(left.operation, right.operation)
      : targetOrder;
  });
}

export function computeRuntimeQualificationProfileDigest(
  input: unknown,
): `sha256:${string}` {
  const profile = runtimeQualificationProfileSchema.parse(input);
  return sha256Digest(normalizedProfile(profile));
}

export function computeRuntimeQualificationReportDigest(
  input: unknown,
): `sha256:${string}` {
  const report = runtimeQualificationReportContentSchema.parse(input);
  return sha256Digest({
    ...report,
    results: normalizedResults(report.results),
  });
}

export function sealRuntimeQualificationReport(
  input: unknown,
): RuntimeQualificationReport {
  const report = runtimeQualificationReportContentSchema.parse(input);
  const normalized = { ...report, results: normalizedResults(report.results) };
  return runtimeQualificationReportSchema.parse({
    ...normalized,
    digest: computeRuntimeQualificationReportDigest(normalized),
  });
}

export function verifyRuntimeQualificationReportDigest(
  report: RuntimeQualificationReport,
): boolean {
  const { digest, ...content } = report;
  return digest === computeRuntimeQualificationReportDigest(content);
}
