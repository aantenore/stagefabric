import { z } from 'zod';

import {
  browserRuntimeBindingsSchema,
  verifyBrowserRuntimeBindings,
  type BrowserRuntimeBindings,
} from './bindings.js';
import {
  probeBrowserCapabilities,
  type BrowserCapabilityProbeEnvironment,
  type BrowserCapabilitySnapshot,
} from './capability-probe.js';
import { type Sha256Digest } from './crypto.js';
import {
  BrowserEgressGate,
  EgressDeniedError,
  type BrowserEgressPermit,
} from './egress-gate.js';
import {
  projectBrowserPrivacyLedger,
  projectBrowserPrivacyPlan,
  type BrowserPrivacyLedgerProjection,
  type BrowserPrivacyPlanProjection,
} from './explainability.js';
import {
  privacyDecisionReceiptSchema,
  type PrivacyDecisionReceipt,
} from './privacy-receipt.js';
import type {
  BrowserRuntimeDriverResolver,
  BrowserRuntimeSession,
} from './runtime-driver.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const workerResultSchema = z
  .object({
    apiVersion: z.literal('stagefabric.dev/browser-privacy-worker/v1'),
    kind: z.literal('BrowserPrivacyWorkerResult'),
    output: z.string(),
    receipt: privacyDecisionReceiptSchema,
  })
  .strict();

function deepFreezeSnapshot<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (Object.hasOwn(descriptor, 'value')) {
      deepFreezeSnapshot(descriptor.value, seen);
    }
  }
  return Object.freeze(value);
}

function exceedsUtf8ByteLimit(value: string, maxBytes: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) bytes += 1;
    else if (codeUnit <= 0x7ff) bytes += 2;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes > maxBytes) return true;
  }
  return false;
}

async function closeRuntimeSession(
  session: BrowserRuntimeSession | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (session === undefined) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => session.close()),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('runtime_cleanup_timeout')),
          timeoutMs,
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type BrowserPrivacyBridgeFailureCode =
  | 'bindings_invalid'
  | 'capability_unavailable'
  | 'egress_denied'
  | 'execution_failed'
  | 'input_limit_exceeded'
  | 'invalid_request'
  | 'invalid_worker_result'
  | 'output_limit_exceeded'
  | 'runtime_not_bound'
  | 'runtime_not_registered';

export class BrowserPrivacyBridgeError extends Error {
  readonly code: BrowserPrivacyBridgeFailureCode;
  readonly ledger: BrowserPrivacyLedgerProjection | undefined;

  constructor(
    code: BrowserPrivacyBridgeFailureCode,
    ledger?: BrowserPrivacyLedgerProjection,
  ) {
    super(code);
    this.name = 'BrowserPrivacyBridgeError';
    this.code = code;
    this.ledger = ledger;
  }
}

export interface BrowserPrivacyBridgeRequest {
  readonly planId: string;
  readonly decisionId: string;
  readonly runtimeId: string;
  readonly operation: string;
  readonly input: string;
  readonly signal?: AbortSignal;
}

export interface BrowserPrivacyBridgeResult {
  readonly output: string;
  readonly receipt: PrivacyDecisionReceipt;
  readonly permit: BrowserEgressPermit;
  readonly capability: BrowserCapabilitySnapshot;
  readonly plan: BrowserPrivacyPlanProjection;
  readonly ledger: BrowserPrivacyLedgerProjection;
}

export interface BrowserPrivacyBridgeOptions {
  readonly bindings: BrowserRuntimeBindings;
  readonly drivers: BrowserRuntimeDriverResolver;
  readonly capabilityEnvironment?: BrowserCapabilityProbeEnvironment;
}

/**
 * Cohesive fail-closed host boundary. The worker must use this package's
 * redaction verification + receipt issuer before returning its strict result.
 */
export class BrowserPrivacyBridge {
  readonly #bindings: BrowserRuntimeBindings | undefined;
  readonly #drivers: BrowserRuntimeDriverResolver;
  readonly #capabilityEnvironment:
    BrowserCapabilityProbeEnvironment | undefined;

