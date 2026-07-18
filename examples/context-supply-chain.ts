import {
  benchmarkContextSupplyChain,
  runFrozenContextSupplyChain,
} from '../src/index.js';

const run = await runFrozenContextSupplyChain();
const benchmark = await benchmarkContextSupplyChain();

process.stdout.write(
  `${JSON.stringify(
    {
      stages: run.plan.stages.map((stage) => ({
        id: stage.stageId,
        target: stage.primary.targetId,
      })),
      planDigest: run.plan.digest,
      egressDigest: run.egressLedger.digest,
      receiptDigest: run.receipt.digest,
      evidence: run.reasoning.citations,
      answer: run.reasoning.answer,
      metrics: benchmark.methods,
      killGate: benchmark.killGate,
      spikeStatus: benchmark.killGate.passed ? 'pass' : 'fail',
    },
    null,
    2,
  )}\n`,
);
