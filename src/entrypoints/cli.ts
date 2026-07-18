#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Command, CommanderError, InvalidArgumentError } from 'commander';

import { loadConfigBundle } from '../adapters/config-bundle.js';
import {
  loadLiveRunBundle,
  loadRuntimeBindingsFile,
} from '../adapters/live-run-bundle.js';
import { loadRuntimeQualificationProfile } from '../adapters/runtime-qualification-profile.js';
import { planStageGraph } from '../application/planner.js';
import { RuntimeQualificationError } from '../application/runtime-qualification.js';
import { runDemo } from '../composition/demo.js';
import { benchmarkContextSupplyChain } from '../composition/context-supply-chain-benchmark.js';
import { runFrozenContextSupplyChain } from '../composition/context-supply-chain.js';
import { runLiveStageGraph } from '../composition/live-runner.js';
import { qualifyConfiguredRuntime } from '../composition/runtime-qualification.js';
import { startStageFabricServer } from './api.js';
import { startBrowserDemoServer } from './browser-demo.js';
import {
  registerAuthenticatedSnapshotCommands,
  type AuthenticatedCliDependencies,
} from './authenticated-cli.js';
import { safeErrorBody } from './safe-error.js';

export interface CliIo {
  readonly writeOut: (value: string) => void;
  readonly writeErr: (value: string) => void;
}

const defaultIo: CliIo = {
  writeOut: (value) => process.stdout.write(value),
  writeErr: (value) => process.stderr.write(value),
};

function readPackageVersion(): string {
  let metadata: unknown;
  try {
    metadata = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
  } catch {
    throw new Error('StageFabric package metadata is unreadable');
  }

  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    !('version' in metadata) ||
    typeof metadata.version !== 'string' ||
    metadata.version.trim() === ''
  ) {
    throw new Error('StageFabric package metadata has no valid version');
  }
  return metadata.version;
}

export const STAGEFABRIC_VERSION = readPackageVersion();

function writeJson(write: (value: string) => void, value: unknown): void {
  write(`${JSON.stringify(value, null, 2)}\n`);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new InvalidArgumentError(
      'port must be an integer between 1 and 65535',
    );
  }
  return port;
}

