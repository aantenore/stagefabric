import {
  verifyBrowserRuntimeBindings,
  type BrowserRuntimeBindings,
} from './bindings.js';
import type { BrowserCapabilitySnapshot } from './capability-probe.js';
import {
  compareBrowserStrings,
  sha256Canonical,
  type Sha256Digest,
} from './crypto.js';
import {
  isAuthorizedBrowserEgressPermit,
  type BrowserEgressPermit,
  type EgressDenialReasonCode,
} from './egress-gate.js';
import {
  verifyPrivacyDecisionReceipt,
  type PrivacyDecisionReceipt,
} from './privacy-receipt.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export interface BrowserPrivacyPlanStep {
  readonly sequence: number;
  readonly code:
    | 'capability-probe'
    | 'dedicated-worker'
    | 'redaction-cascade'
    | 'post-output-verification'
    | 'egress-gate';
  readonly title: string;
  readonly explanation: string;
}

export interface BrowserPrivacyPlanProjectionContent {
  readonly apiVersion: 'stagefabric.dev/browser-explainability/v1';
  readonly kind: 'BrowserPrivacyPlanProjection';
  readonly planId: string;
  readonly operatorId: string;
  readonly bindingsDigest: Sha256Digest;
  readonly runtimeId: string;
  readonly driverId: string;
  readonly operation: string;
  readonly policy: {
    readonly policyId: string;
    readonly redactionPolicyId: string;
    readonly redactionPolicyDigest: Sha256Digest;
    readonly egressPolicyId: string;
    readonly egressPolicyDigest: Sha256Digest;
  };
  readonly requirements: {
    readonly secureContext: boolean;
    readonly webGpu: boolean;
    readonly wasm: boolean;
  };
  readonly redactionSources: {
    readonly ruleIds: readonly string[];
    readonly classifierIds: readonly string[];
  };
  readonly steps: readonly BrowserPrivacyPlanStep[];
}

export interface BrowserPrivacyPlanProjection extends BrowserPrivacyPlanProjectionContent {
  readonly planDigest: Sha256Digest;
}

function safeUniqueIds(values: readonly string[]): readonly string[] {
  if (
    values.some((value) => !SAFE_ID.test(value)) ||
    new Set(values).size !== values.length
  ) {
    throw new Error('invalid_explainability_identifier');
  }
  return Object.freeze([...values].sort(compareBrowserStrings));
}

