import { Command, InvalidArgumentError } from 'commander';

import {
  loadCapabilitySnapshot,
  loadCapabilitySnapshotAttestationBundle,
  loadCapabilitySnapshotChallengeReceipt,
  loadCapabilitySnapshotTrustPolicy,
  loadRuntimeQualificationReport,
} from '../adapters/capability-snapshot-attestation-files.js';
import {
  createFileCapabilitySnapshotChallengeConsumer,
  issueCapabilitySnapshotChallengeFile,
} from '../adapters/file-capability-snapshot-challenge.js';
import {
  loadLiveRunBundle,
  loadRuntimeBindingsFile,
} from '../adapters/live-run-bundle.js';
import { loadRuntimeQualificationProfile } from '../adapters/runtime-qualification-profile.js';
import { createSigstoreCapabilitySnapshotAttestationVerifier } from '../adapters/sigstore-capability-snapshot-attestation-verifier.js';
import {
  planAuthenticatedLiveStageGraph,
  runAuthenticatedLiveStageGraph,
  type AuthenticatedLivePlanOptions,
  type AuthenticatedLivePlanResult,
  type AuthenticatedLiveRunnerOptions,
  type AuthenticatedLiveRunRequest,
  type AuthenticatedLiveRunResult,
} from '../composition/authenticated-live-runner.js';
import { observeLiveRuntime } from '../composition/live-runner.js';
import {
  capabilitySnapshotTrustPolicySchema,
  computeCapabilitySnapshotChallengeDigest,
  computeCapabilitySnapshotFabricDigest,
  createCapabilitySnapshotAttestationStatement,
  type CapabilitySnapshotTrustPolicy,
} from '../domain/capability-snapshot-attestation.js';
import { canonicalJson } from '../domain/canonical.js';
import { computeRuntimeQualificationProfileDigest } from '../domain/runtime-qualification.js';
import type { CliIo } from './cli.js';

type AttestationVerifierFactory =
  typeof createSigstoreCapabilitySnapshotAttestationVerifier;
type ChallengeConsumerFactory =
  typeof createFileCapabilitySnapshotChallengeConsumer;
type ChallengeIssuer = typeof issueCapabilitySnapshotChallengeFile;
type AuthenticatedRunner = typeof runAuthenticatedLiveStageGraph;

export type PlanAuthenticatedCommand = (
  request: AuthenticatedLiveRunRequest,
  options: AuthenticatedLivePlanOptions,
) => Promise<AuthenticatedLivePlanResult>;

export interface AuthenticatedCliDependencies {
  readonly now?: () => Date;
  readonly random?: (size: number) => Uint8Array;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly createAttestationVerifier?: AttestationVerifierFactory;
  readonly createChallengeConsumer?: ChallengeConsumerFactory;
  readonly issueChallenge?: ChallengeIssuer;
  readonly planAuthenticated?: PlanAuthenticatedCommand;
  readonly runAuthenticated?: AuthenticatedRunner;
}

interface EvidenceFileOptions {
  readonly bindings: string;
  readonly snapshot: string;
  readonly qualificationReport: string;
  readonly profile: string;
  readonly trustPolicy: string;
  readonly challenge: string;
}

interface AuthenticatedFileOptions extends EvidenceFileOptions {
  readonly attestationBundle: string;
}

interface AuthenticatedRunFileOptions extends AuthenticatedFileOptions {
  readonly challengeStore: string;
}

interface ChallengeIssueOptions {
  readonly output: string;
  readonly audience: string;
  readonly ttlSeconds: number;
}

interface TrustPolicyCreateOptions {
  readonly bindings: string;
  readonly profile: string;
  readonly certificateIssuer: string;
  readonly identityUri?: string;
  readonly identityEmail?: string;
  readonly audience: string;
  readonly certificateThreshold: number;
  readonly transparencyLogThreshold: number;
  readonly maxSnapshotAgeSeconds: number;
  readonly maxSnapshotTtlSeconds: number;
  readonly clockSkewSeconds: number;
}

