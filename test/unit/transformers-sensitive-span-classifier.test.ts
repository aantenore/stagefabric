import { describe, expect, it, vi } from 'vitest';

import {
  TransformersSensitiveSpanClassifier,
  TransformersSensitiveSpanClassifierError,
  type TransformersPipelineFactory,
  type TransformersSensitiveSpanClassifierConfig,
  type TransformersTokenClassificationPipeline,
} from '../../src/browser/drivers/transformers/sensitive-span-classifier.js';

const MODEL_REVISION = '8a5d64f08a5d64f08a5d64f08a5d64f08a5d64f0';

const configuration = (): TransformersSensitiveSpanClassifierConfig => ({
  classifierId: 'privacy.ner',
  modelId: 'operator/privacy-ner',
  revision: MODEL_REVISION,
  device: 'webgpu',
  dtype: 'q8',
  task: 'token-classification',
  labelToCategory: {
    EMAIL: 'email',
    PERSON: 'person',
  },
  threshold: 0.75,
});

function fakePipeline(
  implementation: TransformersTokenClassificationPipeline,
): {
  readonly factory: TransformersPipelineFactory;
  readonly pipeline: TransformersTokenClassificationPipeline;
} {
  return {
    factory: vi.fn(async () => implementation),
    pipeline: implementation,
  };
}

function expectCode(
  promise: Promise<unknown>,
  code: TransformersSensitiveSpanClassifierError['code'],
): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    name: 'TransformersSensitiveSpanClassifierError',
    message: code,
    code,
  });
}

