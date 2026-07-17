import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import type { AuthenticatedCapabilitySnapshot } from '../../src/application/authenticate-capability-snapshot.js';
import { planStageGraph } from '../../src/application/planner.js';
import type { AuthenticatedLiveRunResult } from '../../src/composition/authenticated-live-runner.js';
import {
  capabilitySnapshotChallengeReceiptSchema,
  capabilitySnapshotTrustPolicySchema,
  computeCapabilitySnapshotFabricDigest,
  createCapabilitySnapshotAttestationStatement,
  verifyCapabilitySnapshotAttestationSemantics,
} from '../../src/domain/capability-snapshot-attestation.js';
import { canonicalJson, sha256Digest } from '../../src/domain/canonical.js';
import { sealRuntimeBindings } from '../../src/domain/runtime-bindings.js';
import {
  computeRuntimeQualificationProfileDigest,
  sealRuntimeQualificationReport,
} from '../../src/domain/runtime-qualification.js';
import { sealCapabilitySnapshot } from '../../src/domain/snapshot.js';
import {
  registerAuthenticatedSnapshotCommands,
  type AuthenticatedCliDependencies,
} from '../../src/entrypoints/authenticated-cli.js';
import {
  IN_TOTO_STATEMENT_PAYLOAD_TYPE,
  type CapabilitySnapshotAttestationVerifier,
  type VerifiedAttestationSigner,
} from '../../src/ports/capability-snapshot-attestation-verifier.js';
import type { CapabilitySnapshotChallengeConsumer } from '../../src/ports/capability-snapshot-challenge-consumer.js';

const directories: string[] = [];

const signer = Object.freeze({
  issuer: 'https://token.actions.githubusercontent.com',
  identityType: 'uri',
  identity:
    'https://github.com/aantenore/stagefabric/.github/workflows/release.yml@refs/heads/main',
} satisfies VerifiedAttestationSigner);

const fabric = {
  apiVersion: 'stagefabric.dev/v1alpha1' as const,
  kind: 'Fabric' as const,
  zones: [
    {
      id: 'edge',
      trustLevel: 1,
      residencies: ['EU'],
      labels: {},
    },
  ],
  classifications: [
    {
      id: 'public',
      rank: 0,
      minTrustLevel: 0,
      allowedZones: [],
      allowedResidencies: [],
    },
  ],
  targets: [
    {
      id: 'edge-a',
      zone: 'edge',
      adapter: { kind: 'openai-compatible' as const },
      capabilities: ['text-generation'],
      expectedP95Ms: 10,
      costMicros: 1,
      labels: {},
    },
  ],
  policy: { zonePreference: ['edge'], maxFallbacks: 0 },
};

const graph = {
  apiVersion: 'stagefabric.dev/v1alpha1' as const,
  kind: 'StageGraph' as const,
  metadata: { name: 'authenticated-cli', labels: {} },
  inputs: [
    {
      name: 'prompt',
      type: 'text/plain',
      classification: 'public',
      residencies: ['EU'],
      origin: { zone: 'edge' },
    },
  ],
  stages: [
    {
      id: 'summarize',
      operation: 'summarize',
      inputs: { prompt: { ref: 'input.prompt', type: 'text/plain' } },
      outputs: [
        { name: 'answer', type: 'text/plain', classification: 'public' },
      ],
      requirements: {
        capabilities: ['text-generation'],
        allowedZones: [],
        residencies: [],
      },
      declassifications: [],
    },
  ],
};

function runtimeBindings() {
  return sealRuntimeBindings({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'RuntimeBindings',
    policy: {
      requestTimeoutMs: 1_000,
      maxResponseBytes: 16_384,
      snapshotTtlSeconds: 120,
    },
    targets: [
      {
        targetId: 'edge-a',
        provider: {
          kind: 'openai-compatible',
          name: 'edge-runtime',
          baseUrl: 'https://edge-a.invalid/v1',
        },
        operations: [
          {
            kind: 'generate-text',
            operation: 'summarize',
            capabilities: ['text-generation'],
            model: 'summary-live',
            input: 'prompt',
            output: 'answer',
            maxOutputTokens: 64,
          },
        ],
      },
    ],
  });
}

