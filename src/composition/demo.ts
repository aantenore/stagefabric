import { InProcessStageAdapter } from '../adapters/in-process-stage-adapter.js';
import {
  SensitiveDataGuard,
  type SensitiveDataPattern,
} from '../adapters/sensitive-data-guard.js';
import { StageAdapterRegistry } from '../adapters/stage-adapter-registry.js';
import { executePlan, type ExecutionResult } from '../application/executor.js';
import {
  planStageGraph,
  type ExecutionPlan,
  type PlanRequest,
} from '../application/planner.js';
import { fabricSchema, stageGraphSchema } from '../domain/schema.js';
import { sealCapabilitySnapshot } from '../domain/snapshot.js';
import { StageAdapterError } from '../ports/stage-adapter.js';
import type { StageInputGuard } from '../ports/stage-input-guard.js';

export const DEMO_EVALUATED_AT = '2026-07-15T12:00:00.000Z';
export const DEMO_INPUT =
  'Contact Ada at ada@example.com or +39 333 123 4567 about hybrid inference.';

const EMAIL_EXPRESSION = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const PHONE_EXPRESSION = /\+\d[\d .()-]{7,}\d/u;
const DEMO_PATTERNS: readonly SensitiveDataPattern[] = [
  { id: 'email', expression: EMAIL_EXPRESSION },
  { id: 'phone', expression: PHONE_EXPRESSION },
];

export interface DemoInvocation {
  readonly stageId: string;
  readonly targetId: string;
  readonly zone: string;
}

export interface DemoAudit {
  readonly invocations: DemoInvocation[];
  sensitiveObservedDownstream: boolean;
}

export interface DemoRuntime {
  readonly plan: ExecutionPlan;
  readonly adapters: StageAdapterRegistry;
  readonly guards: readonly StageInputGuard[];
  readonly audit: DemoAudit;
  readonly inputs: Readonly<Record<string, unknown>>;
}

export interface DemoRunResult {
  readonly planDigest: string;
  readonly egressDigest: string;
  readonly finalAnswer: string;
  readonly stageTargets: Readonly<Record<string, string>>;
  readonly fallbackObserved: boolean;
  readonly sentinelsReachedDownstream: boolean;
  readonly trace: ExecutionResult['trace'];
}

function hasSensitiveData(value: unknown): boolean {
  if (typeof value === 'string') {
    EMAIL_EXPRESSION.lastIndex = 0;
    PHONE_EXPRESSION.lastIndex = 0;
    return EMAIL_EXPRESSION.test(value) || PHONE_EXPRESSION.test(value);
  }
  if (Array.isArray(value)) return value.some(hasSensitiveData);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Readonly<Record<string, unknown>>).some(
      hasSensitiveData,
    );
  }
  return false;
}

function redact(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[email]')
    .replace(/\+\d[\d .()-]{7,}\d/gu, '[phone]');
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new StageAdapterError({ code: 'adapter_failure' });
  }
  return value;
}

export function createDemoPlanRequest(): PlanRequest {
  const fabric = fabricSchema.parse({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'Fabric',
    zones: [
      { id: 'browser', trustLevel: 3, residencies: ['EU'] },
      { id: 'local', trustLevel: 2, residencies: ['EU'] },
      { id: 'edge', trustLevel: 2, residencies: ['EU'] },
      { id: 'cloud', trustLevel: 1, residencies: ['EU'] },
    ],
    classifications: [
      { id: 'public', rank: 0, minTrustLevel: 0 },
      {
        id: 'internal',
        rank: 1,
        minTrustLevel: 2,
        allowedZones: ['browser', 'local', 'edge'],
      },
      { id: 'secret', rank: 2, minTrustLevel: 3, allowedZones: ['browser'] },
    ],
    targets: [
      {
        id: 'browser-runtime',
        zone: 'browser',
        adapter: { kind: 'demo' },
        capabilities: ['classify', 'privacy.redact', 'privacy.declassify'],
        expectedP95Ms: 3,
        costMicros: 0,
      },
      {
        id: 'local-embed',
        zone: 'local',
        adapter: { kind: 'demo' },
        capabilities: ['embed'],
        expectedP95Ms: 8,
        costMicros: 0,
      },
      {
        id: 'edge-retrieve-a',
        zone: 'edge',
        adapter: { kind: 'demo' },
        capabilities: ['retrieve', 'privacy.declassify'],
        expectedP95Ms: 12,
        costMicros: 1,
      },
      {
        id: 'edge-retrieve-b',
        zone: 'edge',
        adapter: { kind: 'demo' },
        capabilities: ['retrieve', 'privacy.declassify'],
        expectedP95Ms: 18,
        costMicros: 1,
      },
      {
        id: 'cloud-reason',
        zone: 'cloud',
        adapter: { kind: 'demo' },
        capabilities: ['reason'],
        expectedP95Ms: 30,
        costMicros: 8,
      },
    ],
    policy: {
      zonePreference: ['browser', 'local', 'edge', 'cloud'],
      maxFallbacks: 1,
    },
  });

  const snapshot = sealCapabilitySnapshot({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'CapabilitySnapshot',
    observedAt: '2026-07-15T11:00:00.000Z',
    expiresAt: '2026-07-15T13:00:00.000Z',
    targets: fabric.targets.map((target) => ({
      targetId: target.id,
      healthy: true,
      capabilities: target.capabilities,
    })),
  });

  const graph = stageGraphSchema.parse({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'StageGraph',
    metadata: { name: 'privacy-first-rag' },
    inputs: [
      {
        name: 'text',
        type: 'text/plain',
        classification: 'secret',
        residencies: ['EU'],
        origin: { zone: 'browser', targetId: 'browser-runtime' },
      },
    ],
    stages: [
      {
        id: 'classify',
        operation: 'classify',
        inputs: { text: { ref: 'input.text', type: 'text/plain' } },
        outputs: [
          { name: 'label', type: 'label/contact', classification: 'secret' },
        ],
        requirements: { capabilities: ['classify'] },
      },
      {
        id: 'redact',
        operation: 'redact',
        inputs: {
          text: { ref: 'input.text', type: 'text/plain' },
          label: { ref: 'classify.label', type: 'label/contact' },
        },
        outputs: [
          { name: 'safe', type: 'text/plain', classification: 'internal' },
        ],
        requirements: { capabilities: ['privacy.redact'] },
        declassifications: [
          {
            output: 'safe',
            toClassification: 'internal',
            authorityCapability: 'privacy.declassify',
            justification:
              'deterministic removal of configured direct identifiers',
          },
        ],
      },
      {
        id: 'embed',
        operation: 'embed',
        inputs: { text: { ref: 'redact.safe', type: 'text/plain' } },
        outputs: [
          { name: 'vector', type: 'vector/f32', classification: 'internal' },
        ],
        requirements: { capabilities: ['embed'] },
      },
      {
        id: 'retrieve',
        operation: 'retrieve',
        inputs: { vector: { ref: 'embed.vector', type: 'vector/f32' } },
        outputs: [
          { name: 'context', type: 'text/plain', classification: 'public' },
        ],
        requirements: { capabilities: ['retrieve'] },
        declassifications: [
          {
            output: 'context',
            toClassification: 'public',
            authorityCapability: 'privacy.declassify',
            justification:
              'retrieval returns only a public synthetic document identifier',
          },
        ],
      },
      {
        id: 'reason',
        operation: 'reason',
        inputs: { context: { ref: 'retrieve.context', type: 'text/plain' } },
        outputs: [
          { name: 'answer', type: 'text/plain', classification: 'public' },
        ],
        requirements: { capabilities: ['reason'] },
      },
    ],
  });

  return { fabric, snapshot, graph, evaluatedAt: DEMO_EVALUATED_AT };
}

