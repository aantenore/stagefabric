#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { Command, CommanderError, InvalidArgumentError } from 'commander';

import { loadConfigBundle } from '../adapters/config-bundle.js';
import { planStageGraph } from '../application/planner.js';
import { runDemo } from '../composition/demo.js';
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
    .version('0.1.0')
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

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  void runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
