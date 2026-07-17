import { describe, expect, it } from 'vitest';

import { executePlan, ExecutionError } from '../../src/application/executor.js';
import {
  createDemoRuntime,
  DEMO_INPUT,
  runDemo,
} from '../../src/composition/demo.js';

describe('StageFabric demo', () => {
  it('runs five placed stages, fails over retrieval, and never sends the sentinels downstream', async () => {
    const result = await runDemo();

    expect(result.stageTargets).toEqual({
      classify: 'browser-runtime',
      redact: 'browser-runtime',
      embed: 'local-embed',
      retrieve: 'edge-retrieve-b',
      reason: 'cloud-reason',
    });
    expect(result.fallbackObserved).toBe(true);
    expect(result.sentinelsReachedDownstream).toBe(false);
    expect(JSON.stringify(result.trace)).not.toContain('ada@example.com');
    expect(JSON.stringify(result.trace)).not.toContain('+39 333 123 4567');
  });

  it('fails closed before any downstream adapter when the redactor is leaky', async () => {
    const runtime = createDemoRuntime({ leakyRedactor: true });
    let caught: unknown;
    try {
      await executePlan({
        plan: runtime.plan,
        inputs: runtime.inputs,
        adapters: runtime.adapters,
        guards: runtime.guards,
        outputVerifier: runtime.outputVerifier,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ExecutionError);
    expect(caught).toMatchObject({
      code: 'output_policy_rejected',
      stageId: 'redact',
      reasonCode: 'declassification_verification_failed',
    });
    expect(
      runtime.audit.invocations.map((invocation) => invocation.stageId),
    ).toEqual(['classify', 'redact']);
    expect(runtime.audit.sensitiveObservedDownstream).toBe(false);
    expect(JSON.stringify((caught as ExecutionError).trace)).not.toContain(
      DEMO_INPUT,
    );
  });
});
