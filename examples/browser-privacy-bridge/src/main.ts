import {
  BrowserPrivacyBridge,
  BrowserPrivacyBridgeError,
  BrowserRuntimeDriverRegistry,
  probeBrowserCapabilities,
  type BrowserPrivacyLedgerProjection,
  type BrowserPrivacyPlanProjection,
  type PrivacyDecisionReceipt,
} from '../../../src/browser/index.js';

import {
  createDemoRuntimeSetup,
  DEMO_DRIVER_ID,
  DEMO_INPUT,
  DEMO_OPERATION,
  DEMO_RUNTIME_ID,
} from './demo-config.js';
import { DemoBrowserRuntimeDriver } from './demo-driver.js';
import './styles.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (app === null) throw new Error('app_root_missing');

app.innerHTML = `
  <a class="skip-link" href="#privacy-workspace">Skip to privacy workspace</a>
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">SF</div>
        <div class="brand-copy"><strong>StageFabric</strong><span>Browser Privacy Bridge · v${__STAGEFABRIC_VERSION__}</span></div>
      </div>
      <div class="runtime-strip" aria-label="Runtime capabilities">
        <span class="status" id="secure-status" data-state="checking">Secure context</span>
        <span class="status" id="wasm-status" data-state="checking">WASM</span>
        <span class="status" id="webgpu-status" data-state="checking">WebGPU optional</span>
        <span class="status" id="worker-status" data-state="checking">Worker idle</span>
      </div>
    </header>

    <section class="hero">
      <div>
        <div class="eyebrow">Local-first execution · verifiable release</div>
        <h1>See what leaves <span>the browser.</span></h1>
        <p class="hero-copy">Redact locally, rescan the exact output, and mint a content-free receipt before an application can release a single byte.</p>
      </div>
      <aside class="hero-proof">
        <strong>5 gates</strong>
        <p>One readable lineage from requested operation to capability check, Worker execution, redaction, verification, and exact-output permit.</p>
      </aside>
    </section>

    <section id="privacy-workspace" class="workspace" aria-label="Privacy bridge workspace" tabindex="-1">
      <div class="stack">
        <article class="panel" id="request-panel" data-step="01">
          <div class="panel-head">
            <div><span class="panel-kicker">01 · Request</span><h2>Untrusted browser input</h2></div>
            <span class="status" id="input-status" data-state="ready">Fictional sample</span>
          </div>
          <div class="panel-body">
            <label class="input-label" for="privacy-input"><span>Text sent only to the local Worker</span><output id="input-count" for="privacy-input" name="input-bytes">0 bytes</output></label>
            <textarea id="privacy-input" name="privacy-input" autocomplete="off" maxlength="16000" spellcheck="false"></textarea>
            <div class="controls">
              <div class="field">
                <label for="runtime-select">Bound runtime</label>
                <select id="runtime-select" name="runtime" autocomplete="off"><option value="local">Dedicated Worker · deterministic</option></select>
              </div>
              <div class="field">
                <label for="proof-select">Proof mode</label>
                <select id="proof-select" name="proof-mode" autocomplete="off">
                  <option value="verified">Verified exact output</option>
                  <option value="tamper">Mutate after receipt · must block</option>
                </select>
              </div>
            </div>
            <button class="primary-action" id="run-button" type="button"><span>Run privacy bridge</span><span aria-hidden="true">⌘↵</span></button>
            <div class="boundary-note"><strong>Trust note</strong><span>A Dedicated Worker is a killable execution boundary—not a hardware enclave, attestation mechanism, or sandbox from other same-origin code.</span></div>
          </div>
        </article>

        <article class="panel" data-step="03">
          <div class="panel-head"><div><span class="panel-kicker">03 · Evidence</span><h2>Sanitized result + receipt</h2></div><span class="status" id="egress-status">Not evaluated</span></div>
          <div id="run-error" class="run-error" role="alert" hidden></div>
          <div class="panel-body result-grid">
            <div class="output-box"><span class="meta-label">Exact candidate output</span><div id="output-placeholder" class="placeholder">Run the bridge to inspect sanitized bytes.</div><pre id="output-value" hidden></pre></div>
            <div class="receipt-box"><span class="meta-label">Content-free receipt</span><div id="receipt-placeholder" class="placeholder">No input, output, matched text, or original-input digest is retained here.</div><pre id="receipt-value" hidden></pre></div>
          </div>
        </article>
      </div>

      <div class="stack">
        <article class="panel" data-step="02">
          <div class="panel-head"><div><span class="panel-kicker">02 · Plan</span><h2>Bound execution path</h2></div><span class="status" id="plan-status">Awaiting run</span></div>
          <div class="plan-canvas">
            <div class="pipeline">
              <div class="stage-node" data-zone="browser"><span class="node-index">01 · Browser</span><h3>Capability probe</h3><p>Checks secure context and WASM without collecting device identity.</p><div class="node-meta"><span>payload: untrusted</span><span>network: none</span></div></div>
              <div class="connector"><span>eligible</span></div>
              <div class="stage-node" data-zone="browser"><span class="node-index">02 · Worker</span><h3>Redact + rescan</h3><p>Runs bounded rules, then scans the complete output again before issuing evidence.</p><div class="node-meta"><span>boundary: killable</span><span>model: none</span></div></div>
              <div class="connector egress"><span>receipt gate</span></div>
              <div class="stage-node" id="release-node" data-zone="cloud"><span class="node-index">03 · Release</span><h3>Exact-output permit</h3><p>Authorizes only bytes matching plan, runtime, operation, policies, and receipt.</p><div class="node-meta"><span id="release-meta">state: pending</span><span>side effect: simulated</span></div></div>
            </div>
          </div>
        </article>

        <article class="panel" data-step="04">
          <div class="panel-head"><div><span class="panel-kicker">04 · Lineage</span><h2 id="ledger-heading">Human-readable decision ledger</h2></div><span class="status" id="ledger-status">No events</span></div>
          <div class="ledger-scroll" role="region" aria-labelledby="ledger-heading" tabindex="0">
            <table class="ledger" id="ledger">
              <caption class="sr-only">Privacy decision ledger</caption>
              <thead>
                <tr class="ledger-row ledger-header">
                  <th scope="col">Step</th>
                  <th scope="col">Phase</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody id="ledger-body">
                <tr class="ledger-placeholder-row"><td colspan="4"><div class="placeholder">Capability, redaction, and egress decisions will appear here without payload content.</div></td></tr>
              </tbody>
            </table>
          </div>
        </article>
      </div>
    </section>
    <p class="sr-only" id="live-region" aria-live="polite"></p>
  </main>`;

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`missing_element:${selector}`);
  return element;
}

