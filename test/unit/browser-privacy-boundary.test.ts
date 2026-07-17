import { describe, expect, it } from 'vitest';

import type { Sha256Digest } from '../../src/browser/crypto.js';
import {
  BrowserEgressGate,
  EgressDeniedError,
} from '../../src/browser/egress-gate.js';
import {
  PRIVACY_DECISION_RECEIPT_VERSION,
  issuePrivacyDecisionReceipt,
  privacyDecisionReceiptContentSchema,
  verifyPrivacyDecisionReceipt,
} from '../../src/browser/privacy-receipt.js';
import {
  RedactionCascadeError,
  redactWithCascade,
  verifyRedactionResult,
  verifyRedactedOutput,
  type RedactionCascadeResult,
  type RedactionCascadePolicy,
  type SensitiveSpanClassifier,
} from '../../src/browser/redaction.js';

const bindingsDigest = `sha256:${'a'.repeat(64)}` as Sha256Digest;
const redactionDigest = `sha256:${'b'.repeat(64)}` as Sha256Digest;
const egressDigest = `sha256:${'c'.repeat(64)}` as Sha256Digest;

function policy(classifier?: SensitiveSpanClassifier): RedactionCascadePolicy {
  return {
    policyId: 'redaction-v1',
    policyDigest: redactionDigest,
    executionBoundary: 'dedicated-worker',
    maxInputCodeUnits: 10_000,
    maxCandidateSpans: 100,
    defaultClassifierReplacement: '<PRIVATE>',
    classifierReplacements: { account: '<ACCOUNT>' },
    rules: [
      {
        ruleId: 'email-rule',
        category: 'email',
        priority: 10,
        pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+',
        replacement: '<EMAIL>',
      },
    ],
    ...(classifier === undefined
      ? {}
      : { classifiers: [{ classifier, priority: 20 }] }),
  };
}

