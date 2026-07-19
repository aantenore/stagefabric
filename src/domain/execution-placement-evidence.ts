import { z } from 'zod';

import { sha256Digest } from './canonical.js';
import {
  sha256DigestSchema,
  STAGEFABRIC_API_VERSION,
  timestampSchema,
} from './schema.js';

export const EXECUTION_PLACEMENT_EVIDENCE_MEDIA_TYPE =
  'application/vnd.stagefabric.execution-placement-evidence+json' as const;

export const EXECUTION_PLACEMENT_EVIDENCE_LIMITS = Object.freeze({
  maxRunIdCharacters: 1_024,
  maxPlacements: 1_024,
  maxAttemptsPerStage: 33,
  maxTraceEvents: 33_792,
} as const);

export const executionPlacementEvidenceRunIdSchema = z
  .string()
  .min(1)
  .max(EXECUTION_PLACEMENT_EVIDENCE_LIMITS.maxRunIdCharacters);

export const executionPlacementEvidenceReasonCodeSchema = z.enum([
  'completed',
  'retryable_pre_output_status',
  'adapter_not_registered',
  'adapter_failed',
  'invalid_outputs',
  'input_policy_rejected',
  'output_policy_rejected',
]);

const digestedPlacementShape = {
  stageIdDigest: sha256DigestSchema,
  targetIdDigest: sha256DigestSchema,
  zoneDigest: sha256DigestSchema,
  adapterKindDigest: sha256DigestSchema,
  attempt: z
    .number()
    .int()
    .min(1)
    .max(EXECUTION_PLACEMENT_EVIDENCE_LIMITS.maxAttemptsPerStage),
} as const;

export const executionPlacementEvidencePlacementSchema = z
  .object({
    ...digestedPlacementShape,
    status: z.literal('succeeded'),
    reasonCode: z.literal('completed'),
  })
  .strict();

export const executionPlacementEvidenceTraceEventSchema = z
  .object({
    ...digestedPlacementShape,
    status: z.enum(['succeeded', 'failed']),
    reasonCode: executionPlacementEvidenceReasonCodeSchema,
    statusCode: z.number().int().min(100).max(599).optional(),
  })
  .strict()
  .superRefine((event, context) => {
    const completed = event.reasonCode === 'completed';
    if ((event.status === 'succeeded') !== completed) {
      context.addIssue({
        code: 'custom',
        message: 'status and reasonCode must agree',
        path: ['reasonCode'],
      });
    }
    const retryable = event.reasonCode === 'retryable_pre_output_status';
    if ((event.statusCode !== undefined) !== retryable) {
      context.addIssue({
        code: 'custom',
        message: 'statusCode is required only for retryable pre-output status',
        path: ['statusCode'],
      });
    }
  });

const executionPlacementEvidenceContentShape = {
  apiVersion: z.literal(STAGEFABRIC_API_VERSION),
  kind: z.literal('ExecutionPlacementEvidence'),
  producer: z.literal('stagefabric'),
  disclosure: z.literal('content-free'),
  authority: z.literal('observation-only'),
  runIdDigest: sha256DigestSchema,
  observedAt: timestampSchema,
  planDigest: sha256DigestSchema,
  bindingDigest: sha256DigestSchema,
  snapshotDigest: sha256DigestSchema,
  egressDigest: sha256DigestSchema,
  placements: z
    .array(executionPlacementEvidencePlacementSchema)
    .min(1)
    .max(EXECUTION_PLACEMENT_EVIDENCE_LIMITS.maxPlacements),
  trace: z
    .array(executionPlacementEvidenceTraceEventSchema)
    .min(1)
    .max(EXECUTION_PLACEMENT_EVIDENCE_LIMITS.maxTraceEvents),
} as const;

type PlacementSummary = z.infer<
  typeof executionPlacementEvidencePlacementSchema
>;
type TraceSummary = z.infer<typeof executionPlacementEvidenceTraceEventSchema>;

function placementKey(
  value: Pick<
    PlacementSummary | TraceSummary,
    | 'stageIdDigest'
    | 'targetIdDigest'
    | 'zoneDigest'
    | 'adapterKindDigest'
    | 'attempt'
  >,
): string {
  return [
    value.stageIdDigest,
    value.targetIdDigest,
    value.zoneDigest,
    value.adapterKindDigest,
    String(value.attempt),
  ].join('\u0000');
}

