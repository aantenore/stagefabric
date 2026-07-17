import { CommanderError } from 'commander';
import { ZodError } from 'zod';

import { CapabilityAttestationFileError } from '../adapters/capability-snapshot-attestation-files.js';
import { ConfigBundleError } from '../adapters/config-bundle.js';
import { FileChallengeError } from '../adapters/file-capability-snapshot-challenge.js';
import { CapabilityProbeError } from '../adapters/openai-compatible-capability-probe.js';
import { LiveRunBundleError } from '../adapters/live-run-bundle.js';
import { RuntimeQualificationProfileError } from '../adapters/runtime-qualification-profile.js';
import { CapabilityAttestationVerificationError } from '../adapters/sigstore-capability-snapshot-attestation-verifier.js';
import { AuthenticateCapabilitySnapshotError } from '../application/authenticate-capability-snapshot.js';
import { ExecutionError } from '../application/executor.js';
import { PlannerError } from '../application/planner.js';
import { RuntimeQualificationError } from '../application/runtime-qualification.js';
import { AuthenticatedLiveRunnerError } from '../composition/authenticated-live-runner.js';
import { LiveRunnerError } from '../composition/live-runner.js';
import { CapabilitySnapshotAttestationError } from '../domain/capability-snapshot-attestation.js';

export interface SafeErrorBody {
  readonly error: Readonly<Record<string, unknown>>;
}

export function safeErrorBody(error: unknown): SafeErrorBody {
  if (
    error instanceof CapabilityAttestationFileError ||
    error instanceof FileChallengeError ||
    error instanceof CapabilityAttestationVerificationError ||
    error instanceof AuthenticateCapabilitySnapshotError ||
    error instanceof CapabilitySnapshotAttestationError ||
    error instanceof AuthenticatedLiveRunnerError
  ) {
    return { error: { code: error.code } };
  }
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
