import { CommanderError } from 'commander';
import { ZodError } from 'zod';

import { ConfigBundleError } from '../adapters/config-bundle.js';
import { ExecutionError } from '../application/executor.js';
import { PlannerError } from '../application/planner.js';

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
        stageId: error.stageId,
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
  if (error instanceof ZodError) {
    return {
      error: {
        code: 'request_invalid',
        issues: error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.map(String),
          message: issue.message,
        })),
      },
    };
  }
  if (error instanceof CommanderError) {
    return { error: { code: error.code } };
  }
  return { error: { code: 'internal_error' } };
}