const input = requiredElement<HTMLTextAreaElement>('#privacy-input');
const runtimeSelect = requiredElement<HTMLSelectElement>('#runtime-select');
const proofSelect = requiredElement<HTMLSelectElement>('#proof-select');
const runButton = requiredElement<HTMLButtonElement>('#run-button');
const runButtonLabel = requiredElement<HTMLElement>(
  '#run-button span:first-child',
);
const requestPanel = requiredElement<HTMLElement>('#request-panel');
const inputCount = requiredElement<HTMLOutputElement>('#input-count');
const outputValue = requiredElement<HTMLElement>('#output-value');
const outputPlaceholder = requiredElement<HTMLElement>('#output-placeholder');
const receiptValue = requiredElement<HTMLElement>('#receipt-value');
const receiptPlaceholder = requiredElement<HTMLElement>('#receipt-placeholder');
const ledgerBody = requiredElement<HTMLTableSectionElement>('#ledger-body');
const errorBox = requiredElement<HTMLElement>('#run-error');
const liveRegion = requiredElement<HTMLElement>('#live-region');

const reasonLabels: Readonly<Record<string, string>> = Object.freeze({
  available: 'Required browser capabilities are ready.',
  bindings_digest_mismatch: 'Runtime bindings do not match the receipt.',
  capability_unavailable: 'A required browser capability is unavailable.',
  digest_and_policy_match:
    'Receipt, output, lineage, and policy evidence match.',
  egress_policy_mismatch: 'Release policy does not match the receipt.',
  execution_failed: 'Local Worker execution failed.',
  invalid_receipt: 'Receipt validation failed.',
  invalid_worker_result: 'Worker result did not satisfy the required contract.',
  lineage_mismatch: 'Plan, runtime, or operation lineage does not match.',
  output_digest_mismatch: 'The output changed after receipt issuance.',
  output_limit_exceeded: 'Sanitized output exceeded its configured limit.',
  post_output_verified: 'Sanitized output passed the complete policy rescan.',
  redaction_policy_mismatch: 'Redaction policy does not match the receipt.',
  runtime_not_registered: 'The bound runtime driver is unavailable.',
  secure_context_unavailable: 'A secure browser context is unavailable.',
  wasm_api_unavailable: 'WebAssembly is unavailable in this browser.',
  wasm_validation_failed: 'WebAssembly capability validation failed.',
  webgpu_adapter_unavailable: 'No compatible WebGPU adapter is available.',
  webgpu_api_unavailable: 'WebGPU is unavailable in this browser.',
  webgpu_probe_failed: 'The WebGPU capability check could not complete.',
});