function validateEvidenceContent(
  evidence: {
    readonly placements: readonly PlacementSummary[];
    readonly trace: readonly TraceSummary[];
  },
  context: z.RefinementCtx,
): void {
  const placementStages = new Set<string>();
  const placementIndexByStage = new Map<string, number>();
  const placementKeys = new Set<string>();
  for (const [index, placement] of evidence.placements.entries()) {
    if (placementStages.has(placement.stageIdDigest)) {
      context.addIssue({
        code: 'custom',
        message: 'each stage must have exactly one selected placement',
        path: ['placements', index, 'stageIdDigest'],
      });
    }
    placementStages.add(placement.stageIdDigest);
    placementIndexByStage.set(placement.stageIdDigest, index);
    placementKeys.add(placementKey(placement));
  }

  const nextAttemptByStage = new Map<string, number>();
  const successfulPlacements = new Set<string>();
  const completedStages = new Set<string>();
  let currentPlacementIndex = 0;
  for (const [index, event] of evidence.trace.entries()) {
    const placementIndex = placementIndexByStage.get(event.stageIdDigest);
    if (placementIndex === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'trace event must identify a selected stage',
        path: ['trace', index, 'stageIdDigest'],
      });
    } else if (placementIndex !== currentPlacementIndex) {
      context.addIssue({
        code: 'custom',
        message: 'trace stage order must match selected placement order',
        path: ['trace', index, 'stageIdDigest'],
      });
    }
    if (completedStages.has(event.stageIdDigest)) {
      context.addIssue({
        code: 'custom',
        message: 'trace cannot continue after a stage completes',
        path: ['trace', index, 'stageIdDigest'],
      });
    }
    const expectedAttempt = nextAttemptByStage.get(event.stageIdDigest) ?? 1;
    if (event.attempt !== expectedAttempt) {
      context.addIssue({
        code: 'custom',
        message: 'trace attempts must be contiguous per stage',
        path: ['trace', index, 'attempt'],
      });
    }
    nextAttemptByStage.set(event.stageIdDigest, expectedAttempt + 1);

    if (event.status === 'succeeded') {
      const key = placementKey(event);
      if (!placementKeys.has(key)) {
        context.addIssue({
          code: 'custom',
          message: 'successful trace event must identify a selected placement',
          path: ['trace', index],
        });
      }
      if (successfulPlacements.has(key)) {
        context.addIssue({
          code: 'custom',
          message: 'selected placement may complete only once',
          path: ['trace', index],
        });
      }
      successfulPlacements.add(key);
      completedStages.add(event.stageIdDigest);
      currentPlacementIndex += 1;
    }
  }

  for (const [index, placement] of evidence.placements.entries()) {
    if (!successfulPlacements.has(placementKey(placement))) {
      context.addIssue({
        code: 'custom',
        message: 'selected placement requires one completed trace event',
        path: ['placements', index],
      });
    }
  }
}

export const executionPlacementEvidenceContentSchema = z
  .object(executionPlacementEvidenceContentShape)
  .strict()
  .superRefine(validateEvidenceContent);

export const executionPlacementEvidenceSchema = z
  .object({
    ...executionPlacementEvidenceContentShape,
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine(validateEvidenceContent);

export type ExecutionPlacementEvidenceReasonCode = z.infer<
  typeof executionPlacementEvidenceReasonCodeSchema
>;
export type ExecutionPlacementEvidencePlacement = z.infer<
  typeof executionPlacementEvidencePlacementSchema
>;
export type ExecutionPlacementEvidenceTraceEvent = z.infer<
  typeof executionPlacementEvidenceTraceEventSchema
>;
export type ExecutionPlacementEvidenceContent = z.infer<
  typeof executionPlacementEvidenceContentSchema
>;
export type ExecutionPlacementEvidence = z.infer<
  typeof executionPlacementEvidenceSchema
>;

export class ExecutionPlacementEvidenceError extends Error {
  readonly code = 'execution_evidence_digest_mismatch' as const;

  constructor() {
    super('execution_evidence_digest_mismatch');
    this.name = 'ExecutionPlacementEvidenceError';
  }
}

export function computeExecutionPlacementEvidenceDigest(
  input: unknown,
): `sha256:${string}` {
  return sha256Digest(executionPlacementEvidenceContentSchema.parse(input));
}

export function sealExecutionPlacementEvidence(
  input: unknown,
): ExecutionPlacementEvidence {
  const content = executionPlacementEvidenceContentSchema.parse(input);
  return executionPlacementEvidenceSchema.parse({
    ...content,
    digest: computeExecutionPlacementEvidenceDigest(content),
  });
}

export function verifyExecutionPlacementEvidenceDigest(
  input: unknown,
): input is ExecutionPlacementEvidence {
  const parsed = executionPlacementEvidenceSchema.safeParse(input);
  if (!parsed.success) return false;
  const { digest, ...content } = parsed.data;
  return digest === computeExecutionPlacementEvidenceDigest(content);
}

export function parseExecutionPlacementEvidence(
  input: unknown,
): ExecutionPlacementEvidence {
  const evidence = executionPlacementEvidenceSchema.parse(input);
  if (!verifyExecutionPlacementEvidenceDigest(evidence)) {
    throw new ExecutionPlacementEvidenceError();
  }
  return evidence;
}