function writeJson(write: (value: string) => void, value: unknown): void {
  write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseTtlSeconds(value: string): number {
  const ttlSeconds = Number(value);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3_600) {
    throw new InvalidArgumentError(
      'ttl-seconds must be an integer between 1 and 3600',
    );
  }
  return ttlSeconds;
}

function boundedIntegerParser(
  label: string,
  minimum: number,
  maximum: number,
): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new InvalidArgumentError(
        `${label} must be an integer between ${minimum} and ${maximum}`,
      );
    }
    return parsed;
  };
}

function addEvidenceFileOptions(command: Command): Command {
  return command
    .requiredOption(
      '--bindings <path>',
      'operator-owned sealed or sealable runtime bindings file',
    )
    .requiredOption('--snapshot <path>', 'sealed capability snapshot file')
    .requiredOption(
      '--qualification-report <path>',
      'sealed runtime qualification report file',
    )
    .requiredOption(
      '--profile <path>',
      'strict runtime qualification profile file',
    )
    .requiredOption(
      '--trust-policy <path>',
      'deployment-owned capability snapshot trust policy file',
    )
    .requiredOption(
      '--challenge <path>',
      'verifier-issued capability snapshot challenge receipt file',
    );
}

function addAuthenticatedFileOptions(command: Command): Command {
  return addEvidenceFileOptions(command).requiredOption(
    '--attestation-bundle <path>',
    'bounded Sigstore DSSE attestation bundle file',
  );
}

async function loadEvidenceFiles(options: EvidenceFileOptions) {
  const [
    bindings,
    snapshot,
    qualificationReport,
    qualificationProfile,
    trustPolicy,
    expectedChallenge,
  ] = await Promise.all([
    loadRuntimeBindingsFile(options.bindings),
    loadCapabilitySnapshot(options.snapshot),
    loadRuntimeQualificationReport(options.qualificationReport),
    loadRuntimeQualificationProfile(options.profile),
    loadCapabilitySnapshotTrustPolicy(options.trustPolicy),
    loadCapabilitySnapshotChallengeReceipt(options.challenge),
  ]);
  return {
    bindings,
    snapshot,
    qualificationReport,
    qualificationProfile,
    trustPolicy,
    expectedChallenge,
  };
}

async function loadAuthenticatedCommandRequest(
  bundlePath: string,
  options: AuthenticatedFileOptions,
): Promise<
  AuthenticatedLiveRunRequest & {
    readonly trustPolicy: CapabilitySnapshotTrustPolicy;
  }
> {
  // Load each path exactly once. In particular, both verification fences use
  // the same copied attestation bytes rather than reopening a mutable file.
  const [bundle, evidence, attestationBundle] = await Promise.all([
    loadLiveRunBundle(bundlePath),
    loadEvidenceFiles(options),
    loadCapabilitySnapshotAttestationBundle(options.attestationBundle),
  ]);
  return { ...bundle, ...evidence, attestationBundle };
}

function liveOptions(
  dependencies: AuthenticatedCliDependencies,
): Pick<AuthenticatedLiveRunnerOptions, 'environment' | 'fetch' | 'now'> {
  return {
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.environment === undefined
      ? {}
      : { environment: dependencies.environment }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  };
}

function writeAuthenticatedRunResult(
  io: CliIo,
  result: AuthenticatedLiveRunResult,
): void {
  writeJson(io.writeOut, {
    graphName: result.plan.graphName,
    bindingDigest: result.bindingDigest,
    snapshotDigest: result.trust.evidence.snapshotDigest,
    planDigest: result.plan.digest,
    evidence: result.trust,
    placements: result.execution.stages.map((stage) => ({
      stageId: stage.stageId,
      targetId: stage.targetId,
      zone: stage.zone,
    })),
    outputs: result.outputs,
    trace: result.execution.trace,
  });
}

