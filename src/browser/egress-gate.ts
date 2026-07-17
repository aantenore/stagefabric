import { sha256Text, type Sha256Digest } from './crypto.js';
import { compareBrowserStrings } from './crypto.js';
import {
  privacyDecisionReceiptSchema,
  verifyPrivacyDecisionReceipt,
  type PrivacyDecisionReceipt,
} from './privacy-receipt.js';

export type EgressDenialReasonCode =
  | 'bindings_digest_mismatch'
  | 'egress_policy_mismatch'
  | 'invalid_receipt'
  | 'lineage_mismatch'
  | 'output_digest_mismatch'
  | 'redaction_policy_mismatch'
  | 'redaction_source_mismatch';

export class EgressDeniedError extends Error {
  readonly reasonCode: EgressDenialReasonCode;

  constructor(reasonCode: EgressDenialReasonCode) {
    super(reasonCode);
    this.name = 'EgressDeniedError';
    this.reasonCode = reasonCode;
  }
}

export interface BrowserEgressPolicyBinding {
  readonly decisionId: string;
  readonly planId: string;
  readonly runtimeId: string;
  readonly operation: string;
  readonly bindingsDigest: Sha256Digest;
  readonly redactionPolicyId: string;
  readonly redactionPolicyDigest: Sha256Digest;
  readonly redactionRuleIds: readonly string[];
  readonly redactionClassifierIds: readonly string[];
  readonly egressPolicyId: string;
  readonly egressPolicyDigest: Sha256Digest;
}

export interface BrowserEgressPermit {
  readonly kind: 'BrowserEgressPermit';
  readonly decisionId: string;
  readonly planId: string;
  readonly runtimeId: string;
  readonly operation: string;
  readonly egressPolicyId: string;
  readonly egressPolicyDigest: Sha256Digest;
  readonly outputDigest: Sha256Digest;
  readonly receiptDigest: Sha256Digest;
}

const authorizedEgressPermits = new WeakSet<object>();

export function isAuthorizedBrowserEgressPermit(
  value: unknown,
): value is BrowserEgressPermit {
  return (
    typeof value === 'object' &&
    value !== null &&
    authorizedEgressPermits.has(value)
  );
}

/**
 * Fail-closed egress boundary. A permit is issued only for the exact output
 * bytes and the exact operator-owned policy/binding digests in the receipt.
 */
export class BrowserEgressGate {
  readonly #binding: BrowserEgressPolicyBinding;

  constructor(binding: BrowserEgressPolicyBinding) {
    const ruleIds = safeSourceIds(binding.redactionRuleIds);
    const classifierIds = safeSourceIds(binding.redactionClassifierIds);
    const ruleIdSet = new Set(ruleIds);
    if (classifierIds.some((id) => ruleIdSet.has(id))) {
      throw new TypeError('invalid_egress_policy_binding');
    }
    this.#binding = Object.freeze({
      ...binding,
      redactionRuleIds: ruleIds,
      redactionClassifierIds: classifierIds,
    });
  }

  async authorize(
    output: string,
    receipt: PrivacyDecisionReceipt,
  ): Promise<BrowserEgressPermit> {
    const parsed = privacyDecisionReceiptSchema.safeParse(receipt);
    if (!parsed.success) {
      throw new EgressDeniedError('invalid_receipt');
    }
    // Zod returns a detached plain-data snapshot. Never reread caller-owned
    // receipt data after the asynchronous digest verification.
    const receiptSnapshot = parsed.data;
    if (!(await verifyPrivacyDecisionReceipt(receiptSnapshot))) {
      throw new EgressDeniedError('invalid_receipt');
    }
    if (receiptSnapshot.bindingsDigest !== this.#binding.bindingsDigest) {
      throw new EgressDeniedError('bindings_digest_mismatch');
    }
    if (
      receiptSnapshot.decisionId !== this.#binding.decisionId ||
      receiptSnapshot.planId !== this.#binding.planId ||
      receiptSnapshot.runtimeId !== this.#binding.runtimeId ||
      receiptSnapshot.operation !== this.#binding.operation
    ) {
      throw new EgressDeniedError('lineage_mismatch');
    }
    if (
      receiptSnapshot.redactionPolicyId !== this.#binding.redactionPolicyId ||
      receiptSnapshot.redactionPolicyDigest !==
        this.#binding.redactionPolicyDigest
    ) {
      throw new EgressDeniedError('redaction_policy_mismatch');
    }
    if (
      !sameIds(
        receiptSnapshot.summary.evaluatedRuleIds,
        this.#binding.redactionRuleIds,
      ) ||
      !sameIds(
        receiptSnapshot.summary.evaluatedClassifierIds,
        this.#binding.redactionClassifierIds,
      )
    ) {
      throw new EgressDeniedError('redaction_source_mismatch');
    }
    if (
      receiptSnapshot.egressPolicyId !== this.#binding.egressPolicyId ||
      receiptSnapshot.egressPolicyDigest !== this.#binding.egressPolicyDigest
    ) {
      throw new EgressDeniedError('egress_policy_mismatch');
    }
    const outputDigest = await sha256Text(output);
    if (receiptSnapshot.outputDigest !== outputDigest) {
      throw new EgressDeniedError('output_digest_mismatch');
    }

    const permit = Object.freeze({
      kind: 'BrowserEgressPermit' as const,
      decisionId: receiptSnapshot.decisionId,
      planId: receiptSnapshot.planId,
      runtimeId: receiptSnapshot.runtimeId,
      operation: receiptSnapshot.operation,
      egressPolicyId: receiptSnapshot.egressPolicyId,
      egressPolicyDigest: receiptSnapshot.egressPolicyDigest as Sha256Digest,
      outputDigest,
      receiptDigest: receiptSnapshot.receiptDigest as Sha256Digest,
    });
    authorizedEgressPermits.add(permit);
    return permit;
  }
}

const SAFE_SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function safeSourceIds(values: readonly string[]): readonly string[] {
  if (
    !Array.isArray(values) ||
    values.length > 4_096 ||
    values.some((value) => !SAFE_SOURCE_ID.test(value)) ||
    new Set(values).size !== values.length
  ) {
    throw new TypeError('invalid_egress_policy_binding');
  }
  return Object.freeze([...values].sort(compareBrowserStrings));
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
