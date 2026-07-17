import type {
  ClassifiedSensitiveSpan,
  SensitiveSpanClassifier,
} from '../../redaction.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SAFE_MODEL_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const IMMUTABLE_MODEL_REVISION = /^[a-f0-9]{40}$/;
const MAX_LABEL_MAPPINGS = 1_024;
const MAX_PIPELINE_RESULTS = 100_000;

const CONFIGURATION_KEYS = new Set([
  'classifierId',
  'device',
  'dtype',
  'labelToCategory',
  'modelId',
  'revision',
  'task',
  'threshold',
]);

export const TRANSFORMERS_TOKEN_CLASSIFICATION_TASK =
  'token-classification' as const;

export type TransformersDevice = 'wasm' | 'webgpu';

export type TransformersDtype =
  'bnb4' | 'fp16' | 'fp32' | 'int8' | 'q4' | 'q4f16' | 'q8' | 'uint8';

const SUPPORTED_DEVICES = new Set<TransformersDevice>(['wasm', 'webgpu']);
const SUPPORTED_DTYPES = new Set<TransformersDtype>([
  'bnb4',
  'fp16',
  'fp32',
  'int8',
  'q4',
  'q4f16',
  'q8',
  'uint8',
]);

export interface TransformersSensitiveSpanClassifierConfig {
  readonly classifierId: string;
  readonly modelId: string;
  readonly revision: string;
  readonly device: TransformersDevice;
  readonly dtype: TransformersDtype;
  readonly task: typeof TRANSFORMERS_TOKEN_CLASSIFICATION_TASK;
  readonly labelToCategory: Readonly<Record<string, string>>;
  readonly threshold: number;
}

export interface TransformersPipelineOptions {
  readonly revision: string;
  readonly device: TransformersDevice;
  readonly dtype: TransformersDtype;
}

export interface TransformersTokenClassificationCallOptions {
  readonly aggregation_strategy: 'simple';
  readonly signal?: AbortSignal;
}

export interface TransformersTokenClassificationPipeline {
  (
    input: string,
    options: TransformersTokenClassificationCallOptions,
  ): Promise<unknown> | unknown;
  dispose?(): Promise<void> | void;
}

/**
 * Compatible with an injected `pipeline` function from Transformers.js. The
 * adapter deliberately owns no model identifier, endpoint, or SDK import.
 */
export type TransformersPipelineFactory = (
  task: typeof TRANSFORMERS_TOKEN_CLASSIFICATION_TASK,
  modelId: string,
  options: TransformersPipelineOptions,
) =>
  | Promise<TransformersTokenClassificationPipeline>
  | TransformersTokenClassificationPipeline;

export type TransformersSensitiveSpanClassifierFailureCode =
  | 'aborted'
  | 'disposed'
  | 'invalid_configuration'
  | 'invalid_input'
  | 'invalid_pipeline'
  | 'invalid_pipeline_output'
  | 'pipeline_disposal_failed'
  | 'pipeline_inference_failed'
  | 'pipeline_initialization_failed';

export class TransformersSensitiveSpanClassifierError extends Error {
  readonly code: TransformersSensitiveSpanClassifierFailureCode;

  constructor(code: TransformersSensitiveSpanClassifierFailureCode) {
    super(code);
    this.name = 'TransformersSensitiveSpanClassifierError';
    this.code = code;
  }
}

interface ValidatedConfiguration {
  readonly classifierId: string;
  readonly modelId: string;
  readonly revision: string;
  readonly device: TransformersDevice;
  readonly dtype: TransformersDtype;
  readonly task: typeof TRANSFORMERS_TOKEN_CLASSIFICATION_TASK;
  readonly labelToCategory: Readonly<Record<string, string>>;
  readonly threshold: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyDataProperties(
  value: Record<string, unknown>,
  allowedKeys?: ReadonlySet<string>,
): boolean {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  return keys.every((key) => {
    if (typeof key !== 'string') return false;
    if (allowedKeys !== undefined && !allowedKeys.has(key)) return false;
    const descriptor = descriptors[key];
    return (
      descriptor !== undefined &&
      Object.hasOwn(descriptor, 'value') &&
      descriptor.enumerable === true
    );
  });
}

function validModelReference(value: string): boolean {
  return (
    SAFE_MODEL_REFERENCE.test(value) &&
    !value.includes('//') &&
    !value.split('/').includes('..')
  );
}

function validateLabelMapping(
  value: unknown,
): Readonly<Record<string, string>> {
  if (!isPlainRecord(value) || !hasOnlyDataProperties(value)) {
    throw new TransformersSensitiveSpanClassifierError('invalid_configuration');
  }

  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_LABEL_MAPPINGS) {
    throw new TransformersSensitiveSpanClassifierError('invalid_configuration');
  }