/** Registers the local-only authenticated snapshot workflow on an existing CLI. */
export function registerAuthenticatedSnapshotCommands(
  program: Command,
  io: CliIo,
  dependencies: AuthenticatedCliDependencies = {},
): void {
  const createVerifier =
    dependencies.createAttestationVerifier ??
    createSigstoreCapabilitySnapshotAttestationVerifier;
  const createConsumer =
    dependencies.createChallengeConsumer ??
    createFileCapabilitySnapshotChallengeConsumer;
  const issueChallenge =
    dependencies.issueChallenge ?? issueCapabilitySnapshotChallengeFile;
  const planAuthenticated =
    dependencies.planAuthenticated ?? planAuthenticatedLiveStageGraph;
  const runAuthenticated =
    dependencies.runAuthenticated ?? runAuthenticatedLiveStageGraph;

  program
    .command('challenge')
    .description('Manage verifier-issued capability snapshot challenges')
    .command('issue')
    .description('Issue a bounded single-use challenge lease')
    .requiredOption('--output <path>', 'new private challenge receipt path')
    .requiredOption('--audience <value>', 'exact consuming audience')
    .requiredOption(
      '--ttl-seconds <seconds>',
      'challenge lease duration',
      parseTtlSeconds,
    )
    .action(async (options: ChallengeIssueOptions) => {
      const challenge = await issueChallenge({
        path: options.output,
        audience: options.audience,
        ttlSeconds: options.ttlSeconds,
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        ...(dependencies.random === undefined
          ? {}
          : { random: dependencies.random }),
      });
      writeJson(io.writeOut, {
        issued: true,
        audience: challenge.audience,
        challengeDigest: computeCapabilitySnapshotChallengeDigest(
          challenge.value,
        ),
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
      });
    });

  program
    .command('observe')
    .description('Observe a sealed capability snapshot from live bindings')
    .argument('<bundle>', 'path to a live-run YAML bundle')
    .requiredOption(
      '--bindings <path>',
      'operator-owned runtime bindings file (never loaded from the graph)',
    )
    .action(async (bundlePath: string, options: { bindings: string }) => {
      const [bundle, bindings] = await Promise.all([
        loadLiveRunBundle(bundlePath),
        loadRuntimeBindingsFile(options.bindings),
      ]);
      const snapshot = await observeLiveRuntime(
        { ...bundle, bindings },
        liveOptions(dependencies),
      );
      writeJson(io.writeOut, snapshot);
    });

  program
    .command('trust-policy')
    .description('Generate strict deployment-owned snapshot trust policies')
    .command('create')
    .description('Derive fabric and qualification digests into a policy')
    .argument('<bundle>', 'path to a live-run YAML bundle')
    .requiredOption('--bindings <path>', 'trusted runtime bindings file')
    .requiredOption('--profile <path>', 'runtime qualification profile file')
    .requiredOption(
      '--certificate-issuer <https-url>',
      'exact certificate issuer',
    )
    .option('--identity-uri <literal>', 'exact URI signer identity')
    .option('--identity-email <literal>', 'exact email signer identity')
    .requiredOption('--audience <value>', 'exact consuming audience')
    .option(
      '--certificate-threshold <count>',
      'minimum certificate transparency entries',
      boundedIntegerParser('certificate-threshold', 1, 8),
      1,
    )
    .option(
      '--transparency-log-threshold <count>',
      'minimum signature transparency entries',
      boundedIntegerParser('transparency-log-threshold', 1, 8),
      1,
    )
    .option(
      '--max-snapshot-age-seconds <seconds>',
      'maximum accepted snapshot age',
      boundedIntegerParser('max-snapshot-age-seconds', 1, 86_400),
      300,
    )
    .option(
      '--max-snapshot-ttl-seconds <seconds>',
      'maximum accepted snapshot TTL',
      boundedIntegerParser('max-snapshot-ttl-seconds', 1, 86_400),
      300,
    )
    .option(
      '--clock-skew-seconds <seconds>',
      'bounded verifier clock skew',
      boundedIntegerParser('clock-skew-seconds', 0, 300),
      5,
    )
    .action(async (bundlePath: string, options: TrustPolicyCreateOptions) => {
      if (
        (options.identityUri === undefined) ===
        (options.identityEmail === undefined)
      ) {
        throw new InvalidArgumentError(
          'exactly one of --identity-uri or --identity-email is required',
        );
      }
      const [bundle, bindings, profile] = await Promise.all([
        loadLiveRunBundle(bundlePath),
        loadRuntimeBindingsFile(options.bindings),
        loadRuntimeQualificationProfile(options.profile),
      ]);
      if (bindings.policy.snapshotTtlSeconds > options.maxSnapshotTtlSeconds) {
        throw new InvalidArgumentError(
          'max-snapshot-ttl-seconds must cover the binding snapshot TTL',
        );
      }
      const policy = capabilitySnapshotTrustPolicySchema.parse({
        apiVersion: 'stagefabric.dev/v1alpha1',
        kind: 'CapabilitySnapshotTrustPolicy',
        certificateIssuer: options.certificateIssuer,
        signerIdentity:
          options.identityUri === undefined
            ? { type: 'email', value: options.identityEmail }
            : { type: 'uri', value: options.identityUri },
        audience: options.audience,
        certificateThreshold: options.certificateThreshold,
        transparencyLogThreshold: options.transparencyLogThreshold,
        fabricDigest: computeCapabilitySnapshotFabricDigest(bundle.fabric),
        qualificationProfileDigest:
          computeRuntimeQualificationProfileDigest(profile),
        maxSnapshotAgeSeconds: options.maxSnapshotAgeSeconds,
        maxSnapshotTtlSeconds: options.maxSnapshotTtlSeconds,
        clockSkewSeconds: options.clockSkewSeconds,
      });
      io.writeOut(`${canonicalJson(policy)}\n`);
    });

  addEvidenceFileOptions(
    program
      .command('attestation-statement')
      .description('Create a canonical in-toto capability statement')
      .argument('<bundle>', 'path to a live-run YAML bundle'),
  ).action(async (bundlePath: string, options: EvidenceFileOptions) => {
    const [bundle, evidence] = await Promise.all([
      loadLiveRunBundle(bundlePath),
      loadEvidenceFiles(options),
    ]);
    const statement = createCapabilitySnapshotAttestationStatement({
      fabric: bundle.fabric,
      snapshot: evidence.snapshot,
      bindings: evidence.bindings,
      qualificationReport: evidence.qualificationReport,
      qualificationProfile: evidence.qualificationProfile,
      trustPolicy: evidence.trustPolicy,
      challenge: evidence.expectedChallenge,
    });
    io.writeOut(`${canonicalJson(statement)}\n`);
  });

  addAuthenticatedFileOptions(
    program
      .command('plan-authenticated')
      .description('Verify transported capability evidence and compile a plan')
      .argument('<bundle>', 'path to a live-run YAML bundle'),
  ).action(async (bundlePath: string, options: AuthenticatedFileOptions) => {
    const request = await loadAuthenticatedCommandRequest(bundlePath, options);
    const verifier = await createVerifier(request.trustPolicy);
    const result = await planAuthenticated(request, {
      verifier,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
    writeJson(io.writeOut, { plan: result.plan, evidence: result.trust });
  });

  addAuthenticatedFileOptions(
    program
      .command('run-authenticated')
      .description(
        'Verify, consume the challenge, and execute a transported snapshot',
      )
      .argument('<bundle>', 'path to a live-run YAML bundle'),
  )
    .requiredOption(
      '--challenge-store <directory>',
      'stable directory for atomic challenge-consumption markers',
    )
    .action(
      async (bundlePath: string, options: AuthenticatedRunFileOptions) => {
        const request = await loadAuthenticatedCommandRequest(
          bundlePath,
          options,
        );
        const verifier = await createVerifier(request.trustPolicy);
        const result = await runAuthenticated(request, {
          verifier,
          challengeConsumer: createConsumer(options.challengeStore),
          ...liveOptions(dependencies),
        });
        writeAuthenticatedRunResult(io, result);
      },
    );
}
