import { z } from 'zod';

import {
  compareBrowserStrings,
  sha256Canonical,
  sha256Text,
  type Sha256Digest,
} from './crypto.js';
import {
  isVerifiedRedactionEvidence,
  isVerifiedRedactedOutput,
  type RedactionCascadeResult,
  type VerifiedRedactedOutput,
} from './redaction.js';

export const PRIVACY_DECISION_RECEIPT_VERSION =
  'stagefabric.dev/privacy-decision/v1' as const;

const safeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const uniqueSafeIdsSchema = z
  .array(safeIdSchema)
  .max(100_000)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'duplicate identifier' });
    }
  });

const privacyDecisionReceiptContentShape = {
  apiVersion: z.literal(PRIVACY_DECISION_RECEIPT_VERSION),
  kind: z.literal('PrivacyDecisionReceipt'),
  decisionId: safeIdSchema,
  planId: safeIdSchema,
  runtimeId: safeIdSchema,
  operation: safeIdSchema,
  bindingsDigest: digestSchema,
  redactionPolicyId: safeIdSchema,
  redactionPolicyDigest: digestSchema,
  egressPolicyId: safeIdSchema,
  egressPolicyDigest: digestSchema,
  outputDigest: digestSchema,
  summary: z
    .object({
      redactionCount: z.number().int().min(0).max(100_000),
      evaluatedRuleIds: uniqueSafeIdsSchema,
      evaluatedClassifierIds: uniqueSafeIdsSchema,
      appliedRuleIds: uniqueSafeIdsSchema,
      appliedClassifierIds: uniqueSafeIdsSchema,
      categories: uniqueSafeIdsSchema,
    })
    .strict()
    .superRefine((summary, context) => {
      const evaluatedRuleIds = new Set(summary.evaluatedRuleIds);
      if (
        summary.appliedRuleIds.some(
          (sourceId) => !evaluatedRuleIds.has(sourceId),
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['appliedRuleIds'],
          message: 'applied rule was not evaluated',
        });
      }

      const evaluatedClassifierIds = new Set(summary.evaluatedClassifierIds);
      if (
        summary.appliedClassifierIds.some(
          (sourceId) => !evaluatedClassifierIds.has(sourceId),
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['appliedClassifierIds'],
          message: 'applied classifier was not evaluated',
        });
      }
    }),
} as const;

export const privacyDecisionReceiptContentSchema = z
  .object(privacyDecisionReceiptContentShape)
  .strict();

export const privacyDecisionReceiptSchema = z
  .object({
    ...privacyDecisionReceiptContentShape,
    receiptDigest: digestSchema,
  })
  .strict();

export type PrivacyDecisionReceiptContent = z.infer<
  typeof privacyDecisionReceiptContentSchema
>;
export type PrivacyDecisionReceipt = z.infer<
  typeof privacyDecisionReceiptSchema
>;

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareBrowserStrings);
}

const appliedRedactionsSchema = z
  .array(
    z
      .object({
        start: z.number().int().min(0),
        end: z.number().int().positive(),
        category: safeIdSchema,
        sourceKind: z.enum(['rule', 'classifier']),
        sourceId: safeIdSchema,
        priority: z.number().int().min(0).max(1_000_000),
      })
      .strict()
      .refine((redaction) => redaction.start < redaction.end),
  )
  .max(100_000);

export interface IssuePrivacyDecisionReceiptRequest {
  readonly decisionId: string;
  readonly planId: string;
  readonly runtimeId: string;
  readonly operation: string;
  readonly bindingsDigest: Sha256Digest;
  readonly redactionPolicyId: string;
  readonly redactionPolicyDigest: Sha256Digest;
  readonly egressPolicyId: string;
  readonly egressPolicyDigest: Sha256Digest;
  readonly redactionResult: RedactionCascadeResult;
  readonly outputVerification: VerifiedRedactedOutput;
}

/** Issues a content-free receipt: neither input, output, nor matched text is retained. */
export async function issuePrivacyDecisionReceipt(
  request: IssuePrivacyDecisionReceiptRequest,
): Promise<PrivacyDecisionReceipt> {
  const snapshot = Object.freeze({
    decisionId: request.decisionId,
    planId: request.planId,
    runtimeId: request.runtimeId,
    operation: request.operation,
    bindingsDigest: request.bindingsDigest,
    redactionPolicyId: request.redactionPolicyId,
    redactionPolicyDigest: request.redactionPolicyDigest,
    egressPolicyId: request.egressPolicyId,
    egressPolicyDigest: request.egressPolicyDigest,
    redactionResult: request.redactionResult,
    outputVerification: request.outputVerification,
  });
  if (
    !isVerifiedRedactedOutput(snapshot.outputVerification) ||
    !isVerifiedRedactionEvidence(
      snapshot.outputVerification,
      snapshot.redactionResult,
    ) ||
    snapshot.redactionResult.policyId !== snapshot.redactionPolicyId ||
    snapshot.redactionResult.policyDigest !== snapshot.redactionPolicyDigest ||
    snapshot.outputVerification.policyId !== snapshot.redactionPolicyId ||
    snapshot.outputVerification.policyDigest !==
      snapshot.redactionPolicyDigest ||
    snapshot.outputVerification.outputDigest !==
      (await sha256Text(snapshot.redactionResult.output))
  ) {
    throw new Error('redacted_output_not_verified');
  }
  const redactions = Object.freeze(
    appliedRedactionsSchema.parse(snapshot.redactionResult.redactions),
  );
  const content = privacyDecisionReceiptContentSchema.parse({
    apiVersion: PRIVACY_DECISION_RECEIPT_VERSION,
    kind: 'PrivacyDecisionReceipt',
    decisionId: snapshot.decisionId,
    planId: snapshot.planId,
    runtimeId: snapshot.runtimeId,
    operation: snapshot.operation,
    bindingsDigest: snapshot.bindingsDigest,
    redactionPolicyId: snapshot.redactionPolicyId,
    redactionPolicyDigest: snapshot.redactionPolicyDigest,
    egressPolicyId: snapshot.egressPolicyId,
    egressPolicyDigest: snapshot.egressPolicyDigest,
    outputDigest: snapshot.outputVerification.outputDigest,
    summary: {
      redactionCount: redactions.length,
      evaluatedRuleIds: snapshot.outputVerification.evaluatedRuleIds,
      evaluatedClassifierIds:
        snapshot.outputVerification.evaluatedClassifierIds,
      appliedRuleIds: sortedUnique(
        redactions
          .filter((redaction) => redaction.sourceKind === 'rule')
          .map((redaction) => redaction.sourceId),
      ),
      appliedClassifierIds: sortedUnique(
        redactions
          .filter((redaction) => redaction.sourceKind === 'classifier')
          .map((redaction) => redaction.sourceId),
      ),
      categories: sortedUnique(
        redactions.map((redaction) => redaction.category),
      ),
    },
  });
  return privacyDecisionReceiptSchema.parse({
    ...content,
    receiptDigest: await sha256Canonical(content),
  });
}

export async function verifyPrivacyDecisionReceipt(
  receipt: PrivacyDecisionReceipt,
): Promise<boolean> {
  const parsed = privacyDecisionReceiptSchema.safeParse(receipt);
  if (!parsed.success) return false;
  const { receiptDigest, ...content } = parsed.data;
  return receiptDigest === (await sha256Canonical(content));
}