const errorLabels: Readonly<Record<string, string>> = Object.freeze({
  bindings_invalid: 'The sealed runtime bindings could not be verified.',
  capability_unavailable: 'A required browser capability is unavailable.',
  egress_denied: 'The exact-output receipt did not authorize release.',
  execution_failed:
    'The local Worker could not complete the privacy operation.',
  input_limit_exceeded:
    'The input exceeds the configured local-processing limit.',
  invalid_request: 'The request could not be bound to a valid plan.',
  invalid_worker_result: 'The local Worker returned an invalid privacy result.',
  output_limit_exceeded:
    'The sanitized output exceeds the configured release limit.',
  runtime_not_bound: 'The selected runtime is not part of the sealed bindings.',
  runtime_not_registered: 'No driver is registered for the selected runtime.',
  unexpected_failure: 'An unexpected local failure stopped the release.',
});

let nextRunGeneration = 0;
let activeRunGeneration: number | undefined;

function setStatus(
  selector: string,
  label: string,
  state?: 'ready' | 'checking' | 'allowed' | 'blocked' | 'unavailable',
): void {
  const element = requiredElement<HTMLElement>(selector);
  element.textContent = label;
  if (state === undefined) element.removeAttribute('data-state');
  else element.dataset['state'] = state;
}

function updateInputCount(): void {
  inputCount.textContent = `${new TextEncoder().encode(input.value).byteLength.toLocaleString('en-US')} bytes`;
}

function shortDigest(value: string): string {
  return `${value.slice(0, 15)}…${value.slice(-8)}`;
}