  const mapping = Object.create(null) as Record<string, string>;
  for (const [label, category] of entries) {
    if (
      !SAFE_ID.test(label) ||
      typeof category !== 'string' ||
      !SAFE_ID.test(category)
    ) {
      throw new TransformersSensitiveSpanClassifierError(
        'invalid_configuration',
      );
    }
    mapping[label] = category;
  }
  return Object.freeze(mapping);
}

function validateConfiguration(
  value: TransformersSensitiveSpanClassifierConfig,
): ValidatedConfiguration {
  if (
    !isPlainRecord(value) ||
    !hasOnlyDataProperties(value, CONFIGURATION_KEYS) ||
    Reflect.ownKeys(value).length !== CONFIGURATION_KEYS.size
  ) {
    throw new TransformersSensitiveSpanClassifierError('invalid_configuration');
  }

  const {
    classifierId,
    modelId,
    revision,
    device,
    dtype,
    task,
    labelToCategory,
    threshold,
  } = value;
  if (
    typeof classifierId !== 'string' ||
    !SAFE_ID.test(classifierId) ||
    typeof modelId !== 'string' ||
    !validModelReference(modelId) ||
    typeof revision !== 'string' ||
    !IMMUTABLE_MODEL_REVISION.test(revision) ||
    !SUPPORTED_DEVICES.has(device) ||
    !SUPPORTED_DTYPES.has(dtype) ||
    task !== TRANSFORMERS_TOKEN_CLASSIFICATION_TASK ||
    typeof threshold !== 'number' ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1
  ) {
    throw new TransformersSensitiveSpanClassifierError('invalid_configuration');
  }

  return Object.freeze({
    classifierId,
    modelId,
    revision,
    device,
    dtype,
    task,
    labelToCategory: validateLabelMapping(labelToCategory),
    threshold,
  });
}

function isCodePointBoundary(input: string, offset: number): boolean {
  if (offset <= 0 || offset >= input.length) return true;
  const previous = input.charCodeAt(offset - 1);
  const current = input.charCodeAt(offset);
  return !(
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
  );
}