export function createDemoRuntime(
  options: { leakyRedactor?: boolean } = {},
): DemoRuntime {
  const audit: DemoAudit = {
    invocations: [],
    sensitiveObservedDownstream: false,
  };
  const record = (
    stageId: string,
    targetId: string,
    zone: string,
    inputs: unknown,
  ): void => {
    audit.invocations.push({ stageId, targetId, zone });
    if (zone !== 'browser' && hasSensitiveData(inputs))
      audit.sensitiveObservedDownstream = true;
  };

  const adapter = new InProcessStageAdapter('demo', {
    classify: (request) => {
      record(request.stageId, request.targetId, request.zone, request.inputs);
      requireString(request.inputs.text);
      return { outputs: { label: 'contains-contact-data' } };
    },
    redact: (request) => {
      record(request.stageId, request.targetId, request.zone, request.inputs);
      const text = requireString(request.inputs.text);
      return {
        outputs: { safe: options.leakyRedactor === true ? text : redact(text) },
      };
    },
    embed: (request) => {
      record(request.stageId, request.targetId, request.zone, request.inputs);
      const text = requireString(request.inputs.text);
      const sum = Array.from(text).reduce(
        (total, character) => total + character.codePointAt(0)!,
        0,
      );
      return { outputs: { vector: [text.length / 100, (sum % 997) / 997] } };
    },
    'edge-retrieve-a:retrieve': (request) => {
      record(request.stageId, request.targetId, request.zone, request.inputs);
      throw new StageAdapterError({
        code: 'upstream_rejected',
        statusCode: 429,
        outputEmitted: false,
      });
    },
    'edge-retrieve-b:retrieve': (request) => {
      record(request.stageId, request.targetId, request.zone, request.inputs);
      return { outputs: { context: 'document:hybrid-ai-architecture' } };
    },
    reason: (request) => {
      record(request.stageId, request.targetId, request.zone, request.inputs);
      requireString(request.inputs.context);
      return {
        outputs: { answer: 'Privacy-safe hybrid inference completed.' },
      };
    },
  });

  const guard = new SensitiveDataGuard({
    patterns: DEMO_PATTERNS,
    inspectPlacement: ({ placement }) => placement.zone !== 'browser',
  });
  const planRequest = createDemoPlanRequest();
  return {
    plan: planStageGraph(planRequest),
    adapters: new StageAdapterRegistry([adapter]),
    guards: [guard],
    audit,
    inputs: { text: DEMO_INPUT },
  };
}

export async function runDemo(
  options: { leakyRedactor?: boolean } = {},
): Promise<DemoRunResult> {
  const runtime = createDemoRuntime(options);
  const result = await executePlan({
    plan: runtime.plan,
    adapters: runtime.adapters,
    guards: runtime.guards,
    inputs: runtime.inputs,
  });
  const finalAnswer = result.values['reason.answer'];
  if (typeof finalAnswer !== 'string') throw new Error('demo_answer_missing');

  return {
    planDigest: runtime.plan.digest,
    egressDigest: runtime.plan.egress.digest,
    finalAnswer,
    stageTargets: Object.fromEntries(
      result.stages.map((stage) => [stage.stageId, stage.targetId]),
    ),
    fallbackObserved: result.trace.some(
      (event) => event.reasonCode === 'retryable_pre_output_status',
    ),
    sentinelsReachedDownstream: runtime.audit.sensitiveObservedDownstream,
    trace: result.trace,
  };
}
