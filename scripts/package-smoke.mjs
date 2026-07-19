import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const staleArtifact = join(projectRoot, 'dist', '.stagefabric-stale-artifact');

function run(command, args, cwd, shell = false) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
    shell,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runPnpm(args, cwd) {
  const lifecycleExecutable = process.env.npm_execpath;
  if (
    lifecycleExecutable !== undefined &&
    basename(lifecycleExecutable).toLowerCase().includes('pnpm')
  ) {
    if (/\.[cm]?js$/i.test(lifecycleExecutable)) {
      return run(process.execPath, [lifecycleExecutable, ...args], cwd);
    }
    return run(
      lifecycleExecutable,
      args,
      cwd,
      process.platform === 'win32' && /\.cmd$/i.test(lifecycleExecutable),
    );
  }

  // Direct script execution has no lifecycle metadata. A shell is required
  // only on Windows because the standard pnpm shim is a .cmd file.
  return run('pnpm', args, cwd, process.platform === 'win32');
}

async function walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'stagefabric-package-'));

try {
  const packDirectory = join(temporaryRoot, 'pack');
  const consumerDirectory = join(temporaryRoot, 'consumer');
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(consumerDirectory, { recursive: true }),
  ]);

  await mkdir(join(projectRoot, 'dist'), { recursive: true });
  await writeFile(staleArtifact, 'must not be packed\n');

  runPnpm(['pack', '--pack-destination', packDirectory], projectRoot);
  const tarballs = (await readdir(packDirectory)).filter((name) =>
    name.endsWith('.tgz'),
  );
  assert.equal(tarballs.length, 1, 'pack must produce exactly one tarball');
  const tarball = join(packDirectory, tarballs[0]);

  await writeFile(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
  );
  runPnpm(
    // This prefers the warmed CI store but intentionally allows registry
    // fallback. It is a packed-consumer smoke test, not an air-gapped proof.
    ['add', '--prefer-offline', '--ignore-scripts', '--save-exact', tarball],
    consumerDirectory,
  );

  const installedRoot = join(consumerDirectory, 'node_modules', 'stagefabric');
  const installedRealPath = await realpath(installedRoot);
  assert.notEqual(
    installedRealPath,
    await realpath(projectRoot),
    'consumer must load the packed artifact, not the workspace checkout',
  );

  const installedMetadata = JSON.parse(
    await readFile(join(installedRoot, 'package.json'), 'utf8'),
  );
  assert.equal(installedMetadata.name, 'stagefabric');
  assert.equal(
    basename(tarball),
    `stagefabric-${installedMetadata.version}.tgz`,
  );

  const consumerProgram = join(consumerDirectory, 'consumer-smoke.mjs');
  await writeFile(
    consumerProgram,
    [
      "import assert from 'node:assert/strict';",
      "import * as root from 'stagefabric';",
      "import * as core from 'stagefabric/core';",
      "import * as node from 'stagefabric/node';",
      "import * as browser from 'stagefabric/browser';",
      "import * as transformers from 'stagefabric/browser/transformers';",
      "assert.equal(typeof root.planStageGraph, 'function');",
      "assert.equal(typeof core.planStageGraph, 'function');",
      "assert.equal(typeof core.sealContextRequest, 'function');",
      "assert.equal(typeof core.sealContextArtifact, 'function');",
      "assert.equal(typeof core.sealContextRunReceipt, 'function');",
      "assert.equal(typeof core.parseExecutionPlacementEvidence, 'function');",
      "assert.equal(typeof core.verifyExecutionPlacementEvidenceDigest, 'function');",
      "assert.equal(typeof root.createExecutionPlacementEvidence, 'function');",
      "assert.equal(typeof root.writeExecutionPlacementEvidenceFile, 'function');",
      "assert.equal(typeof root.runFrozenContextSupplyChain, 'function');",
      "assert.equal(typeof root.benchmarkContextSupplyChain, 'function');",
      "assert.equal(typeof root.PageIndexContextStageAdapter, 'function');",
      "assert.equal(typeof node.createStageFabricApp, 'function');",
      "assert.equal(typeof node.createBrowserDemoApp, 'function');",
      "assert.equal(typeof browser.BrowserPrivacyBridge, 'function');",
      "assert.equal(typeof browser.redactWithCascade, 'function');",
      "assert.equal(typeof transformers.TransformersSensitiveSpanClassifier, 'function');",
      "assert.equal('createStageFabricApp' in core, false);",
      "assert.equal('writeExecutionPlacementEvidenceFile' in core, false);",
      '',
    ].join('\n'),
  );
  run(process.execPath, [consumerProgram], consumerDirectory);

  const cliVersion = runPnpm(
    ['exec', 'stagefabric', '--version'],
    consumerDirectory,
  ).trim();
  assert.equal(cliVersion, installedMetadata.version);
  assert.match(
    runPnpm(['exec', 'stagefabric', '--help'], consumerDirectory),
    /browser-demo/,
  );
  assert.match(
    runPnpm(['exec', 'stagefabric', '--help'], consumerDirectory),
    /context-demo/,
  );
  assert.match(
    runPnpm(['exec', 'stagefabric', 'run', '--help'], consumerDirectory),
    /--evidence-run-id/,
  );
  assert.match(
    runPnpm(['exec', 'stagefabric', 'run', '--help'], consumerDirectory),
    /--evidence-output/,
  );
  const contextDemo = JSON.parse(
    runPnpm(['exec', 'stagefabric', 'context-demo'], consumerDirectory),
  );
  assert.equal(contextDemo.stages.length, 4);
  assert.match(contextDemo.receiptDigest, /^sha256:[0-9a-f]{64}$/);
  const contextBenchmark = JSON.parse(
    runPnpm(['exec', 'stagefabric', 'context-benchmark'], consumerDirectory),
  );
  assert.equal(contextBenchmark.killGate.passed, true);
  assert.match(contextBenchmark.digest, /^sha256:[0-9a-f]{64}$/);
  const enforcedContextBenchmark = JSON.parse(
    runPnpm(
      ['exec', 'stagefabric', 'context-benchmark', '--enforce'],
      consumerDirectory,
    ),
  );
  assert.equal(enforcedContextBenchmark.killGate.passed, true);

  const validation = JSON.parse(
    runPnpm(
      [
        'exec',
        'stagefabric',
        'validate',
        join(installedRoot, 'examples', 'stagefabric.yaml'),
      ],
      consumerDirectory,
    ),
  );
  assert.equal(validation.valid, true);
  assert.equal(typeof validation.planDigest, 'string');

  const installedFiles = await walkFiles(join(installedRoot, 'dist'));
  assert.equal(
    installedFiles.some((path) => path.endsWith('.stagefabric-stale-artifact')),
    false,
    'build must clean stale dist files before packing',
  );
  const browserJavaScript = installedFiles.filter(
    (path) =>
      relative(installedRoot, path).startsWith(join('dist', 'browser')) &&
      path.endsWith('.js'),
  );
  assert.ok(browserJavaScript.length > 0, 'browser subpath must be published');
  for (const browserPath of browserJavaScript) {
    const source = await readFile(browserPath, 'utf8');
    assert.equal(
      /(?:from\s*|import\s*\()['"](?:node:|@hono\/node-server)/.test(source),
      false,
      `${relative(installedRoot, browserPath)} imports a Node-only module`,
    );
  }
  const sourceMaps = installedFiles.filter((path) => path.endsWith('.js.map'));
  assert.ok(
    sourceMaps.length > 0,
    'packed JavaScript must include source maps',
  );
  for (const sourceMapPath of sourceMaps) {
    const sourceMap = JSON.parse(await readFile(sourceMapPath, 'utf8'));
    assert.ok(
      Array.isArray(sourceMap.sources) && sourceMap.sources.length > 0,
      `${relative(installedRoot, sourceMapPath)} must name its sources`,
    );
    assert.equal(
      sourceMap.sourcesContent?.length,
      sourceMap.sources.length,
      `${relative(installedRoot, sourceMapPath)} must embed every source`,
    );
    assert.ok(
      sourceMap.sourcesContent.every((source) => typeof source === 'string'),
      `${relative(installedRoot, sourceMapPath)} has an unusable embedded source`,
    );
  }
  assert.equal(
    installedFiles.some((path) => path.endsWith('.d.ts.map')),
    false,
    'declaration maps must not point at unpublished TypeScript sources',
  );

  const cliPath = join(installedRoot, 'dist', 'entrypoints', 'cli.js');
  assert.ok(
    (await readFile(cliPath, 'utf8')).startsWith('#!/usr/bin/env node'),
  );
  if (process.platform !== 'win32') {
    await access(cliPath, constants.X_OK);
  }

  for (const requiredPath of [
    'CHANGELOG.md',
    'README.md',
    'LICENSE',
    join('docs', 'architecture.md'),
    join('docs', 'adr', '0005-browser-privacy-bridge.md'),
    join('docs', 'delivery-contract-v0.5-browser-privacy.md'),
    join('docs', 'adr', '0006-context-supply-chain.md'),
    join('docs', 'delivery-contract-v0.6-context-supply-chain.md'),
    join('docs', 'adr', '0007-content-free-execution-evidence.md'),
    join('docs', 'delivery-contract-v0.7-execution-evidence.md'),
    join('examples', 'stagefabric.yaml'),
    join('examples', 'context-supply-chain.ts'),
    join('dist', 'browser-demo', 'index.html'),
  ]) {
    await access(join(installedRoot, requiredPath), constants.R_OK);
  }

  const typeConsumer = join(consumerDirectory, 'consumer-smoke.ts');
  await writeFile(
    typeConsumer,
    [
      "import { planStageGraph } from 'stagefabric';",
      "import { PageIndexContextStageAdapter, benchmarkContextSupplyChain, runFrozenContextSupplyChain } from 'stagefabric';",
      "import { planStageGraph as planCoreStageGraph } from 'stagefabric/core';",
      "import { sealContextArtifact, sealContextRequest, sealContextRunReceipt } from 'stagefabric/core';",
      "import { parseExecutionPlacementEvidence, verifyExecutionPlacementEvidenceDigest } from 'stagefabric/core';",
      "import { createExecutionPlacementEvidence, writeExecutionPlacementEvidenceFile } from 'stagefabric';",
      "import { createStageFabricApp } from 'stagefabric/node';",
      "import { BrowserPrivacyBridge } from 'stagefabric/browser';",
      "import { TransformersSensitiveSpanClassifier } from 'stagefabric/browser/transformers';",
      'void planStageGraph;',
      'void PageIndexContextStageAdapter;',
      'void benchmarkContextSupplyChain;',
      'void runFrozenContextSupplyChain;',
      'void planCoreStageGraph;',
      'void sealContextArtifact;',
      'void sealContextRequest;',
      'void sealContextRunReceipt;',
      'void parseExecutionPlacementEvidence;',
      'void verifyExecutionPlacementEvidenceDigest;',
      'void createExecutionPlacementEvidence;',
      'void writeExecutionPlacementEvidenceFile;',
      'void createStageFabricApp;',
      'void BrowserPrivacyBridge;',
      'void TransformersSensitiveSpanClassifier;',
      '',
    ].join('\n'),
  );
  run(
    process.execPath,
    [
      join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2024',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      typeConsumer,
    ],
    consumerDirectory,
  );

  process.stdout.write(
    `Package smoke passed for stagefabric@${installedMetadata.version}\n`,
  );
} finally {
  await Promise.all([
    rm(temporaryRoot, { force: true, recursive: true }),
    rm(staleArtifact, { force: true }),
  ]);
}
