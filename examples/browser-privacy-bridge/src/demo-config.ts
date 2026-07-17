import {
  sha256Canonical,
  sealBrowserRuntimeBindings,
  type BrowserRuntimeBindings,
  type RedactionCascadePolicy,
  type Sha256Digest,
} from '../../../src/browser/index.js';
import { DEMO_WORKER_MODULE_URL } from './demo-driver.js';

export const DEMO_RUNTIME_ID = 'browser.local.redactor';
export const DEMO_DRIVER_ID = 'stagefabric.demo-worker';
export const DEMO_OPERATION = 'privacy.redact';

export const DEMO_INPUT = `Prepare a support summary for Mira Chen.
Email: mira.chen@example.test
Phone: +44 20 7946 0958
Temporary token: DEMO_TOKEN_42
Keep the issue description: the local browser draft is ready for review.`;

export const DEMO_RULE_IDS = [
  'rule.email',
  'rule.phone',
  'rule.demo-token',
] as const;

const redactionPolicyContent = {
  policyId: 'privacy.redaction.demo.v1',
  rules: [
    {
      ruleId: DEMO_RULE_IDS[0],
      category: 'email',
      priority: 300,
      pattern: String.raw`\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b`,
      flags: 'i',
      replacement: '[EMAIL REDACTED]',
    },
    {
      ruleId: DEMO_RULE_IDS[1],
      category: 'phone',
      priority: 200,
      pattern: String.raw`(?:\+\d{1,3}[ .-]?)?(?:\(?\d{2,4}\)?[ .-]?){2,4}\d{2,4}`,
      replacement: '[PHONE REDACTED]',
    },
    {
      ruleId: DEMO_RULE_IDS[2],
      category: 'secret',
      priority: 400,
      pattern: String.raw`\bDEMO_TOKEN_[A-Z0-9_-]+\b`,
      replacement: '[SECRET REDACTED]',
    },
  ],
  defaultClassifierReplacement: '[SENSITIVE SPAN REDACTED]',
  maxCandidateSpans: 256,
  maxInputCodeUnits: 16_384,
  executionBoundary: 'dedicated-worker' as const,
};

export interface DemoConfiguration {
  readonly [key: string]: unknown;
  readonly operation: typeof DEMO_OPERATION;
  readonly redactionPolicy: RedactionCascadePolicy;
  readonly egressPolicy: {
    readonly policyId: string;
    readonly policyDigest: Sha256Digest;
  };
}

export interface DemoRuntimeSetup {
  readonly bindings: BrowserRuntimeBindings;
  readonly configuration: DemoConfiguration;
}

export async function createDemoRuntimeSetup(): Promise<DemoRuntimeSetup> {
  const redactionPolicyDigest = await sha256Canonical(redactionPolicyContent);
  const egressPolicyId = 'privacy.egress.exact-output.v1';
  const egressPolicyDigest = await sha256Canonical({
    policyId: egressPolicyId,
    authorization: 'exact-output-permit',
    networkSideEffect: 'application-owned',
  });
  const configuration: DemoConfiguration = {
    operation: DEMO_OPERATION,
    redactionPolicy: {
      ...redactionPolicyContent,
      policyDigest: redactionPolicyDigest,
    },
    egressPolicy: {
      policyId: egressPolicyId,
      policyDigest: egressPolicyDigest,
    },
  };
  const bindings = await sealBrowserRuntimeBindings({
    apiVersion: 'stagefabric.dev/browser-runtime/v1alpha1',
    kind: 'BrowserRuntimeBindings',
    operatorId: 'stagefabric.reference-app',
    policy: {
      policyId: 'privacy.bridge.demo.v1',
      redactionPolicyId: configuration.redactionPolicy.policyId,
      redactionPolicyDigest,
      redactionRuleIds: DEMO_RULE_IDS,
      redactionClassifierIds: [],
      egressPolicyId,
      egressPolicyDigest,
      capabilityProbeTimeoutMs: 2_000,
      workerReadyTimeoutMs: 5_000,
      invocationTimeoutMs: 8_000,
      cleanupTimeoutMs: 1_000,
      maxInputBytes: 32_768,
      maxOutputBytes: 32_768,
    },
    runtimes: [
      {
        runtimeId: DEMO_RUNTIME_ID,
        driverId: DEMO_DRIVER_ID,
        worker: {
          moduleUrl: DEMO_WORKER_MODULE_URL,
          type: 'module',
          name: 'stagefabric-privacy-redactor',
        },
        requirements: {
          secureContext: true,
          webGpu: false,
          wasm: true,
        },
        configuration,
      },
    ],
  });
  return Object.freeze({ bindings, configuration });
}