export async function projectBrowserPrivacyPlan(request: {
  readonly planId: string;
  readonly bindings: BrowserRuntimeBindings;
  readonly runtimeId: string;
  readonly operation: string;
}): Promise<BrowserPrivacyPlanProjection> {
  const snapshot = structuredClone(request);
  if (
    !SAFE_ID.test(snapshot.planId) ||
    !SAFE_ID.test(snapshot.runtimeId) ||
    !SAFE_ID.test(snapshot.operation) ||
    !(await verifyBrowserRuntimeBindings(snapshot.bindings))
  ) {
    throw new Error('invalid_browser_privacy_plan');
  }
  const runtime = snapshot.bindings.runtimes.find(
    (candidate) => candidate.runtimeId === snapshot.runtimeId,
  );
  if (runtime === undefined) throw new Error('browser_runtime_not_bound');

  const content: BrowserPrivacyPlanProjectionContent = {
    apiVersion: 'stagefabric.dev/browser-explainability/v1',
    kind: 'BrowserPrivacyPlanProjection',
    planId: snapshot.planId,
    operatorId: snapshot.bindings.operatorId,
    bindingsDigest: snapshot.bindings.digest as Sha256Digest,
    runtimeId: runtime.runtimeId,
    driverId: runtime.driverId,
    operation: snapshot.operation,
    policy: {
      policyId: snapshot.bindings.policy.policyId,
      redactionPolicyId: snapshot.bindings.policy.redactionPolicyId,
      redactionPolicyDigest: snapshot.bindings.policy
        .redactionPolicyDigest as Sha256Digest,
      egressPolicyId: snapshot.bindings.policy.egressPolicyId,
      egressPolicyDigest: snapshot.bindings.policy
        .egressPolicyDigest as Sha256Digest,
    },
    requirements: { ...runtime.requirements },
    redactionSources: {
      ruleIds: safeUniqueIds(snapshot.bindings.policy.redactionRuleIds),
      classifierIds: safeUniqueIds(
        snapshot.bindings.policy.redactionClassifierIds,
      ),
    },
    steps: Object.freeze([
      Object.freeze({
        sequence: 1,
        code: 'capability-probe' as const,
        title: 'Check browser privacy capabilities',
        explanation:
          'Confirm only coarse availability requirements, without collecting device identity.',
      }),
      Object.freeze({
        sequence: 2,
        code: 'dedicated-worker' as const,
        title: 'Run the bound local operation',
        explanation:
          'Use the operator-selected driver in a time-bounded, killable Dedicated Worker.',
      }),
      Object.freeze({
        sequence: 3,
        code: 'redaction-cascade' as const,
        title: 'Remove sensitive spans',
        explanation:
          'Apply deterministic operator rules and configured local classifier spans.',
      }),
      Object.freeze({
        sequence: 4,
        code: 'post-output-verification' as const,
        title: 'Verify the sanitized result again',
        explanation:
          'Re-run the complete policy and issue a receipt only when no sensitive span remains.',
      }),
      Object.freeze({
        sequence: 5,
        code: 'egress-gate' as const,
        title: 'Authorize the exact output',
        explanation:
          'Allow release only when output, binding, and policy digests match the verified receipt.',
      }),
    ]),
  };
  return Object.freeze({
    ...content,
    planDigest: await sha256Canonical(content),
  });
}

export interface BrowserPrivacyLedgerEvent {
  readonly sequence: number;
  readonly phase: 'capability' | 'redaction' | 'egress';
  readonly outcome: 'allowed' | 'blocked' | 'completed';
  readonly reasonCodes: readonly string[];
  readonly evidenceDigests: readonly Sha256Digest[];
  readonly redactionCount?: number;
}

export interface BrowserPrivacyLedgerProjection {
  readonly apiVersion: 'stagefabric.dev/browser-explainability/v1';
  readonly kind: 'BrowserPrivacyLedgerProjection';
  readonly planId: string;
  readonly planDigest: Sha256Digest;
  readonly events: readonly BrowserPrivacyLedgerEvent[];
  readonly ledgerDigest: Sha256Digest;
}

const CAPABILITY_ORDER = ['secure-context', 'webgpu', 'wasm'] as const;
const LEDGER_DENIAL_REASONS = new Set([
  'bindings_digest_mismatch',
  'capability_unavailable',
  'egress_policy_mismatch',
  'execution_failed',
  'invalid_receipt',
  'invalid_worker_result',
  'lineage_mismatch',
  'output_digest_mismatch',
  'output_limit_exceeded',
  'redaction_policy_mismatch',
  'redaction_source_mismatch',
  'runtime_not_registered',
]);
const UNAVAILABLE_CAPABILITY_REASONS: Readonly<
  Record<(typeof CAPABILITY_ORDER)[number], ReadonlySet<string>>
> = {
  'secure-context': new Set(['secure_context_unavailable']),
  webgpu: new Set([
    'webgpu_api_unavailable',
    'webgpu_adapter_unavailable',
    'webgpu_probe_failed',
  ]),
  wasm: new Set(['wasm_api_unavailable', 'wasm_validation_failed']),
} as const;