const qualificationProfile = {
  apiVersion: 'stagefabric.dev/v1alpha1' as const,
  kind: 'RuntimeQualificationProfile' as const,
  limits: {
    totalTimeoutMs: 2_000,
    maxConcurrency: 1,
    maxTargets: 1,
    maxOperations: 1,
    maxGenerationOutputTokensPerCall: 64,
  },
  targets: [{ targetId: 'edge-a', operations: ['summarize'] }],
};

interface FixturePaths {
  readonly directory: string;
  readonly bundle: string;
  readonly bindings: string;
  readonly snapshot: string;
  readonly qualificationReport: string;
  readonly profile: string;
  readonly trustPolicy: string;
  readonly challenge: string;
  readonly attestationBundle: string;
  readonly challengeStore: string;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'stagefabric-auth-cli-'));
  directories.push(directory);
  const paths: FixturePaths = {
    directory,
    bundle: join(directory, 'live.yaml'),
    bindings: join(directory, 'bindings.yaml'),
    snapshot: join(directory, 'snapshot.json'),
    qualificationReport: join(directory, 'qualification.json'),
    profile: join(directory, 'profile.yaml'),
    trustPolicy: join(directory, 'trust-policy.yaml'),
    challenge: join(directory, 'challenge.json'),
    attestationBundle: join(directory, 'attestation.sigstore.json'),
    challengeStore: join(directory, 'challenge-store'),
  };
  await mkdir(paths.challengeStore, { mode: 0o700 });

  const bindings = runtimeBindings();
  const snapshot = sealCapabilitySnapshot({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'CapabilitySnapshot',
    bindingDigest: bindings.digest,
    observedAt: '2026-07-17T10:00:10.000Z',
    expiresAt: '2026-07-17T10:02:10.000Z',
    targets: [
      {
        targetId: 'edge-a',
        healthy: true,
        capabilities: ['text-generation', 'stagefabric.operation/summarize'],
      },
    ],
  });
  const qualificationReport = sealRuntimeQualificationReport({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'RuntimeQualificationReport',
    bindingDigest: bindings.digest,
    profileDigest:
      computeRuntimeQualificationProfileDigest(qualificationProfile),
    qualificationScope: 'configured-wire-shape-v1',
    producer: { id: 'stagefabric-runtime-qualification', version: '1' },
    qualified: true,
    results: [
      {
        targetId: 'edge-a',
        operation: 'summarize',
        operationKind: 'generate-text',
        status: 'qualified',
        reasonCode: 'qualified',
        qualifier: { kind: 'openai-compatible', version: 'test-v1' },
      },
    ],
  });
  const trustPolicy = capabilitySnapshotTrustPolicySchema.parse({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'CapabilitySnapshotTrustPolicy',
    certificateIssuer: signer.issuer,
    signerIdentity: { type: signer.identityType, value: signer.identity },
    audience: 'stagefabric:test-control-plane',
    certificateThreshold: 1,
    transparencyLogThreshold: 1,
    fabricDigest: computeCapabilitySnapshotFabricDigest(fabric),
    qualificationProfileDigest:
      computeRuntimeQualificationProfileDigest(qualificationProfile),
    maxSnapshotAgeSeconds: 180,
    maxSnapshotTtlSeconds: 180,
    clockSkewSeconds: 5,
  });
  const challenge = capabilitySnapshotChallengeReceiptSchema.parse({
    value: 'A'.repeat(43),
    audience: trustPolicy.audience,
    issuedAt: '2026-07-17T10:00:00.000Z',
    expiresAt: '2026-07-17T10:04:00.000Z',
  });
  const statement = createCapabilitySnapshotAttestationStatement({
    fabric,
    snapshot,
    bindings,
    qualificationReport,
    qualificationProfile,
    trustPolicy,
    challenge,
  });
  const evidence = verifyCapabilitySnapshotAttestationSemantics({
    statement,
    fabric,
    snapshot,
    bindings,
    qualificationReport,
    qualificationProfile,
    trustPolicy,
    expectedChallenge: challenge,
    evaluatedAt: '2026-07-17T10:00:20.000Z',
  });
  const trust = Object.freeze({
    authorizationDigest: sha256Digest({ kind: 'CliTestAuthorization' }),
    evidence,
    signer,
  } satisfies AuthenticatedCapabilitySnapshot);
  const plan = planStageGraph({
    fabric,
    graph,
    snapshot,
    evaluatedAt: '2026-07-17T10:00:20.000Z',
  });

  await Promise.all([
    writeFile(
      paths.bundle,
      stringify({
        fabric,
        graph,
        inputs: { prompt: 'cli-input-sentinel' },
      }),
      'utf8',
    ),
    writeFile(paths.bindings, stringify(bindings), 'utf8'),
    writeFile(paths.snapshot, JSON.stringify(snapshot), 'utf8'),
    writeFile(
      paths.qualificationReport,
      JSON.stringify(qualificationReport),
      'utf8',
    ),
    writeFile(paths.profile, stringify(qualificationProfile), 'utf8'),
    writeFile(paths.trustPolicy, stringify(trustPolicy), 'utf8'),
    writeFile(paths.challenge, JSON.stringify(challenge), 'utf8'),
    writeFile(paths.attestationBundle, new Uint8Array([1, 2, 3])),
  ]);
  return {
    paths,
    bindings,
    snapshot,
    qualificationReport,
    trustPolicy,
    challenge,
    statement,
    trust,
    plan,
  };
}

