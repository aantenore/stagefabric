import { OpenAICompatibleRuntimeOperationQualifier } from '../adapters/openai-compatible-runtime-operation-qualifier.js';
import { qualifyRuntimeOperations } from '../application/runtime-qualification.js';
import type { RuntimeQualificationReport } from '../domain/runtime-qualification.js';

export interface ConfiguredRuntimeQualificationOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
}

/** Registers built-in qualifiers at the trusted Node composition boundary. */
export function qualifyConfiguredRuntime(
  request: unknown,
  options: ConfiguredRuntimeQualificationOptions = {},
): Promise<RuntimeQualificationReport> {
  const environment = options.environment ?? process.env;
  return qualifyRuntimeOperations(request, {
    qualifiers: [
      new OpenAICompatibleRuntimeOperationQualifier({
        fetch: options.fetch ?? globalThis.fetch,
      }),
    ],
    resolveCredential: ({ reference }) => environment[reference],
  });
}