function readOutputLabel(output: Record<string, unknown>): string | undefined {
  const entity = output['entity'];
  const entityGroup = output['entity_group'];
  if (
    entity !== undefined &&
    (typeof entity !== 'string' || !SAFE_ID.test(entity))
  ) {
    return undefined;
  }
  if (
    entityGroup !== undefined &&
    (typeof entityGroup !== 'string' || !SAFE_ID.test(entityGroup))
  ) {
    return undefined;
  }
  if (entity === undefined && entityGroup === undefined) return undefined;
  if (
    typeof entity === 'string' &&
    typeof entityGroup === 'string' &&
    entity !== entityGroup
  ) {
    return undefined;
  }
  return typeof entityGroup === 'string' ? entityGroup : (entity as string);
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function validatePipelineOutput(
  value: unknown,
  input: string,
  configuration: ValidatedConfiguration,
): readonly ClassifiedSensitiveSpan[] {
  if (!Array.isArray(value) || value.length > MAX_PIPELINE_RESULTS) {
    throw new TransformersSensitiveSpanClassifierError(
      'invalid_pipeline_output',
    );
  }

  const spans: ClassifiedSensitiveSpan[] = [];
  for (const output of value) {
    if (!isPlainRecord(output)) {
      throw new TransformersSensitiveSpanClassifierError(
        'invalid_pipeline_output',
      );
    }
    const label = readOutputLabel(output);
    const score = output['score'];
    const start = output['start'];
    const end = output['end'];
    if (
      label === undefined ||
      typeof score !== 'number' ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 1 ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      (start as number) < 0 ||
      (start as number) >= (end as number) ||
      (end as number) > input.length ||
      !isCodePointBoundary(input, start as number) ||
      !isCodePointBoundary(input, end as number)
    ) {
      throw new TransformersSensitiveSpanClassifierError(
        'invalid_pipeline_output',
      );
    }

    const category = configuration.labelToCategory[label];
    if (score >= configuration.threshold && category !== undefined) {
      spans.push({ start: start as number, end: end as number, category });
    }
  }

  spans.sort(
    (left, right) =>
      left.start - right.start ||
      left.end - right.end ||
      compareText(left.category, right.category),
  );
  return Object.freeze(spans.map((span) => Object.freeze(span)));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  try {
    if (signal?.aborted === true) {
      throw new TransformersSensitiveSpanClassifierError('aborted');
    }
  } catch (error) {
    if (error instanceof TransformersSensitiveSpanClassifierError) throw error;
    throw new TransformersSensitiveSpanClassifierError('invalid_input');
  }
}

function validateSignal(signal: AbortSignal | undefined): void {
  if (
    signal !== undefined &&
    (typeof AbortSignal === 'undefined' || !(signal instanceof AbortSignal))
  ) {
    throw new TransformersSensitiveSpanClassifierError('invalid_input');
  }
}

function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return operation;
  let alreadyAborted: boolean;
  try {
    alreadyAborted = signal.aborted;
  } catch {
    return Promise.reject(
      new TransformersSensitiveSpanClassifierError('invalid_input'),
    );
  }
  if (alreadyAborted) {
    return Promise.reject(
      new TransformersSensitiveSpanClassifierError('aborted'),
    );
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new TransformersSensitiveSpanClassifierError('aborted'));
    };
    try {
      signal.addEventListener('abort', onAbort, { once: true });
    } catch {
      reject(new TransformersSensitiveSpanClassifierError('invalid_input'));
      return;
    }
    operation.then(
      (result) => {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {
          reject(new TransformersSensitiveSpanClassifierError('invalid_input'));
          return;
        }
        resolve(result);
      },
      (error: unknown) => {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {
          reject(new TransformersSensitiveSpanClassifierError('invalid_input'));
          return;
        }
        reject(error);
      },
    );
  });
}

function normalizeInitializationFailure(
  error: unknown,
): TransformersSensitiveSpanClassifierError {
  if (
    error instanceof TransformersSensitiveSpanClassifierError &&
    (error.code === 'invalid_input' || error.code === 'invalid_pipeline')
  ) {
    return error;
  }
  return new TransformersSensitiveSpanClassifierError(
    'pipeline_initialization_failed',
  );
}

export class TransformersSensitiveSpanClassifier implements SensitiveSpanClassifier {
  readonly classifierId: string;
  readonly #configuration: ValidatedConfiguration;
  readonly #pipelineFactory: TransformersPipelineFactory;
  readonly #pendingInference = new Set<Promise<void>>();
  #pipelinePromise:
    Promise<TransformersTokenClassificationPipeline> | undefined;
  #disposePromise: Promise<void> | undefined;
  #disposed = false;

  constructor(
    configuration: TransformersSensitiveSpanClassifierConfig,
    pipelineFactory: TransformersPipelineFactory,
  ) {
    try {
      this.#configuration = validateConfiguration(configuration);
    } catch (error) {
      if (
        error instanceof TransformersSensitiveSpanClassifierError &&
        error.code === 'invalid_configuration'
      ) {
        throw error;
      }
      throw new TransformersSensitiveSpanClassifierError(
        'invalid_configuration',
      );
    }
    if (typeof pipelineFactory !== 'function') {
      throw new TransformersSensitiveSpanClassifierError(
        'invalid_configuration',
      );
    }
    this.#pipelineFactory = pipelineFactory;
    this.classifierId = this.#configuration.classifierId;
  }