describe('deterministic redaction and receipt boundary', () => {
  it('resolves overlapping rules/classifier spans deterministically', async () => {
    const classifier: SensitiveSpanClassifier = {
      classifierId: 'account-classifier',
      classify: async (input) => [
        {
          start: input.indexOf('1234'),
          end: input.indexOf('1234') + 4,
          category: 'account',
        },
      ],
    };
    const result = await redactWithCascade(
      'Contact alice@example.test, account 1234.',
      policy(classifier),
    );
    expect(result.output).toBe('Contact <EMAIL>, account <ACCOUNT>.');
    expect(result.redactions.map((item) => item.sourceId)).toEqual([
      'email-rule',
      'account-classifier',
    ]);

    const baseReversed = policy(classifier);
    const reversed: RedactionCascadePolicy = {
      ...baseReversed,
      rules: [...baseReversed.rules].reverse(),
    };
    expect(
      await redactWithCascade(
        'Contact alice@example.test, account 1234.',
        reversed,
      ),
    ).toEqual(result);
  });

  it('requires a complete post-output rescan before issuing a content-free receipt', async () => {
    const result = await redactWithCascade('alice@example.test', policy());
    const verification = await verifyRedactionResult(result, policy());
    const receipt = await issuePrivacyDecisionReceipt({
      decisionId: 'decision-1',
      planId: 'plan-1',
      runtimeId: 'runtime-1',
      operation: 'sanitize',
      bindingsDigest,
      redactionPolicyId: 'redaction-v1',
      redactionPolicyDigest: redactionDigest,
      egressPolicyId: 'egress-v1',
      egressPolicyDigest: egressDigest,
      redactionResult: result,
      outputVerification: verification,
    });

    expect(await verifyPrivacyDecisionReceipt(receipt)).toBe(true);
    expect(receipt.outputDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.summary).toMatchObject({
      evaluatedRuleIds: ['email-rule'],
      evaluatedClassifierIds: [],
      appliedRuleIds: ['email-rule'],
      appliedClassifierIds: [],
    });
    expect(receipt).not.toHaveProperty('inputDigest');
    expect(JSON.stringify(receipt)).not.toContain('alice@example.test');
    expect(JSON.stringify(receipt)).not.toContain('<EMAIL>');

    const forgedResult = {
      ...result,
      redactions: [
        {
          start: 0,
          end: 1,
          category: 'fabricated',
          sourceKind: 'rule' as const,
          sourceId: 'never-evaluated',
          priority: 1,
        },
      ],
    } as RedactionCascadeResult;
    await expect(
      issuePrivacyDecisionReceipt({
        decisionId: 'decision-2',
        planId: 'plan-1',
        runtimeId: 'runtime-1',
        operation: 'sanitize',
        bindingsDigest,
        redactionPolicyId: 'redaction-v1',
        redactionPolicyDigest: redactionDigest,
        egressPolicyId: 'egress-v1',
        egressPolicyDigest: egressDigest,
        redactionResult: forgedResult,
        outputVerification: verification,
      }),
    ).rejects.toThrow('redacted_output_not_verified');
  });

  it('binds verification to the exact policy source set', async () => {
    const sourcePolicy: RedactionCascadePolicy = {
      ...policy(),
      rules: [{ ...policy().rules[0]!, ruleId: 'rule-a' }],
    };
    const result = await redactWithCascade('alice@example.test', sourcePolicy);
    const differentSources: RedactionCascadePolicy = {
      ...sourcePolicy,
      rules: [{ ...sourcePolicy.rules[0]!, ruleId: 'rule-b' }],
    };

    await expect(
      verifyRedactionResult(result, differentSources),
    ).rejects.toMatchObject({ code: 'invalid_redaction_result' });
  });

  it('rejects receipt summaries with applied sources that were not evaluated', () => {
    const parsed = privacyDecisionReceiptContentSchema.safeParse({
      apiVersion: PRIVACY_DECISION_RECEIPT_VERSION,
      kind: 'PrivacyDecisionReceipt',
      decisionId: 'decision-1',
      planId: 'plan-1',
      runtimeId: 'runtime-1',
      operation: 'sanitize',
      bindingsDigest,
      redactionPolicyId: 'redaction-v1',
      redactionPolicyDigest: redactionDigest,
      egressPolicyId: 'egress-v1',
      egressPolicyDigest: egressDigest,
      outputDigest: bindingsDigest,
      summary: {
        redactionCount: 2,
        evaluatedRuleIds: ['rule-a'],
        evaluatedClassifierIds: ['classifier-a'],
        appliedRuleIds: ['rule-b'],
        appliedClassifierIds: ['classifier-b'],
        categories: ['private'],
      },
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected invalid receipt summary');
    expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toEqual(
      expect.arrayContaining([
        'summary.appliedRuleIds',
        'summary.appliedClassifierIds',
      ]),
    );
  });

  it('fails post-output verification when a replacement still matches policy', async () => {
    const unsafe: RedactionCascadePolicy = {
      ...policy(),
      rules: [
        {
          ruleId: 'secret-rule',
          category: 'secret',
          priority: 1,
          pattern: 'secret',
          replacement: 'secret',
        },
      ],
    };
    const result = await redactWithCascade('secret', unsafe);
    await expect(
      verifyRedactedOutput(result.output, unsafe),
    ).rejects.toMatchObject({
      code: 'invalid_policy',
    });
  });

  it('snapshots policy and receipt inputs before asynchronous work', async () => {
    let finishClassification: (spans: readonly never[]) => void = () =>
      undefined;
    const classifier: SensitiveSpanClassifier = {
      classifierId: 'delayed-classifier',
      classify: () =>
        new Promise((resolve) => {
          finishClassification = resolve;
        }),
    };
    const mutablePolicy = policy(classifier);
    const redactionPromise = redactWithCascade(
      'alice@example.test',
      mutablePolicy,
    );
    (mutablePolicy as { policyId: string }).policyId = 'mutated-policy';
    (mutablePolicy.rules[0] as { replacement: string }).replacement =
      '<MUTATED>';
    finishClassification([]);

    const result = await redactionPromise;
    expect(result).toMatchObject({
      output: '<EMAIL>',
      policyId: 'redaction-v1',
    });

    const verification = await verifyRedactionResult(
      result,
      policy({
        classifierId: 'delayed-classifier',
        classify: async () => [],
      }),
    );
    const mutableRequest = {
      decisionId: 'decision-before-await',
      planId: 'plan-1',
      runtimeId: 'runtime-1',
      operation: 'sanitize',
      bindingsDigest,
      redactionPolicyId: 'redaction-v1',
      redactionPolicyDigest: redactionDigest,
      egressPolicyId: 'egress-v1',
      egressPolicyDigest: egressDigest,
      redactionResult: result,
      outputVerification: verification,
    };
    const receiptPromise = issuePrivacyDecisionReceipt(mutableRequest);
    mutableRequest.decisionId = 'decision-after-await';

    await expect(receiptPromise).resolves.toMatchObject({
      decisionId: 'decision-before-await',
      summary: { redactionCount: 1, appliedRuleIds: ['email-rule'] },
    });
  });

  it('rejects invalid classifier offsets, input overflow and aborted work', async () => {
    const invalid: SensitiveSpanClassifier = {
      classifierId: 'invalid-classifier',
      classify: async () => [{ start: 1, end: 2, category: 'private' }],
    };
    await expect(
      redactWithCascade('😀', policy(invalid)),
    ).rejects.toMatchObject({
      code: 'invalid_classifier_span',
    });

    const bounded: RedactionCascadePolicy = {
      ...policy(),
      maxInputCodeUnits: 2,
    };
    await expect(redactWithCascade('too long', bounded)).rejects.toMatchObject({
      code: 'input_limit_exceeded',
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      redactWithCascade('value', policy(), { signal: controller.signal }),
    ).rejects.toBeInstanceOf(RedactionCascadeError);
  });

  it('rejects malformed classifier span records without invoking getters', async () => {
    const undefinedSpanClassifier: SensitiveSpanClassifier = {
      classifierId: 'undefined-span-classifier',
      classify: async () =>
        [undefined] as unknown as readonly {
          start: number;
          end: number;
          category: string;
        }[],
    };
    await expect(
      redactWithCascade('value', policy(undefinedSpanClassifier)),
    ).rejects.toMatchObject({ code: 'invalid_classifier_span' });

    let getterCalls = 0;
    const getterSpan = {};
    for (const field of ['start', 'end', 'category'] as const) {
      Object.defineProperty(getterSpan, field, {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return field === 'start' ? 0 : field === 'end' ? 1 : 'private';
        },
      });
    }
    const getterSpanClassifier: SensitiveSpanClassifier = {
      classifierId: 'getter-span-classifier',
      classify: async () =>
        [getterSpan] as unknown as readonly {
          start: number;
          end: number;
          category: string;
        }[],
    };
    await expect(
      redactWithCascade('value', policy(getterSpanClassifier)),
    ).rejects.toMatchObject({ code: 'invalid_classifier_span' });
    expect(getterCalls).toBe(0);
  });

  it('rejects undefined policy source identifiers without string coercion', async () => {
    await expect(
      redactWithCascade('value', {
        ...policy(),
        policyId: undefined,
      } as unknown as RedactionCascadePolicy),
    ).rejects.toMatchObject({ code: 'invalid_policy' });

    await expect(
      redactWithCascade('value', {
        ...policy(),
        rules: [{ ...policy().rules[0]!, ruleId: undefined }],
      } as unknown as RedactionCascadePolicy),
    ).rejects.toMatchObject({ code: 'invalid_rule' });

    const classifier: SensitiveSpanClassifier = {
      classifierId: undefined as unknown as string,
      classify: async () => [],
    };
    await expect(
      redactWithCascade('value', policy(classifier)),
    ).rejects.toMatchObject({ code: 'invalid_policy' });
  });

  it('bounds the number of configured rule and classifier sources', async () => {
    const excessiveRules: RedactionCascadePolicy = {
      ...policy(),
      rules: Array.from({ length: 4_097 }, (_, index) => ({
        ruleId: `rule-${index}`,
        category: 'private',
        priority: 1,
        pattern: 'never-match',
        replacement: '<PRIVATE>',
      })),
    };
    await expect(
      redactWithCascade('value', excessiveRules),
    ).rejects.toMatchObject({ code: 'invalid_policy' });

    const classifier: SensitiveSpanClassifier = {
      classifierId: 'placeholder',
      classify: async () => [],
    };
    const excessiveClassifiers: RedactionCascadePolicy = {
      ...policy(),
      classifiers: Array.from({ length: 4_097 }, (_, index) => ({
        classifier: { ...classifier, classifierId: `classifier-${index}` },
        priority: 1,
      })),
    };
    await expect(
      verifyRedactedOutput('value', excessiveClassifiers),
    ).rejects.toMatchObject({ code: 'invalid_policy' });

    const sparseRules = [] as RedactionCascadePolicy['rules'][number][];
    sparseRules.length = 1_000_000_000;
    await expect(
      redactWithCascade('value', { ...policy(), rules: sparseRules }),
    ).rejects.toMatchObject({ code: 'invalid_policy' });

    let iteratorPulls = 0;
    const customIterableRules = [] as RedactionCascadePolicy['rules'][number][];
    Object.defineProperty(customIterableRules, Symbol.iterator, {
      value: function* () {
        while (iteratorPulls < 5_000) {
          iteratorPulls += 1;
          yield policy().rules[0]!;
        }
      },
    });
    await expect(
      verifyRedactedOutput('value', {
        ...policy(),
        rules: customIterableRules,
      }),
    ).rejects.toMatchObject({ code: 'invalid_policy' });
    expect(iteratorPulls).toBe(0);

    const replacements = Object.fromEntries(
      Array.from({ length: 4_097 }, (_, index) => [
        `category-${index}`,
        '<PRIVATE>',
      ]),
    );
    let replacementDescriptorReads = 0;
    const excessiveReplacements = new Proxy(replacements, {
      getOwnPropertyDescriptor: (target, property) => {
        replacementDescriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    await expect(
      redactWithCascade('value', {
        ...policy(),
        classifierReplacements: excessiveReplacements,
      }),
    ).rejects.toMatchObject({ code: 'invalid_policy' });
    expect(replacementDescriptorReads).toBe(0);
  });
});

describe('fail-closed egress gate', () => {
  async function receipt() {
    const result = await redactWithCascade('alice@example.test', policy());
    const outputVerification = await verifyRedactionResult(result, policy());
    return {
      output: result.output,
      receipt: await issuePrivacyDecisionReceipt({
        decisionId: 'decision-1',
        planId: 'plan-1',
        runtimeId: 'runtime-1',
        operation: 'sanitize',
        bindingsDigest,
        redactionPolicyId: 'redaction-v1',
        redactionPolicyDigest: redactionDigest,
        egressPolicyId: 'egress-v1',
        egressPolicyDigest: egressDigest,
        redactionResult: result,
        outputVerification,
      }),
    };
  }

  function gate(operation = 'sanitize') {
    return new BrowserEgressGate({
      decisionId: 'decision-1',
      planId: 'plan-1',
      runtimeId: 'runtime-1',
      operation,
      bindingsDigest,
      redactionPolicyId: 'redaction-v1',
      redactionPolicyDigest: redactionDigest,
      redactionRuleIds: ['email-rule'],
      redactionClassifierIds: [],
      egressPolicyId: 'egress-v1',
      egressPolicyDigest: egressDigest,
    });
  }

  it('rejects ambiguous redaction source bindings', () => {
    expect(
      () =>
        new BrowserEgressGate({
          decisionId: 'decision-1',
          planId: 'plan-1',
          runtimeId: 'runtime-1',
          operation: 'sanitize',
          bindingsDigest,
          redactionPolicyId: 'redaction-v1',
          redactionPolicyDigest: redactionDigest,
          redactionRuleIds: ['shared-source'],
          redactionClassifierIds: ['shared-source'],
          egressPolicyId: 'egress-v1',
          egressPolicyDigest: egressDigest,
        }),
    ).toThrow('invalid_egress_policy_binding');
  });

  it('authorizes only the exact digest, policy and lineage tuple', async () => {
    const issued = await receipt();
    await expect(
      gate().authorize(issued.output, issued.receipt),
    ).resolves.toMatchObject({
      kind: 'BrowserEgressPermit',
      planId: 'plan-1',
      runtimeId: 'runtime-1',
      operation: 'sanitize',
    });
    await expect(
      gate().authorize(`${issued.output}!`, issued.receipt),
    ).rejects.toMatchObject({
      reasonCode: 'output_digest_mismatch',
    });
    await expect(
      gate('other-operation').authorize(issued.output, issued.receipt),
    ).rejects.toMatchObject({
      reasonCode: 'lineage_mismatch',
    });
  });

  it('rejects a structurally valid but tampered receipt', async () => {
    const issued = await receipt();
    const tampered = structuredClone(issued.receipt);
    tampered.egressPolicyId = 'other-egress';
    await expect(
      gate().authorize(issued.output, tampered),
    ).rejects.toBeInstanceOf(EgressDeniedError);
  });

  it('uses one detached receipt snapshot across asynchronous verification', async () => {
    const issued = await receipt();
    const mutable = structuredClone(issued.receipt);
    const authorization = gate().authorize(issued.output, mutable);
    mutable.decisionId = 'decision-mutated-after-call';

    await expect(authorization).resolves.toMatchObject({
      decisionId: 'decision-1',
    });
  });
});
