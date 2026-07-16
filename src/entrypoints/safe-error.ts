import { CommanderError } from 'commander';
import { ZodError } from 'zod';

import { ConfigBundleError } from '../adapters/config-bundle.js';
import { CapabilityProbeError } from '../adapters/openai-compatible-capability-probe.js';
import { LiveRunBundleError } from '../adapters/live-run-bundle.js';
import { RuntimeQualificationProfileError } from '../adapters/runtime-qualification-profile.js';
import { ExecutionError } from '../application/executor.js';
import { PlannerError } from '../application/planner.js';
import { RuntimeQualificationError } from '../application/runtime-qualification.js';
import { LiveRunnerError } from '../composition/live-runner.js';

export interface SafeErrorBody {
  readonly error: Readonly<Record<string, unknown>>;
}

export function safeErrorBody(error: unknown): SafeErrorBody {
  if (error instanceof PlannerError) {
    return { error: { code: error.code, details: error.details } };
  }
  if (error instanceof ExecutionError) {
    return {
      error: {
        code: error.code,
        ...(error.stageId === undefined ? {} : { stageId: error.stageId }),
        ...(error.reasonCode === undefined
          ? {}
          : { reasonCode: error.reasonCode }),
        trace: error.trace,
      },
    };
  }
  if (error instanceof ConfigBundleError) {
    return { error: { code: error.code, issues: error.issues } };
  }
  if (error instanceof LiveRunBundleError) {
    return { error: { code: error.code, issues: error.issues } };
  }
  if (error instanceof RuntimeQualificationProfileError) {
    return { error: { code: error.code, issues: error.issues } };
  }
  if (error instanceof RuntimeQualificationError) {
    return { error: { code: error.code } };
  }
  if (error instanceof CapabilityProbeError) {
    return { error: { code: error.code } };
  }
  if (error instanceof LiveRunnerError) {
    return { error: { code: error.code, details: error.details } };
  }
  if (error instanceof ZodError) {
    return {
      error: {
        code: 'request_invalid',
        issues: error.issues.map((issue) => ({ code: issue.code })),
      },
    };
  }
  if (error instanceof CommanderError) {
    return { error: { code: error.code } };
  }
  return { error: { code: 'internal_error' } };
}