  async classify(
    input: string,
    options: { readonly signal?: AbortSignal },
  ): Promise<readonly ClassifiedSensitiveSpan[]> {
    if (this.#disposed) {
      throw new TransformersSensitiveSpanClassifierError('disposed');
    }
    let validOptions: boolean;
    try {
      validOptions = isPlainRecord(options);
    } catch {
      validOptions = false;
    }
    if (typeof input !== 'string' || !validOptions) {
      throw new TransformersSensitiveSpanClassifierError('invalid_input');
    }
    let signal: AbortSignal | undefined;
    try {
      signal = options.signal;
      validateSignal(signal);
    } catch (error) {
      if (error instanceof TransformersSensitiveSpanClassifierError) {
        throw error;
      }
      throw new TransformersSensitiveSpanClassifierError('invalid_input');
    }
    throwIfAborted(signal);
    if (input.length === 0) return Object.freeze([]);

    let pipeline: TransformersTokenClassificationPipeline;
    try {
      pipeline = await abortable(this.#getPipeline(), signal);
    } catch (error) {
      if (
        error instanceof TransformersSensitiveSpanClassifierError &&
        error.code === 'aborted'
      ) {
        throw error;
      }
      throw normalizeInitializationFailure(error);
    }
    if (this.#disposed) {
      throw new TransformersSensitiveSpanClassifierError('disposed');
    }
    throwIfAborted(signal);

    let inference: Promise<unknown>;
    try {
      inference = Promise.resolve(
        pipeline(input, {
          aggregation_strategy: 'simple',
          ...(signal === undefined ? {} : { signal }),
        }),
      );
    } catch {
      throw new TransformersSensitiveSpanClassifierError(
        'pipeline_inference_failed',
      );
    }

    const tracked = inference.then(
      () => undefined,
      () => undefined,
    );
    this.#pendingInference.add(tracked);
    void tracked.finally(() => this.#pendingInference.delete(tracked));

    let output: unknown;
    try {
      output = await abortable(inference, signal);
    } catch (error) {
      if (
        error instanceof TransformersSensitiveSpanClassifierError &&
        error.code === 'aborted'
      ) {
        throw error;
      }
      throwIfAborted(signal);
      throw new TransformersSensitiveSpanClassifierError(
        'pipeline_inference_failed',
      );
    }

    throwIfAborted(signal);
    try {
      return validatePipelineOutput(output, input, this.#configuration);
    } catch (error) {
      if (
        error instanceof TransformersSensitiveSpanClassifierError &&
        error.code === 'invalid_pipeline_output'
      ) {
        throw error;
      }
      throw new TransformersSensitiveSpanClassifierError(
        'invalid_pipeline_output',
      );
    }
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = this.#disposePipeline();
    return this.#disposePromise;
  }

  #getPipeline(): Promise<TransformersTokenClassificationPipeline> {
    if (this.#pipelinePromise === undefined) {
      this.#pipelinePromise = Promise.resolve()
        .then(() =>
          this.#pipelineFactory(
            this.#configuration.task,
            this.#configuration.modelId,
            Object.freeze({
              revision: this.#configuration.revision,
              device: this.#configuration.device,
              dtype: this.#configuration.dtype,
            }),
          ),
        )
        .then((pipeline) => {
          if (typeof pipeline !== 'function') {
            throw new TransformersSensitiveSpanClassifierError(
              'invalid_pipeline',
            );
          }
          return pipeline;
        });
    }
    return this.#pipelinePromise;
  }

  async #disposePipeline(): Promise<void> {
    const pipelinePromise = this.#pipelinePromise;
    if (pipelinePromise === undefined) return;

    let pipeline: TransformersTokenClassificationPipeline;
    try {
      pipeline = await pipelinePromise;
    } catch {
      return;
    }
    await Promise.all(this.#pendingInference);
    try {
      const dispose = pipeline.dispose;
      if (dispose === undefined) return;
      await dispose.call(pipeline);
    } catch {
      throw new TransformersSensitiveSpanClassifierError(
        'pipeline_disposal_failed',
      );
    }
  }
}