function isValidCapabilitySnapshot(
  capability: BrowserCapabilitySnapshot,
  plan: BrowserPrivacyPlanProjection,
): boolean {
  if (
    typeof capability !== 'object' ||
    capability === null ||
    capability.kind !== 'BrowserCapabilitySnapshot' ||
    typeof capability.eligible !== 'boolean' ||
    !Array.isArray(capability.capabilities) ||
    capability.capabilities.length !== CAPABILITY_ORDER.length ||
    Reflect.ownKeys(capability).length !== 3
  ) {
    return false;
  }
  const requiredByCapability = {
    'secure-context': plan.requirements.secureContext,
    webgpu: plan.requirements.webGpu,
    wasm: plan.requirements.wasm,
  } as const;
  for (const [index, expectedName] of CAPABILITY_ORDER.entries()) {
    const item = capability.capabilities[index] as unknown;
    if (
      typeof item !== 'object' ||
      item === null ||
      Array.isArray(item) ||
      Reflect.ownKeys(item).length !== 4
    ) {
      return false;
    }
    const candidate = item as Record<string, unknown>;
    if (
      candidate['capability'] !== expectedName ||
      candidate['required'] !== requiredByCapability[expectedName] ||
      typeof candidate['available'] !== 'boolean' ||
      typeof candidate['reasonCode'] !== 'string' ||
      (candidate['available']
        ? candidate['reasonCode'] !== 'available'
        : !UNAVAILABLE_CAPABILITY_REASONS[expectedName].has(
            candidate['reasonCode'],
          ))
    ) {
      return false;
    }
  }
  const eligible = capability.capabilities.every(
    (item) => !item.required || item.available,
  );
  return capability.eligible === eligible;
}