  constructor(options: BrowserPrivacyBridgeOptions) {
    const parsed = browserRuntimeBindingsSchema.safeParse(options.bindings);
    this.#bindings = parsed.success
      ? deepFreezeSnapshot(parsed.data)
      : undefined;
    this.#drivers = options.drivers;
    this.#capabilityEnvironment = options.capabilityEnvironment;
  }

  async execute(
    request: BrowserPrivacyBridgeRequest,
  ): Promise<BrowserPrivacyBridgeResult> {
    let executionRequest: BrowserPrivacyBridgeRequest;
    try {
      const signal = request.signal;
      executionRequest = Object.freeze({
        planId: request.planId,
        decisionId: request.decisionId,
        runtimeId: request.runtimeId,
        operation: request.operation,
        input: request.input,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      throw new BrowserPrivacyBridgeError('invalid_request');
    }
    const bindings = this.#bindings;
    if (
      bindings === undefined ||
      !(await verifyBrowserRuntimeBindings(bindings))
    ) {
      throw new BrowserPrivacyBridgeError('bindings_invalid');
    }
    if (
      !SAFE_ID.test(executionRequest.planId) ||
      !SAFE_ID.test(executionRequest.decisionId) ||
      !SAFE_ID.test(executionRequest.runtimeId) ||
      !SAFE_ID.test(executionRequest.operation) ||
      typeof executionRequest.input !== 'string'
    ) {
      throw new BrowserPrivacyBridgeError('invalid_request');
    }
    const policy = bindings.policy;
    if (exceedsUtf8ByteLimit(executionRequest.input, policy.maxInputBytes)) {
      throw new BrowserPrivacyBridgeError('input_limit_exceeded');
    }
    const runtime = bindings.runtimes.find(
      (candidate) => candidate.runtimeId === executionRequest.runtimeId,
    );
    if (runtime === undefined) {
      throw new BrowserPrivacyBridgeError('runtime_not_bound');
    }

    let plan: BrowserPrivacyPlanProjection;
    try {
      plan = await projectBrowserPrivacyPlan({
        planId: executionRequest.planId,
        bindings,
        runtimeId: executionRequest.runtimeId,
        operation: executionRequest.operation,
      });
    } catch {
      throw new BrowserPrivacyBridgeError('invalid_request');
    }
    const capability =
      this.#capabilityEnvironment === undefined
        ? await probeBrowserCapabilities(runtime.requirements, undefined, {
            timeoutMs: policy.capabilityProbeTimeoutMs,
          })
        : await probeBrowserCapabilities(
            runtime.requirements,
            this.#capabilityEnvironment,
            { timeoutMs: policy.capabilityProbeTimeoutMs },
          );
    if (!capability.eligible) {
      const ledger = await projectBrowserPrivacyLedger({
        plan,
        capability,
        egress: {
          outcome: 'denied',
          reasonCode: 'capability_unavailable',
        },
      });
      throw new BrowserPrivacyBridgeError('capability_unavailable', ledger);
    }

    const driver = this.#drivers.get(runtime.driverId);
    if (driver === undefined) {
      const ledger = await projectBrowserPrivacyLedger({
        plan,
        capability,
        egress: { outcome: 'denied', reasonCode: 'runtime_not_registered' },
      });
      throw new BrowserPrivacyBridgeError('runtime_not_registered', ledger);
    }

    let workerValue: unknown;
    let session;
    let closeFailed = false;
    try {
      session = driver.open(runtime);
      const readiness = await session.ready({
        timeoutMs: policy.workerReadyTimeoutMs,
        ...(executionRequest.signal === undefined
          ? {}
          : { signal: executionRequest.signal }),
      });
      if (
        readiness.runtimeId !== executionRequest.runtimeId ||
        readiness.driverId !== runtime.driverId ||
        !readiness.capabilities.includes(executionRequest.operation)
      ) {
        throw new Error('runtime_readiness_mismatch');
      }
      workerValue = await session.invoke({
        operation: executionRequest.operation,
        timeoutMs: policy.invocationTimeoutMs,
        ...(executionRequest.signal === undefined
          ? {}
          : { signal: executionRequest.signal }),
        input: {
          apiVersion: 'stagefabric.dev/browser-privacy-worker/v1',
          kind: 'BrowserPrivacyWorkerRequest',
          decisionId: executionRequest.decisionId,
          planId: executionRequest.planId,
          runtimeId: executionRequest.runtimeId,
          operation: executionRequest.operation,
          bindingsDigest: bindings.digest,
          redactionPolicyId: policy.redactionPolicyId,
          redactionPolicyDigest: policy.redactionPolicyDigest,
          egressPolicyId: policy.egressPolicyId,
          egressPolicyDigest: policy.egressPolicyDigest,
          input: executionRequest.input,
        },
      });
    } catch {
      const ledger = await projectBrowserPrivacyLedger({
        plan,
        capability,
        egress: { outcome: 'denied', reasonCode: 'execution_failed' },
      });
      throw new BrowserPrivacyBridgeError('execution_failed', ledger);
    } finally {
      closeFailed = !(await closeRuntimeSession(
        session,
        policy.cleanupTimeoutMs,
      ));
    }
    if (closeFailed) {
      const ledger = await projectBrowserPrivacyLedger({
        plan,
        capability,
        egress: { outcome: 'denied', reasonCode: 'execution_failed' },
      });
      throw new BrowserPrivacyBridgeError('execution_failed', ledger);
    }

    let workerResult: z.infer<typeof workerResultSchema> | undefined;
    try {
      const parsed = workerResultSchema.safeParse(workerValue);
      if (parsed.success) workerResult = parsed.data;
    } catch {
      workerResult = undefined;
    }
    if (
      workerResult === undefined ||
      workerResult.receipt.decisionId !== executionRequest.decisionId
    ) {
      const ledger = await projectBrowserPrivacyLedger({
        plan,
        capability,
        egress: { outcome: 'denied', reasonCode: 'invalid_worker_result' },
      });
      throw new BrowserPrivacyBridgeError('invalid_worker_result', ledger);
    }
    if (exceedsUtf8ByteLimit(workerResult.output, policy.maxOutputBytes)) {
      const ledger = await projectBrowserPrivacyLedger({
        plan,
        capability,
        egress: { outcome: 'denied', reasonCode: 'output_limit_exceeded' },
      });
      throw new BrowserPrivacyBridgeError('output_limit_exceeded', ledger);
    }

    const gate = new BrowserEgressGate({
      decisionId: executionRequest.decisionId,
      planId: executionRequest.planId,
      runtimeId: executionRequest.runtimeId,
      operation: executionRequest.operation,
      bindingsDigest: bindings.digest as Sha256Digest,
      redactionPolicyId: policy.redactionPolicyId,
      redactionPolicyDigest: policy.redactionPolicyDigest as Sha256Digest,
      redactionRuleIds: policy.redactionRuleIds,
      redactionClassifierIds: policy.redactionClassifierIds,
      egressPolicyId: policy.egressPolicyId,
      egressPolicyDigest: policy.egressPolicyDigest as Sha256Digest,
    });
    let permit: BrowserEgressPermit;
    try {
      permit = await gate.authorize(workerResult.output, workerResult.receipt);
    } catch (error) {
      const reasonCode =
        error instanceof EgressDeniedError
          ? error.reasonCode
          : ('invalid_receipt' as const);
      const ledger = await projectBrowserPrivacyLedger({
        plan,
        capability,
        egress: { outcome: 'denied', reasonCode },
      });
      throw new BrowserPrivacyBridgeError('egress_denied', ledger);
    }

    const ledger = await projectBrowserPrivacyLedger({
      plan,
      capability,
      receipt: workerResult.receipt,
      egress: { outcome: 'authorized', permit },
    });
    return Object.freeze({
      output: workerResult.output,
      receipt: workerResult.receipt,
      permit,
      capability,
      plan,
      ledger,
    });
  }
}