export function createStageFabricCli(
  io: CliIo = defaultIo,
  dependencies: AuthenticatedCliDependencies = {},
): Command {
  const program = new Command()
    .name('stagefabric')
    .description('Plan and execute privacy-safe hybrid AI stage graphs')
    .version(STAGEFABRIC_VERSION)
    .showSuggestionAfterError()
    .configureOutput({
      writeOut: io.writeOut,
      writeErr: io.writeErr,
      outputError: (value, write) => write(value),
    });

  program
    .command('validate')
    .description('Validate and compile a StageFabric YAML bundle')
    .argument('<bundle>', 'path to a YAML config bundle')
    .action(async (bundlePath: string) => {
      const plan = planStageGraph(await loadConfigBundle(bundlePath));
      writeJson(io.writeOut, {
        valid: true,
        graphName: plan.graphName,
        planDigest: plan.digest,
      });
    });

  program
    .command('plan')
    .description('Compile a StageFabric YAML bundle into an execution plan')
    .argument('<bundle>', 'path to a YAML config bundle')
    .action(async (bundlePath: string) => {
      writeJson(
        io.writeOut,
        planStageGraph(await loadConfigBundle(bundlePath)),
      );
    });

  program
    .command('run')
    .description(
      'Probe trusted runtime bindings, compile a fresh plan, and execute it',
    )
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
      const result = await runLiveStageGraph({ ...bundle, bindings });
      writeJson(io.writeOut, {
        graphName: result.plan.graphName,
        bindingDigest: result.bindingDigest,
        snapshotDigest: result.snapshot.digest,
        planDigest: result.plan.digest,
        placements: result.execution.stages.map((stage) => ({
          stageId: stage.stageId,
          targetId: stage.targetId,
          zone: stage.zone,
        })),
        outputs: result.outputs,
        trace: result.execution.trace,
      });
    });

  program
    .command('qualify')
    .description('Run the bounded, opt-in runtime operation qualification gate')
    .requiredOption(
      '--bindings <path>',
      'operator-owned sealed or sealable runtime bindings file',
    )
    .requiredOption(
      '--profile <path>',
      'strict qualification profile with explicit targets and operations',
    )
    .action(async (options: { bindings: string; profile: string }) => {
      const [bindings, profile] = await Promise.all([
        loadRuntimeBindingsFile(options.bindings),
        loadRuntimeQualificationProfile(options.profile),
      ]);
      const report = await qualifyConfiguredRuntime({ bindings, profile });
      writeJson(io.writeOut, report);
      if (!report.qualified) {
        throw new RuntimeQualificationError('qualification_failed');
      }
    });

  program
    .command('demo')
    .description('Run the deterministic five-stage privacy and fallback demo')
    .option(
      '--leaky',
      'use an intentionally unsafe redactor to prove fail-closed behavior',
    )
    .action(async (commandOptions: { leaky?: boolean }) => {
      writeJson(
        io.writeOut,
        await runDemo({ leakyRedactor: commandOptions.leaky === true }),
      );
    });

  program
    .command('context-demo')
    .description('Run the deterministic Context Supply Chain reference slice')
    .action(async () => {
      const result = await runFrozenContextSupplyChain();
      writeJson(io.writeOut, {
        requestId: result.artifact.requestId,
        planDigest: result.plan.digest,
        egressDigest: result.egressLedger.digest,
        stages: result.plan.stages.map((stage) => ({
          stageId: stage.stageId,
          targetId: stage.primary.targetId,
          zone: stage.primary.zone,
        })),
        artifactDigest: result.artifact.digest,
        receiptDigest: result.receipt.digest,
        evidenceLocators: result.artifact.evidence.map(
          (evidence) => evidence.evidenceLocator,
        ),
        inputAccounting: result.artifact.accounting,
        consolidatedAccounting: result.receipt.accounting,
        answer: result.reasoning.answer,
        citations: result.reasoning.citations,
      });
    });

  program
    .command('context-benchmark')
    .description('Report the frozen Context Supply Chain quality and cost gate')
    .option('--enforce', 'return a non-zero status when the spike gate fails')
    .action(async (commandOptions: { enforce?: boolean }) => {
      const report = await benchmarkContextSupplyChain();
      writeJson(io.writeOut, report);
      if (commandOptions.enforce === true && !report.killGate.passed) {
        throw new Error('context_supply_chain_kill_gate_failed');
      }
    });

  program
    .command('browser-demo')
    .description('Serve the local Browser Privacy Bridge reference app')
    .option('--host <host>', 'bind host', '127.0.0.1')
    .option('--port <port>', 'bind port', parsePort, 4173)
    .action((commandOptions: { host: string; port: number }) => {
      startBrowserDemoServer({
        host: commandOptions.host,
        port: commandOptions.port,
      });
      writeJson(io.writeOut, {
        listening: true,
        app: 'browser-privacy-bridge',
        host: commandOptions.host,
        port: commandOptions.port,
      });
    });

  program
    .command('serve')
    .description('Serve the StageFabric planning and demo API')
    .option('--host <host>', 'bind host', '127.0.0.1')
    .option('--port <port>', 'bind port', parsePort, 8787)
    .action((commandOptions: { host: string; port: number }) => {
      startStageFabricServer({
        host: commandOptions.host,
        port: commandOptions.port,
      });
      writeJson(io.writeOut, {
        listening: true,
        host: commandOptions.host,
        port: commandOptions.port,
      });
    });

  registerAuthenticatedSnapshotCommands(program, io, dependencies);
  return program;
}

export async function runCli(
  argv: readonly string[] = process.argv,
  io: CliIo = defaultIo,
  dependencies: AuthenticatedCliDependencies = {},
): Promise<number> {
  const program = createStageFabricCli(io, dependencies).exitOverride();
  try {
    await program.parseAsync([...argv]);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    writeJson(io.writeErr, safeErrorBody(error));
    return 1;
  }
}

type Realpath = (path: string) => string;

/** Handles package-manager bin symlinks without treating an import as execution. */
export function isDirectCliInvocation(
  moduleUrl: string,
  invokedPath: string | undefined,
  realpath: Realpath = realpathSync,
): boolean {
  if (invokedPath === undefined) return false;
  try {
    return realpath(fileURLToPath(moduleUrl)) === realpath(invokedPath);
  } catch {
    return false;
  }
}

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  void runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