export async function projectBrowserPrivacyLedger(request: {
  readonly plan: BrowserPrivacyPlanProjection;
  readonly capability: BrowserCapabilitySnapshot;
  readonly receipt?: PrivacyDecisionReceipt;
  readonly egress:
    | { readonly outcome: 'authorized'; readonly permit: BrowserEgressPermit }
    | {
        readonly outcome: 'denied';
        readonly reasonCode:
          | EgressDenialReasonCode
          | 'capability_unavailable'
          | 'execution_failed'
          | 'invalid_worker_result'
          | 'output_limit_exceeded'
          | 'runtime_not_registered';
      };
}): Promise<BrowserPrivacyLedgerProjection> {
  let snapshot: typeof request;
  try {
    const plan = request.plan;
    const capability = request.capability;
    const receipt = request.receipt;
    const egress = request.egress;
    const outcome = egress.outcome;
    if (outcome === 'authorized') {
      const permit = egress.permit;
      if (!isAuthorizedBrowserEgressPermit(permit)) {
        throw new Error('invalid_browser_egress_permit');
      }
      snapshot = structuredClone({
        plan,
        capability,
        ...(receipt === undefined ? {} : { receipt }),
        egress: { outcome, permit },
      }) as typeof request;
    } else if (outcome === 'denied') {
      const reasonCode = egress.reasonCode;
      if (
        typeof reasonCode !== 'string' ||
        !LEDGER_DENIAL_REASONS.has(reasonCode)
      ) {
        throw new Error('invalid_browser_privacy_ledger');
      }
      snapshot = structuredClone({
        plan,
        capability,
        ...(receipt === undefined ? {} : { receipt }),
        egress: { outcome, reasonCode },
      }) as typeof request;
    } else {
      throw new Error('invalid_browser_privacy_ledger');
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'invalid_browser_egress_permit'
    ) {
      throw error;
    }
    throw new Error('invalid_browser_privacy_ledger');
  }
  const { planDigest, ...planContent } = snapshot.plan;
  if (planDigest !== (await sha256Canonical(planContent))) {
    throw new Error('invalid_browser_privacy_plan');
  }

  if (!isValidCapabilitySnapshot(snapshot.capability, snapshot.plan)) {
    throw new Error('invalid_browser_capability_snapshot');
  }
  if (
    snapshot.capability.eligible !==
    (snapshot.egress.outcome === 'authorized' ||
      (snapshot.egress.outcome === 'denied' &&
        snapshot.egress.reasonCode !== 'capability_unavailable'))
  ) {
    throw new Error('invalid_browser_capability_lineage');
  }
  if (!snapshot.capability.eligible && snapshot.receipt !== undefined) {
    throw new Error('invalid_browser_capability_lineage');
  }

  const capabilityReasons = snapshot.capability.capabilities
    .filter((capability) => capability.required && !capability.available)
    .map((capability) => capability.reasonCode)
    .sort(compareBrowserStrings);
  const capabilityDigest = await sha256Canonical(snapshot.capability);
  const events: BrowserPrivacyLedgerEvent[] = [
    Object.freeze({
      sequence: 1,
      phase: 'capability' as const,
      outcome: snapshot.capability.eligible
        ? ('allowed' as const)
        : ('blocked' as const),
      reasonCodes: Object.freeze(
        capabilityReasons.length === 0 ? ['available'] : capabilityReasons,
      ),
      evidenceDigests: Object.freeze([capabilityDigest]),
    }),
  ];

  if (snapshot.receipt !== undefined) {
    if (
      !(await verifyPrivacyDecisionReceipt(snapshot.receipt)) ||
      snapshot.receipt.planId !== snapshot.plan.planId ||
      snapshot.receipt.runtimeId !== snapshot.plan.runtimeId ||
      snapshot.receipt.operation !== snapshot.plan.operation ||
      snapshot.receipt.bindingsDigest !== snapshot.plan.bindingsDigest
    ) {
      throw new Error('invalid_privacy_decision_receipt');
    }
    events.push(
      Object.freeze({
        sequence: events.length + 1,
        phase: 'redaction' as const,
        outcome: 'completed' as const,
        reasonCodes: Object.freeze(['post_output_verified']),
        evidenceDigests: Object.freeze([
          snapshot.receipt.outputDigest as Sha256Digest,
          snapshot.receipt.receiptDigest as Sha256Digest,
        ]),
        redactionCount: snapshot.receipt.summary.redactionCount,
      }),
    );
  }

  if (
    snapshot.egress.outcome === 'authorized' &&
    (snapshot.receipt === undefined ||
      snapshot.egress.permit.kind !== 'BrowserEgressPermit' ||
      snapshot.egress.permit.decisionId !== snapshot.receipt.decisionId ||
      snapshot.egress.permit.planId !== snapshot.receipt.planId ||
      snapshot.egress.permit.runtimeId !== snapshot.receipt.runtimeId ||
      snapshot.egress.permit.operation !== snapshot.receipt.operation ||
      snapshot.egress.permit.egressPolicyId !==
        snapshot.receipt.egressPolicyId ||
      snapshot.egress.permit.egressPolicyDigest !==
        snapshot.receipt.egressPolicyDigest ||
      snapshot.egress.permit.egressPolicyId !==
        snapshot.plan.policy.egressPolicyId ||
      snapshot.egress.permit.egressPolicyDigest !==
        snapshot.plan.policy.egressPolicyDigest ||
      snapshot.egress.permit.outputDigest !== snapshot.receipt.outputDigest ||
      snapshot.egress.permit.receiptDigest !== snapshot.receipt.receiptDigest)
  ) {
    throw new Error('invalid_browser_egress_permit');
  }

  events.push(
    Object.freeze({
      sequence: events.length + 1,
      phase: 'egress' as const,
      outcome:
        snapshot.egress.outcome === 'authorized'
          ? ('allowed' as const)
          : ('blocked' as const),
      reasonCodes: Object.freeze([
        snapshot.egress.outcome === 'authorized'
          ? 'digest_and_policy_match'
          : snapshot.egress.reasonCode,
      ]),
      evidenceDigests: Object.freeze(
        snapshot.egress.outcome === 'authorized'
          ? [snapshot.egress.permit.receiptDigest]
          : [],
      ),
    }),
  );

  const content = {
    apiVersion: 'stagefabric.dev/browser-explainability/v1' as const,
    kind: 'BrowserPrivacyLedgerProjection' as const,
    planId: snapshot.plan.planId,
    planDigest: snapshot.plan.planDigest,
    events: Object.freeze(events),
  };
  return Object.freeze({
    ...content,
    ledgerDigest: await sha256Canonical(content),
  });
}
