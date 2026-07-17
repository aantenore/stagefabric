import { describe, expect, it } from 'vitest';

import { SensitiveDataGuard } from '../../src/adapters/sensitive-data-guard.js';
import {
  StageInputPolicyError,
  type StageInputGuardRequest,
} from '../../src/ports/stage-input-guard.js';

function request(inputs: Record<string, unknown>): StageInputGuardRequest {
  return {
    stageId: 'redact',
    operation: 'redact',
    placement: {
      targetId: 'browser',
      zone: 'browser',
      adapterKind: 'browser',
    },
    inputs,
  };
}

function guard(
  maxNodes?: number,
  maxDepth?: number,
  maxStringBytes?: number,
): SensitiveDataGuard {
  return new SensitiveDataGuard({
    patterns: [{ id: 'secret', expression: /SECRET-[0-9]+/g }],
    inspectPlacement: () => true,
    ...(maxNodes === undefined ? {} : { maxNodes }),
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(maxStringBytes === undefined ? {} : { maxStringBytes }),
  });
}

function expectPolicyReason(run: () => void, reasonCode: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(StageInputPolicyError);
    expect((error as StageInputPolicyError).reasonCode).toBe(reasonCode);
    return;
  }
  throw new Error('expected policy rejection');
}

describe('SensitiveDataGuard', () => {
  it('detects nested sensitive strings deterministically with stateful regexes', () => {
    const instance = guard();
    const input = request({ nested: [{ value: 'SECRET-42' }] });

    expectPolicyReason(
      () => instance.inspect(input),
      'sensitive_data_detected',
    );
    expectPolicyReason(
      () => instance.inspect(input),
      'sensitive_data_detected',
    );
  });

  it('detects sensitive data encoded in property names', () => {
    expectPolicyReason(
      () => guard().inspect(request({ nested: { 'SECRET-42': true } })),
      'sensitive_data_detected',
    );
  });

  it('copies configured patterns so later caller mutation cannot disable policy', () => {
    const expression = /SECRET-[0-9]+/;
    const instance = new SensitiveDataGuard({
      patterns: [{ id: 'secret', expression }],
      inspectPlacement: () => true,
    });
    expression.compile('NEVER-MATCH');

    expectPolicyReason(
      () => instance.inspect(request({ value: 'SECRET-7' })),
      'sensitive_data_detected',
    );
  });

  it('rejects accessors without invoking them', () => {
    let getterCalls = 0;
    const value = {} as Record<string, unknown>;
    Object.defineProperty(value, 'secret', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'SECRET-1';
      },
    });

    expectPolicyReason(
      () => guard().inspect(request({ value })),
      'inspection_unsafe_value',
    );
    expect(getterCalls).toBe(0);
  });

  it('rejects custom prototypes and cyclic input', () => {
    const customPrototype = Object.assign(
      Object.create({ inherited: 'SECRET-1' }),
      { value: 'safe' },
    );
    expectPolicyReason(
      () => guard().inspect(request({ customPrototype })),
      'inspection_unsafe_value',
    );

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expectPolicyReason(
      () => guard().inspect(request({ cyclic })),
      'inspection_cycle_detected',
    );
  });

  it('fails closed when the node or depth budget is exceeded', () => {
    expectPolicyReason(
      () => guard(2, 10).inspect(request({ first: 'safe', second: 'safe' })),
      'inspection_limit_exceeded',
    );
    expectPolicyReason(
      () =>
        guard(100, 2).inspect(
          request({ first: { second: { third: 'safe' } } }),
        ),
      'inspection_limit_exceeded',
    );
  });

  it('enforces the per-string UTF-8 byte ceiling without scanning for matches', () => {
    expectPolicyReason(
      () => guard(100, 10, 3).inspect(request({ v: 'safe' })),
      'inspection_string_limit_exceeded',
    );
    expectPolicyReason(
      () => guard(100, 10, 3).inspect(request({ v: 'éé' })),
      'inspection_string_limit_exceeded',
    );
    expect(() => guard(100, 10, 4).inspect(request({ v: 'éé' }))).not.toThrow();
  });

  it('validates configured limits and rejects RegExp subclasses', () => {
    expect(() => guard(0, 10)).toThrow('sensitive_data_guard_limit_invalid');
    expect(() => guard(10, 10, 0)).toThrow(
      'sensitive_data_guard_limit_invalid',
    );
    class CustomRegExp extends RegExp {}
    expect(
      () =>
        new SensitiveDataGuard({
          patterns: [
            { id: 'custom', expression: new CustomRegExp('SECRET-[0-9]+') },
          ],
          inspectPlacement: () => true,
        }),
    ).toThrow('sensitive_data_pattern_invalid');
  });

  it('rejects decorated RegExp objects without invoking accessors', () => {
    let getterCalls = 0;
    const expression = /SECRET-[0-9]+/;
    Object.defineProperty(expression, 'source', {
      configurable: true,
      get() {
        getterCalls += 1;
        return '.*';
      },
    });

    expect(
      () =>
        new SensitiveDataGuard({
          patterns: [{ id: 'secret', expression }],
          inspectPlacement: () => true,
        }),
    ).toThrow('sensitive_data_pattern_invalid');
    expect(getterCalls).toBe(0);
  });
});