function fallbackLabel(code: string): string {
  const words = code.replaceAll(/[_-]+/g, ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}

function reasonLabel(code: string): string {
  return reasonLabels[code] ?? fallbackLabel(code);
}

function errorLabel(code: string): string {
  return errorLabels[code] ?? errorLabels['unexpected_failure']!;
}

function phaseLabel(
  phase: BrowserPrivacyLedgerProjection['events'][number]['phase'],
): string {
  switch (phase) {
    case 'capability':
      return 'Browser capability';
    case 'redaction':
      return 'Local redaction';
    case 'egress':
      return 'Release gate';
  }
}

function outcomeLabel(
  outcome: BrowserPrivacyLedgerProjection['events'][number]['outcome'],
): string {
  switch (outcome) {
    case 'allowed':
      return 'Permitted';
    case 'blocked':
      return 'Blocked';
    case 'completed':
      return 'Completed';
  }
}

function receiptProjection(receipt: PrivacyDecisionReceipt): unknown {
  return {
    decisionId: receipt.decisionId,
    lineage: {
      planId: receipt.planId,
      runtimeId: receipt.runtimeId,
      operation: receipt.operation,
    },
    policyEvidence: {
      bindings: shortDigest(receipt.bindingsDigest),
      redaction: shortDigest(receipt.redactionPolicyDigest),
      egress: shortDigest(receipt.egressPolicyDigest),
    },
    outputEvidence: shortDigest(receipt.outputDigest),
    redactionSummary: receipt.summary,
    receipt: shortDigest(receipt.receiptDigest),
  };
}

function renderEvidence(output: string, receipt: PrivacyDecisionReceipt): void {
  outputPlaceholder.hidden = true;
  outputValue.hidden = false;
  outputValue.textContent = output;
  receiptPlaceholder.hidden = true;
  receiptValue.hidden = false;
  receiptValue.textContent = JSON.stringify(
    receiptProjection(receipt),
    null,
    2,
  );
}

function renderPlan(plan: BrowserPrivacyPlanProjection): void {
  setStatus('#plan-status', `${plan.steps.length} bound gates`, 'ready');
}

function renderLedger(ledger: BrowserPrivacyLedgerProjection): void {
  ledgerBody.replaceChildren();

  for (const event of ledger.events) {
    const row = document.createElement('tr');
    row.className = 'ledger-row';
    row.dataset['sequence'] = String(event.sequence);

    const sequence = document.createElement('th');
    sequence.scope = 'row';
    sequence.className = 'ledger-time';
    sequence.textContent = `#${String(event.sequence).padStart(2, '0')}`;

    const phase = document.createElement('td');
    phase.dataset['phase'] = event.phase;
    phase.textContent = phaseLabel(event.phase);

    const reason = document.createElement('td');
    reason.dataset['reasonCodes'] = event.reasonCodes.join(' ');
    reason.textContent = event.reasonCodes.map(reasonLabel).join(' ');

    const outcome = document.createElement('td');
    outcome.className = 'ledger-code';
    outcome.dataset['outcome'] = event.outcome;
    outcome.textContent = outcomeLabel(event.outcome);
    row.append(sequence, phase, reason, outcome);
    ledgerBody.append(row);
  }
  setStatus(
    '#ledger-status',
    `${ledger.events.length} content-free events`,
    'ready',
  );
}

function resetLedger(): void {
  const row = document.createElement('tr');
  row.className = 'ledger-placeholder-row';
  const cell = document.createElement('td');
  cell.colSpan = 4;
  const placeholder = document.createElement('div');
  placeholder.className = 'placeholder';
  placeholder.textContent =
    'Capability, redaction, and egress decisions will appear here without payload content.';
  cell.append(placeholder);
  row.append(cell);
  ledgerBody.replaceChildren(row);
  setStatus('#ledger-status', 'No events');
}

function setRunControlsDisabled(disabled: boolean): void {
  input.disabled = disabled;
  runtimeSelect.disabled = disabled;
  proofSelect.disabled = disabled;
  runButton.disabled = disabled;
  requestPanel.setAttribute('aria-busy', String(disabled));
  requestPanel.dataset['runState'] = disabled ? 'running' : 'idle';
  runButtonLabel.textContent = disabled
    ? 'Running privacy bridge…'
    : 'Run privacy bridge';
}

function resetRun(): void {
  errorBox.hidden = true;
  errorBox.textContent = '';
  errorBox.removeAttribute('data-error-code');
  outputValue.hidden = true;
  outputValue.textContent = '';
  outputPlaceholder.hidden = false;
  receiptValue.hidden = true;
  receiptValue.textContent = '';
  receiptPlaceholder.hidden = false;
  const releaseNode = requiredElement<HTMLElement>('#release-node');
  releaseNode.removeAttribute('data-state');
  requiredElement<HTMLElement>('#release-meta').textContent = 'state: pending';
  resetLedger();
  setStatus('#worker-status', 'Worker running', 'checking');
  setStatus('#egress-status', 'Evaluating', 'checking');
  setStatus('#plan-status', 'Binding plan', 'checking');
}

function renderRelease(allowed: boolean): void {
  const node = requiredElement<HTMLElement>('#release-node');
  const meta = requiredElement<HTMLElement>('#release-meta');
  node.dataset['state'] = allowed ? 'allowed' : 'blocked';
  meta.textContent = allowed ? 'state: permitted' : 'state: blocked';
  setStatus(
    '#egress-status',
    allowed ? 'Exact output permitted' : 'Egress blocked',
    allowed ? 'allowed' : 'blocked',
  );
}

async function runBridge(): Promise<void> {
  if (activeRunGeneration !== undefined) return;

  const generation = ++nextRunGeneration;
  const inputSnapshot = input.value;
  const proofMode = proofSelect.value;
  activeRunGeneration = generation;
  requestPanel.dataset['runGeneration'] = String(generation);
  setRunControlsDisabled(true);
  resetRun();
  liveRegion.textContent = 'Privacy bridge is running locally.';
  try {
    const { bindings } = await createDemoRuntimeSetup();
    const driver = new DemoBrowserRuntimeDriver({
      driverId: DEMO_DRIVER_ID,
      tamperOutput: proofMode === 'tamper',
    });
    const bridge = new BrowserPrivacyBridge({
      bindings,
      drivers: new BrowserRuntimeDriverRegistry([driver]),
    });
    const runId = crypto.randomUUID();
    const result = await bridge.execute({
      planId: `plan.${runId}`,
      decisionId: `decision.${runId}`,
      runtimeId: DEMO_RUNTIME_ID,
      operation: DEMO_OPERATION,
      input: inputSnapshot,
    });
    if (activeRunGeneration !== generation) return;
    renderPlan(result.plan);
    renderEvidence(result.output, result.receipt);
    renderLedger(result.ledger);
    renderRelease(true);
    setStatus('#worker-status', 'Worker completed', 'ready');
    liveRegion.textContent = `Privacy bridge completed. ${result.receipt.summary.redactionCount} sensitive spans removed; exact output permitted.`;
  } catch (error) {
    if (activeRunGeneration !== generation) return;
    const bridgeError =
      error instanceof BrowserPrivacyBridgeError ? error : undefined;
    if (bridgeError?.ledger !== undefined) renderLedger(bridgeError.ledger);
    renderRelease(false);
    setStatus('#worker-status', 'Worker closed', 'ready');
    setStatus('#plan-status', 'Fail-closed decision', 'blocked');
    const errorCode = bridgeError?.code ?? 'unexpected_failure';
    errorBox.hidden = false;
    errorBox.dataset['errorCode'] = errorCode;
    errorBox.textContent = `Release denied. ${errorLabel(errorCode)} No network side effect occurred.`;
    liveRegion.textContent = errorBox.textContent;
  } finally {
    if (activeRunGeneration === generation) {
      activeRunGeneration = undefined;
      setRunControlsDisabled(false);
    }
  }
}

async function probeCapabilities(): Promise<void> {
  const snapshot = await probeBrowserCapabilities({
    secureContext: true,
    webGpu: false,
    wasm: true,
  });
  for (const capability of snapshot.capabilities) {
    const selector =
      capability.capability === 'secure-context'
        ? '#secure-status'
        : capability.capability === 'webgpu'
          ? '#webgpu-status'
          : '#wasm-status';
    const label =
      capability.capability === 'webgpu'
        ? `WebGPU ${capability.available ? 'available' : 'optional'}`
        : `${capability.capability === 'secure-context' ? 'Secure context' : 'WASM'} ${capability.available ? 'ready' : 'unavailable'}`;
    setStatus(
      selector,
      label,
      capability.available
        ? 'ready'
        : capability.required
          ? 'unavailable'
          : undefined,
    );
  }
}

input.value = DEMO_INPUT;
updateInputCount();
setRunControlsDisabled(false);
input.addEventListener('input', updateInputCount);
runButton.addEventListener('click', () => void runBridge());
input.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    void runBridge();
  }
});
void probeCapabilities();
