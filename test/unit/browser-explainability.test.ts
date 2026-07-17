import { describe, expect, it } from 'vitest';

import {
  BROWSER_RUNTIME_API_VERSION,
  sealBrowserRuntimeBindings,
} from '../../src/browser/bindings.js';
import { probeBrowserCapabilities } from '../../src/browser/capability-probe.js';
import type { Sha256Digest } from '../../src/browser/crypto.js';
import { BrowserEgressGate } from '../../src/browser/egress-gate.js';
import {
  projectBrowserPrivacyLedger,
  projectBrowserPrivacyPlan,
} from '../../src/browser/explainability.js';
import { issuePrivacyDecisionReceipt } from '../../src/browser/privacy-receipt.js';
import {
  redactWithCascade,
  verifyRedactionResult,
  type RedactionCascadePolicy,
} from '../../src/browser/redaction.js';

const redactionDigest = `sha256:${'b'.repeat(64)}` as Sha256Digest;
const egressDigest = `sha256:${'c'.repeat(64)}` as Sha256Digest;

function redactionPolicy(): RedactionCascadePolicy {
  return {
    policyId: 'redaction-v1',
    policyDigest: redactionDigest,
    executionBoundary: 'dedicated-worker',
    maxInputCodeUnits: 1_024,
    maxCandidateSpans: 20,
    defaultClassifierReplacement: '<PRIVATE>',
    rules: [
      {
        ruleId: 'email-rule',
        category: 'email',
        priority: 1,
        pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+',
        replacement: '<EMAIL>',
      },
    ],
  };
}

describe('browser explainability lineage', () => {
  it('accepts only the exact permit branded by the egress gate', async () => {
    const bindings = await sealBrowserRuntimeBindings({
      apiVersion: BROWSER_RUNTIME_API_VERSION,
      kind: 'BrowserRuntimeBindings',
      operatorId: 'operator-a',
      policy: {
        policyId: 'privacy-v1',
        redactionPolicyId: 'redaction-v1',
        redactionPolicyDigest: redactionDigest,
        redactionRuleIds: ['email-rule'],
        redactionClassifierIds: [],
        egressPolicyId: 'egress-v1',
        egressPolicyDigest: egressDigest,
        capabilityProbeTimeoutMs: 100,
        workerReadyTimeoutMs: 500,
        invocationTimeoutMs: 500,
        cleanupTimeoutMs: 100,
        maxInputBytes: 1_024,
        maxOutputBytes: 1_024,
      },
      runtimes: [
        {
          runtimeId: 'runtime-a',
          driverId: 'driver-a',
          worker: { moduleUrl: '/privacy-worker.js', type: 'module' },
          requirements: { secureContext: true, webGpu: false, wasm: false },
          configuration: {},
        },
      ],
    });
    const plan = await projectBrowserPrivacyPlan({
      planId: 'plan-1',
      bindings,
      runtimeId: 'runtime-a',
      operation: 'sanitize',
    });
    const capability = await probeBrowserCapabilities(
      { secureContext: true, webGpu: false, wasm: false },
      { isSecureContext: true, gpu: undefined, wasm: undefined },
    );
    const redaction = await redactWithCascade(
      'alice@example.test',
      redactionPolicy(),
    );
    const verification = await verifyRedactionResult(
      redaction,
      redactionPolicy(),
    );
    const receipt = await issuePrivacyDecisionReceipt({
      decisionId: 'decision-1',
      planId: 'plan-1',
      runtimeId: 'runtime-a',
      operation: 'sanitize',
      bindingsDigest: bindings.digest as Sha256Digest,
      redactionPolicyId: 'redaction-v1',
      redactionPolicyDigest: redactionDigest,
      egressPolicyId: 'egress-v1',
      egressPolicyDigest: egressDigest,
      redactionResult: redaction,
      outputVerification: verification,
    });
    const permit = await new BrowserEgressGate({
      decisionId: 'decision-1',
      planId: 'plan-1',
      runtimeId: 'runtime-a',
      operation: 'sanitize',
      bindingsDigest: bindings.digest as Sha256Digest,
      redactionPolicyId: 'redaction-v1',
      redactionPolicyDigest: redactionDigest,
      redactionRuleIds: ['email-rule'],
      redactionClassifierIds: [],
      egressPolicyId: 'egress-v1',
      egressPolicyDigest: egressDigest,
    }).authorize(redaction.output, receipt);

    await expect(
      projectBrowserPrivacyLedger({
        plan,
        capability,
        receipt,
        egress: { outcome: 'authorized', permit },
      }),
    ).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ phase: 'egress', outcome: 'allowed' }),
      ]),
    });

    const forged = structuredClone(permit) as {
      -readonly [Key in keyof typeof permit]: (typeof permit)[Key];
    };
    forged.egressPolicyId = 'egress-forged';
    await expect(
      projectBrowserPrivacyLedger({
        plan,
        capability,
        receipt,
        egress: { outcome: 'authorized', permit: forged },
      }),
    ).rejects.toThrow('invalid_browser_egress_permit');

    const blockedCapability = structuredClone(capability) as {
      kind: 'BrowserCapabilitySnapshot';
      eligible: boolean;
      capabilities: {
        capability: 'secure-context' | 'webgpu' | 'wasm';
        required: boolean;
        available: boolean;
        reasonCode: string;
      }[];
    };
    blockedCapability.eligible = false;
    blockedCapability.capabilities[0]!.available = false;
    blockedCapability.capabilities[0]!.reasonCode =
      'secure_context_unavailable';
    await expect(
      projectBrowserPrivacyLedger({
        plan,
        capability: blockedCapability as never,
        receipt,
        egress: { outcome: 'authorized', permit },
      }),
    ).rejects.toThrow('invalid_browser_capability_lineage');

    await expect(
      projectBrowserPrivacyLedger({
        plan,
        capability: blockedCapability as never,
        egress: {
          outcome: 'not-a-real-outcome',
          reasonCode: 'email=alice@example.test',
        } as never,
      }),
    ).rejects.toThrow('invalid_browser_privacy_ledger');
    await expect(
      projectBrowserPrivacyLedger({
        plan,
        capability: blockedCapability as never,
        egress: {
          outcome: 'denied',
          reasonCode: 'email=alice@example.test',
        } as never,
      }),
    ).rejects.toThrow('invalid_browser_privacy_ledger');

    let permitReads = 0;
    const accessorEgress = {
      outcome: 'authorized' as const,
      get permit() {
        permitReads += 1;
        return permitReads === 1 ? permit : forged;
      },
    };
    await expect(
      projectBrowserPrivacyLedger({
        plan,
        capability,
        receipt,
        egress: accessorEgress,
      }),
    ).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ phase: 'egress', outcome: 'allowed' }),
      ]),
    });
    expect(permitReads).toBe(1);
  });
});
