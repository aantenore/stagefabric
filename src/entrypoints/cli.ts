#!/usr/bin/env node
import { realpathSync } from 'node:fs';
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
import { runLiveStageGraph } from '../composition/live-runner.js';
import { qualifyConfiguredRuntime } from '../composition/runtime-qualification.js';
import { startStageFabricServer } from './api.js';
import { safeErrorBody } from './safe-error.js';

export interface CliIo {
  readonly writeOut: (value: string) => void;
  readonly writeErr: (value: string) => void;
}

const defaultIo: CliIo = {
  writeOut: (value) => process.stdout.write(value),
  writeErr: (value) => process.stderr.write(value),
};

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

export function createStageFabricCli(io: CliIo = defaultIo): Command {
  const program = new Command()
    .name('stagefabric')
    .description('Plan and execute privacy-safe hybrid AI stage graphs')
    .version('0.3.0-alpha.1')
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

  return program;
}

export async function runCli(
  argv: readonly string[] = process.argv,
  io: CliIo = defaultIo,
): Promise<number> {
  const program = createStageFabricCli(io).exitOverride();
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