function evidenceArguments(paths: FixturePaths): string[] {
  return [
    '--bindings',
    paths.bindings,
    '--snapshot',
    paths.snapshot,
    '--qualification-report',
    paths.qualificationReport,
    '--profile',
    paths.profile,
    '--trust-policy',
    paths.trustPolicy,
    '--challenge',
    paths.challenge,
  ];
}

async function invoke(
  arguments_: readonly string[],
  dependencies: AuthenticatedCliDependencies = {},
) {
  let output = '';
  let errors = '';
  const io = {
    writeOut: (value: string) => {
      output += value;
    },
    writeErr: (value: string) => {
      errors += value;
    },
  };
  const program = new Command()
    .name('stagefabric')
    .exitOverride()
    .configureOutput({
      writeOut: io.writeOut,
      writeErr: io.writeErr,
      outputError: (value, write) => write(value),
    });
  registerAuthenticatedSnapshotCommands(program, io, dependencies);
  await program.parseAsync(['node', 'stagefabric', ...arguments_]);
  return { output, errors };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('authenticated snapshot CLI commands', () => {
  it('issues no raw challenge output and observes a sealed live snapshot', async () => {
    const inputs = await fixture();
    const issuedPath = join(inputs.paths.directory, 'issued-challenge.json');
    const issued = await invoke(
      [
        'challenge',
        'issue',
        '--output',
        issuedPath,
        '--audience',
        inputs.challenge.audience,
        '--ttl-seconds',
        '90',
      ],
      {
        now: () => new Date('2026-07-17T10:00:00.000Z'),
        random: () => new Uint8Array(32).fill(7),
      },
    );
    const rawChallenge = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
    expect(JSON.parse(issued.output)).toMatchObject({
      issued: true,
      audience: inputs.challenge.audience,
      issuedAt: '2026-07-17T10:00:00.000Z',
      expiresAt: '2026-07-17T10:01:30.000Z',
    });
    expect(issued.output).not.toContain(rawChallenge);
    expect(await readFile(issuedPath, 'utf8')).toContain(rawChallenge);
    expect((await stat(issuedPath)).mode & 0o077).toBe(0);

    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ data: [{ id: 'summary-live' }] }),
    );
    const observed = await invoke(
      ['observe', inputs.paths.bundle, '--bindings', inputs.paths.bindings],
      {
        now: () => new Date('2026-07-17T10:00:10.000Z'),
        fetch,
      },
    );
    expect(JSON.parse(observed.output)).toMatchObject({
      kind: 'CapabilitySnapshot',
      bindingDigest: inputs.bindings.digest,
      observedAt: '2026-07-17T10:00:10.000Z',
      targets: [
        {
          targetId: 'edge-a',
          healthy: true,
          capabilities: ['stagefabric.operation/summarize', 'text-generation'],
        },
      ],
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(`${issued.errors}${observed.errors}`).toBe('');
  });

  it('writes only the deterministic canonical statement bytes', async () => {
    const inputs = await fixture();
    const result = await invoke([
      'attestation-statement',
      inputs.paths.bundle,
      ...evidenceArguments(inputs.paths),
    ]);

    expect(result.output).toBe(`${canonicalJson(inputs.statement)}\n`);
    expect(result.output).not.toContain(inputs.challenge.value);
    expect(result.errors).toBe('');
  });

  it('derives a strict trust policy from replaceable deployment inputs', async () => {
    const inputs = await fixture();
    const result = await invoke([
      'trust-policy',
      'create',
      inputs.paths.bundle,
      '--bindings',
      inputs.paths.bindings,
      '--profile',
      inputs.paths.profile,
      '--certificate-issuer',
      signer.issuer,
      '--identity-uri',
      signer.identity,
      '--audience',
      inputs.challenge.audience,
      '--max-snapshot-age-seconds',
      '180',
      '--max-snapshot-ttl-seconds',
      '180',
    ]);

    expect(JSON.parse(result.output)).toEqual(inputs.trustPolicy);
    expect(result.errors).toBe('');
  });

  it('wires authenticated planning and execution through injected boundaries', async () => {
    const inputs = await fixture();
    const verifier: CapabilitySnapshotAttestationVerifier = {
      verify: vi.fn(async () => ({
        payloadType: IN_TOTO_STATEMENT_PAYLOAD_TYPE,
        payload: new TextEncoder().encode(canonicalJson(inputs.statement)),
        signer,
      })),
    };
    const consumer: CapabilitySnapshotChallengeConsumer = {
      consume: vi.fn(async () => true),
    };
    const createAttestationVerifier = vi.fn(async () => {
      // The command must already hold its copied bytes and must not reopen this
      // path after verifier construction.
      await writeFile(
        inputs.paths.attestationBundle,
        new Uint8Array([9, 9, 9]),
      );
      return verifier;
    });
    const createChallengeConsumer = vi.fn(() => consumer);
    const planAuthenticated = vi.fn(async (request) => {
      expect([...request.attestationBundle]).toEqual([1, 2, 3]);
      return {
        bindingDigest: inputs.bindings.digest,
        plan: inputs.plan,
        trust: inputs.trust,
      };
    });
    const runResult = {
      bindingDigest: inputs.bindings.digest,
      plan: inputs.plan,
      trust: inputs.trust,
      execution: {
        planDigest: inputs.plan.digest,
        stages: [{ stageId: 'summarize', targetId: 'edge-a', zone: 'edge' }],
        trace: [],
      },
      outputs: { 'summarize.answer': 'Authenticated CLI answer.' },
    } satisfies AuthenticatedLiveRunResult;
    const runAuthenticated = vi.fn(async (request, options) => {
      expect([...request.attestationBundle]).toEqual([1, 2, 3]);
      expect(options.challengeConsumer).toBe(consumer);
      return runResult;
    });
    const dependencies = {
      now: () => new Date('2026-07-17T10:00:20.000Z'),
      createAttestationVerifier,
      createChallengeConsumer,
      planAuthenticated,
      runAuthenticated,
    } satisfies AuthenticatedCliDependencies;
    const authenticatedArguments = [
      ...evidenceArguments(inputs.paths),
      '--attestation-bundle',
      inputs.paths.attestationBundle,
    ];

    const planned = await invoke(
      ['plan-authenticated', inputs.paths.bundle, ...authenticatedArguments],
      dependencies,
    );
    expect(planAuthenticated).toHaveBeenCalledOnce();
    expect(createChallengeConsumer).not.toHaveBeenCalled();
    expect(JSON.parse(planned.output)).toMatchObject({
      plan: { digest: inputs.plan.digest },
      evidence: { authorizationDigest: inputs.trust.authorizationDigest },
    });

    await writeFile(inputs.paths.attestationBundle, new Uint8Array([1, 2, 3]));
    const executed = await invoke(
      [
        'run-authenticated',
        inputs.paths.bundle,
        ...authenticatedArguments,
        '--challenge-store',
        inputs.paths.challengeStore,
      ],
      dependencies,
    );
    expect(runAuthenticated).toHaveBeenCalledOnce();
    expect(createChallengeConsumer).toHaveBeenCalledWith(
      inputs.paths.challengeStore,
    );
    expect(JSON.parse(executed.output)).toMatchObject({
      graphName: 'authenticated-cli',
      planDigest: inputs.plan.digest,
      evidence: { authorizationDigest: inputs.trust.authorizationDigest },
      outputs: { 'summarize.answer': 'Authenticated CLI answer.' },
    });
    expect(`${planned.output}${executed.output}`).not.toContain(
      inputs.challenge.value,
    );
    expect(`${planned.output}${executed.output}`).not.toContain(
      'cli-input-sentinel',
    );
    expect(`${planned.errors}${executed.errors}`).toBe('');
  });
});
