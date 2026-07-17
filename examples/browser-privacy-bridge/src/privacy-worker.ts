import { z } from 'zod';

// Keep Zod on its interpreter path so this worker remains compatible with the
// reference app's strict CSP without a dynamic-import bootstrap race.
z.config({ jitless: true });

import {
  BROWSER_WORKER_PROTOCOL,
  issuePrivacyDecisionReceipt,
  redactWithCascade,
  verifyRedactionResult,
  type RedactionCascadePolicy,
  type Sha256Digest,
} from '../../../src/browser/index.js';

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const redactionRule = z
  .object({
    ruleId: safeId,
    category: safeId,
    priority: z.number().int().min(0).max(1_000_000),
    pattern: z.string().min(1).max(16_384),
    flags: z
      .string()
      .regex(/^[imsu]*$/)
      .optional(),
    replacement: z.string().min(1).max(1_024),
  })
  .strict();
const configurationSchema = z
  .object({
    operation: safeId,
    redactionPolicy: z
      .object({
        policyId: safeId,
        policyDigest: digest,
        rules: z.array(redactionRule).max(1_024),
        defaultClassifierReplacement: z.string().min(1).max(1_024),
        maxCandidateSpans: z.number().int().min(1).max(100_000),
        maxInputCodeUnits: z
          .number()
          .int()
          .min(1)
          .max(16 * 1_024 * 1_024),
        executionBoundary: z.literal('dedicated-worker'),
      })
      .strict(),
    egressPolicy: z.object({ policyId: safeId, policyDigest: digest }).strict(),
  })
  .strict();
const initializeSchema = z
  .object({
    protocol: z.literal(BROWSER_WORKER_PROTOCOL),
    kind: z.literal('initialize'),
    requestId: safeId,
    runtimeId: safeId,
    driverId: safeId,
    configuration: z.unknown(),
  })
  .strict();
const invokeSchema = z
  .object({
    protocol: z.literal(BROWSER_WORKER_PROTOCOL),
    kind: z.literal('invoke'),
    requestId: safeId,
    runtimeId: safeId,
    operation: safeId,
    input: z
      .object({
        apiVersion: z.literal('stagefabric.dev/browser-privacy-worker/v1'),
        kind: z.literal('BrowserPrivacyWorkerRequest'),
        decisionId: safeId,
        planId: safeId,
        runtimeId: safeId,
        operation: safeId,
        bindingsDigest: digest,
        redactionPolicyId: safeId,
        redactionPolicyDigest: digest,
        egressPolicyId: safeId,
        egressPolicyDigest: digest,
        input: z.string(),
      })
      .strict(),
  })
  .strict();
const abortSchema = z
  .object({
    protocol: z.literal(BROWSER_WORKER_PROTOCOL),
    kind: z.literal('abort'),
    requestId: safeId,
    runtimeId: safeId,
  })
  .strict();

interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(
    type: 'message',
    listener: (event: { readonly data: unknown }) => void,
  ): void;
}

const scope = globalThis as unknown as WorkerScope;
const controllers = new Map<string, AbortController>();
let runtime:
  | {
      readonly runtimeId: string;
      readonly driverId: string;
      readonly configuration: z.infer<typeof configurationSchema>;
    }
  | undefined;

function postError(requestId: string, errorCode: string): void {
  scope.postMessage({
    protocol: BROWSER_WORKER_PROTOCOL,
    kind: 'error',
    requestId,
    errorCode,
  });
}

function requestIdFrom(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const requestId = Reflect.get(value, 'requestId');
  return safeId.safeParse(requestId).success
    ? (requestId as string)
    : undefined;
}

async function invoke(value: unknown): Promise<void> {
  const parsed = invokeSchema.safeParse(value);
  if (!parsed.success || runtime === undefined) {
    const requestId = requestIdFrom(value);
    if (requestId !== undefined) postError(requestId, 'invalid_message');
    return;
  }
  const { requestId, runtimeId, operation, input } = parsed.data;
  const configuration = runtime.configuration;
  if (
    runtimeId !== runtime.runtimeId ||
    operation !== configuration.operation ||
    input.runtimeId !== runtime.runtimeId ||
    input.operation !== configuration.operation ||
    input.redactionPolicyId !== configuration.redactionPolicy.policyId ||
    input.redactionPolicyDigest !==
      configuration.redactionPolicy.policyDigest ||
    input.egressPolicyId !== configuration.egressPolicy.policyId ||
    input.egressPolicyDigest !== configuration.egressPolicy.policyDigest
  ) {
    postError(requestId, 'runtime_binding_mismatch');
    return;
  }

  const controller = new AbortController();
  controllers.set(requestId, controller);
  try {
    const policy = configuration.redactionPolicy as RedactionCascadePolicy;
    const redaction = await redactWithCascade(input.input, policy, {
      signal: controller.signal,
    });
    const verification = await verifyRedactionResult(redaction, policy, {
      signal: controller.signal,
    });
    const receipt = await issuePrivacyDecisionReceipt({
      decisionId: input.decisionId,
      planId: input.planId,
      runtimeId: input.runtimeId,
      operation: input.operation,
      bindingsDigest: input.bindingsDigest as Sha256Digest,
      redactionPolicyId: input.redactionPolicyId,
      redactionPolicyDigest: input.redactionPolicyDigest as Sha256Digest,
      egressPolicyId: input.egressPolicyId,
      egressPolicyDigest: input.egressPolicyDigest as Sha256Digest,
      redactionResult: redaction,
      outputVerification: verification,
    });
    scope.postMessage({
      protocol: BROWSER_WORKER_PROTOCOL,
      kind: 'result',
      requestId,
      runtimeId,
      operation,
      output: {
        apiVersion: 'stagefabric.dev/browser-privacy-worker/v1',
        kind: 'BrowserPrivacyWorkerResult',
        output: redaction.output,
        receipt,
      },
    });
  } catch {
    postError(
      requestId,
      controller.signal.aborted ? 'aborted' : 'redaction_failed',
    );
  } finally {
    controllers.delete(requestId);
  }
}

scope.addEventListener('message', (event) => {
  const initialized = initializeSchema.safeParse(event.data);
  if (initialized.success) {
    const configuration = configurationSchema.safeParse(
      initialized.data.configuration,
    );
    if (!configuration.success || runtime !== undefined) {
      postError(initialized.data.requestId, 'invalid_configuration');
      return;
    }
    runtime = Object.freeze({
      runtimeId: initialized.data.runtimeId,
      driverId: initialized.data.driverId,
      configuration: configuration.data,
    });
    scope.postMessage({
      protocol: BROWSER_WORKER_PROTOCOL,
      kind: 'ready',
      requestId: initialized.data.requestId,
      runtimeId: initialized.data.runtimeId,
      driverId: initialized.data.driverId,
      capabilities: [configuration.data.operation],
    });
    return;
  }

  const aborted = abortSchema.safeParse(event.data);
  if (aborted.success) {
    if (aborted.data.runtimeId === runtime?.runtimeId) {
      controllers.get(aborted.data.requestId)?.abort();
    }
    return;
  }
  void invoke(event.data);
});