describe('TransformersSensitiveSpanClassifier', () => {
  it('loads once with only operator configuration and maps validated spans', async () => {
    const pipeline = vi.fn<TransformersTokenClassificationPipeline>(
      async (_input, options) => {
        expect(options).toMatchObject({ aggregation_strategy: 'simple' });
        return [
          { entity_group: 'PERSON', score: 0.99, start: 19, end: 22 },
          { entity: 'EMAIL', score: 0.74, start: 0, end: 15 },
          { entity: 'EMAIL', score: 0.8, start: 6, end: 18 },
          { entity: 'IGNORED', score: 0.99, start: 0, end: 5 },
        ];
      },
    );
    const factory = vi.fn(async () => pipeline);
    const classifier = new TransformersSensitiveSpanClassifier(
      configuration(),
      factory,
    );

    const [first, second] = await Promise.all([
      classifier.classify('email test@host.io Ada!', {}),
      classifier.classify('email test@host.io Ada!', {}),
    ]);

    expect(first).toEqual([
      { start: 6, end: 18, category: 'email' },
      { start: 19, end: 22, category: 'person' },
    ]);
    expect(second).toEqual(first);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(
      'token-classification',
      'operator/privacy-ner',
      {
        revision: MODEL_REVISION,
        device: 'webgpu',
        dtype: 'q8',
      },
    );
    expect(pipeline).toHaveBeenCalledTimes(2);
    expect(classifier.classifierId).toBe('privacy.ner');
  });

  it('does not initialize for empty input or a pre-aborted request', async () => {
    const { factory } = fakePipeline(vi.fn(async () => []));
    const classifier = new TransformersSensitiveSpanClassifier(
      configuration(),
      factory,
    );
    const controller = new AbortController();
    controller.abort(new Error('must not escape'));

    await expect(classifier.classify('', {})).resolves.toEqual([]);
    await expectCode(
      classifier.classify('secret', { signal: controller.signal }),
      'aborted',
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it('fails closed when aborted during lazy initialization', async () => {
    let finishInitialization: (
      pipeline: TransformersTokenClassificationPipeline,
    ) => void = () => undefined;
    const pending = new Promise<TransformersTokenClassificationPipeline>(
      (resolve) => {
        finishInitialization = resolve;
      },
    );
    const factory = vi.fn(() => pending);
    const pipeline = vi.fn<TransformersTokenClassificationPipeline>(
      async () => [],
    );
    const classifier = new TransformersSensitiveSpanClassifier(
      configuration(),
      factory,
    );
    const controller = new AbortController();

    const classification = classifier.classify('secret', {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    controller.abort('private reason');
    await expectCode(classification, 'aborted');
    finishInitialization(pipeline);
    await expect(classifier.classify('safe', {})).resolves.toEqual([]);
    expect(factory).toHaveBeenCalledOnce();
  });

  it('passes AbortSignal to inference and sanitizes aborts', async () => {
    let finishInference: (value: unknown) => void = () => undefined;
    const pipeline = vi.fn<TransformersTokenClassificationPipeline>(
      (_input, options) => {
        expect(options.signal).toBeInstanceOf(AbortSignal);
        return new Promise((resolve) => {
          finishInference = resolve;
        });
      },
    );
    const { factory } = fakePipeline(pipeline);
    const classifier = new TransformersSensitiveSpanClassifier(
      configuration(),
      factory,
    );
    const controller = new AbortController();

    const classification = classifier.classify('secret', {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(pipeline).toHaveBeenCalledOnce());
    controller.abort({ sensitive: true });
    await expectCode(classification, 'aborted');
    finishInference([]);
  });

  it.each([
    [{ entity: 'PERSON', score: 1.1, start: 0, end: 3 }],
    [{ entity: 'PERSON', score: 0.9, start: -1, end: 3 }],
    [{ entity: 'PERSON', score: 0.9, start: 0, end: 99 }],
    [{ entity: 'PERSON', score: 0.9, start: 2, end: 1 }],
    [{ entity: 'PERSON', score: 0.9, start: 0.5, end: 2 }],
    [{ entity: 'PERSON', entity_group: 'EMAIL', score: 0.9, start: 0, end: 2 }],
    [{ entity: 'PERSON', score: 0.9, start: 1, end: 2 }],
    { entity: 'PERSON', score: 0.9, start: 0, end: 2 },
  ])('rejects malformed provider output %#', async (output) => {
    const { factory } = fakePipeline(vi.fn(async () => output));
    const classifier = new TransformersSensitiveSpanClassifier(
      configuration(),
      factory,
    );

    await expectCode(classifier.classify('😀x', {}), 'invalid_pipeline_output');
  });

  it('allowlists initialization and inference failures', async () => {
    const initialization = new TransformersSensitiveSpanClassifier(
      configuration(),
      vi.fn(() => {
        throw new Error('secret initialization detail');
      }),
    );
    await expectCode(
      initialization.classify('secret', {}),
      'pipeline_initialization_failed',
    );

    const { factory } = fakePipeline(
      vi.fn(() => {
        throw new Error('secret inference detail');
      }),
    );
    const inference = new TransformersSensitiveSpanClassifier(
      configuration(),
      factory,
    );
    await expectCode(
      inference.classify('secret', {}),
      'pipeline_inference_failed',
    );
  });

  it('rejects non-callable pipelines without leaking provider values', async () => {
    const classifier = new TransformersSensitiveSpanClassifier(
      configuration(),
      vi.fn(async () => ({ secret: 'provider detail' }) as never),
    );
    await expectCode(classifier.classify('secret', {}), 'invalid_pipeline');
  });

  it('validates exact configuration and never accepts model URLs', () => {
    const pipeline = vi.fn<TransformersTokenClassificationPipeline>(
      async () => [],
    );
    const invalidConfigurations: unknown[] = [
      { ...configuration(), endpoint: 'https://example.test' },
      { ...configuration(), modelId: 'https://example.test/model' },
      { ...configuration(), revision: 'main' },
      { ...configuration(), revision: '8a5d64f' },
      { ...configuration(), revision: '../main' },
      { ...configuration(), device: 'cpu' },
      { ...configuration(), dtype: 'auto' },
      { ...configuration(), task: 'ner' },
      { ...configuration(), threshold: Number.NaN },
      { ...configuration(), labelToCategory: {} },
      { ...configuration(), labelToCategory: { PERSON: 'bad category' } },
    ];

    for (const invalid of invalidConfigurations) {
      expect(
        () =>
          new TransformersSensitiveSpanClassifier(
            invalid as TransformersSensitiveSpanClassifierConfig,
            async () => pipeline,
          ),
      ).toThrowError(
        new TransformersSensitiveSpanClassifierError('invalid_configuration'),
      );
    }
  });

  it('disposes once after an in-flight inference settles', async () => {
    let finishInference: (value: unknown) => void = () => undefined;
    const dispose = vi.fn(async () => undefined);
    const pipeline = Object.assign(
      vi.fn<TransformersTokenClassificationPipeline>(
        () =>
          new Promise((resolve) => {
            finishInference = resolve;
          }),
      ),
      { dispose },
    );
    const { factory } = fakePipeline(pipeline);
    const classifier = new TransformersSensitiveSpanClassifier(
      configuration(),
      factory,
    );

    const classification = classifier.classify('secret', {});
    await vi.waitFor(() => expect(pipeline).toHaveBeenCalledOnce());
    const firstDispose = classifier.dispose();
    const secondDispose = classifier.dispose();
    expect(dispose).not.toHaveBeenCalled();
    await expectCode(classifier.classify('later', {}), 'disposed');
    finishInference([]);
    await expect(classification).resolves.toEqual([]);
    await Promise.all([firstDispose, secondDispose]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('sanitizes disposal failures', async () => {
    const pipeline = Object.assign(
      vi.fn<TransformersTokenClassificationPipeline>(async () => []),
      {
        dispose: vi.fn(async () => {
          throw new Error('secret disposal detail');
        }),
      },
    );
    const { factory } = fakePipeline(pipeline);
    const classifier = new TransformersSensitiveSpanClassifier(
      configuration(),
      factory,
    );
    await classifier.classify('secret', {});

    await expectCode(classifier.dispose(), 'pipeline_disposal_failed');
  });
});
