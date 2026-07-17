import { expect, test, type Page } from '@playwright/test';

function observePage(page: Page): {
  readonly consoleErrors: string[];
  readonly externalRequests: string[];
} {
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4173/')) {
      externalRequests.push(request.url());
    }
  });
  return { consoleErrors, externalRequests };
}

test('redacts locally and authorizes only the verified output', async ({
  page,
}) => {
  const observations = observePage(page);
  await page.goto('/');

  await expect(page).toHaveTitle(/StageFabric · Browser Privacy Bridge/);
  await expect(
    page.getByRole('heading', { name: 'See what leaves the browser.' }),
  ).toBeVisible();
  await expect(page.locator('#output-placeholder')).toBeVisible();
  await expect(page.locator('#receipt-placeholder')).toBeVisible();
  await expect(page.locator('#output-value')).toBeHidden();
  await expect(page.locator('#receipt-value')).toBeHidden();
  expect(
    await page
      .locator('#output-value')
      .evaluate((element) => getComputedStyle(element).display),
  ).toBe('none');
  await page.getByRole('button', { name: 'Run privacy bridge' }).click();

  await expect(page.locator('#egress-status')).toHaveText(
    'Exact output permitted',
  );
  await expect(page.locator('#output-placeholder')).toBeHidden();
  await expect(page.locator('#receipt-placeholder')).toBeHidden();
  expect(
    await page
      .locator('#output-placeholder')
      .evaluate((element) => getComputedStyle(element).display),
  ).toBe('none');
  await expect(page.locator('#output-value')).toContainText('[EMAIL REDACTED]');
  await expect(page.locator('#output-value')).toContainText('[PHONE REDACTED]');
  await expect(page.locator('#output-value')).toContainText(
    '[SECRET REDACTED]',
  );
  await expect(page.locator('#output-value')).not.toContainText(
    'mira.chen@example.test',
  );
  await expect(page.locator('#receipt-value')).toContainText('decisionId');
  await expect(page.locator('#receipt-value')).not.toContainText(
    'mira.chen@example.test',
  );
  await expect(page.locator('#ledger .ledger-row')).toHaveCount(4);
  await expect(
    page.locator('[data-reason-codes~="digest_and_policy_match"]'),
  ).toContainText('Receipt, output, lineage, and policy evidence match.');
  await expect(page.locator('#ledger')).not.toContainText(
    'digest_and_policy_match',
  );
  expect(observations.consoleErrors).toEqual([]);
  expect(observations.externalRequests).toEqual([]);
});

test('blocks output changed after receipt issuance', async ({ page }) => {
  const observations = observePage(page);
  await page.goto('/');
  await page
    .getByLabel('Proof mode')
    .selectOption({ label: 'Mutate after receipt · must block' });
  await page.getByRole('button', { name: 'Run privacy bridge' }).click();

  await expect(page.locator('#egress-status')).toHaveText('Egress blocked');
  await expect(page.getByRole('alert')).toContainText(
    'Release denied. The exact-output receipt did not authorize release.',
  );
  await expect(page.getByRole('alert')).toHaveAttribute(
    'data-error-code',
    'egress_denied',
  );
  await expect(
    page.locator('[data-reason-codes~="output_digest_mismatch"]'),
  ).toContainText('The output changed after receipt issuance.');
  await expect(page.locator('#ledger')).not.toContainText(
    'output_digest_mismatch',
  );
  await expect(page.locator('#output-value')).toBeHidden();
  await expect(page.locator('#output-placeholder')).toBeVisible();
  expect(observations.consoleErrors).toEqual([]);
  expect(observations.externalRequests).toEqual([]);
});

test('exposes accessible controls, semantic lineage, and responsive step order', async ({
  page,
}) => {
  const observations = observePage(page);
  await page.goto('/');

  const skipLink = page.getByRole('link', {
    name: 'Skip to privacy workspace',
  });
  await skipLink.focus();
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();
  await expect(skipLink).toHaveAttribute('href', '#privacy-workspace');
  await skipLink.press('Enter');
  await expect(page).toHaveURL(/#privacy-workspace$/);
  await expect(page.locator('#privacy-workspace')).toBeFocused();

  await expect(
    page.getByLabel('Text sent only to the local Worker'),
  ).toHaveAttribute('name', 'privacy-input');
  await expect(
    page.getByLabel('Text sent only to the local Worker'),
  ).toHaveAttribute('autocomplete', 'off');
  await expect(page.getByLabel('Bound runtime')).toHaveAttribute(
    'name',
    'runtime',
  );
  await expect(page.getByLabel('Proof mode')).toHaveAttribute(
    'name',
    'proof-mode',
  );

  const ledger = page.getByRole('table', { name: 'Privacy decision ledger' });
  await expect(ledger).toBeVisible();
  await expect(ledger.locator('thead')).toHaveCount(1);
  await expect(ledger.locator('tbody')).toHaveCount(1);
  await expect(ledger.getByRole('columnheader')).toHaveCount(4);

  await page.getByRole('button', { name: 'Run privacy bridge' }).click();
  await expect(page.locator('#egress-status')).toHaveText(
    'Exact output permitted',
  );
  await expect(ledger.getByRole('row')).toHaveCount(4);
  await expect(ledger.locator('tbody th[scope="row"]')).toHaveCount(3);
  await expect(ledger.locator('tbody td')).toHaveCount(9);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1,
    ),
  ).toBe(false);

  const positions = await page.locator('[data-step]').evaluateAll((panels) =>
    panels.map((panel) => {
      const bounds = panel.getBoundingClientRect();
      return {
        step: panel.getAttribute('data-step'),
        left: Math.round(bounds.left),
        top: Math.round(bounds.top),
      };
    }),
  );
  const byStep = new Map(
    positions.map((position) => [position.step, position]),
  );
  const step01 = byStep.get('01')!;
  const step02 = byStep.get('02')!;
  const step03 = byStep.get('03')!;
  const step04 = byStep.get('04')!;
  const viewportWidth = page.viewportSize()?.width ?? 0;
  if (viewportWidth <= 1_120) {
    expect(step01.top).toBeLessThan(step02.top);
    expect(step02.top).toBeLessThan(step03.top);
    expect(step03.top).toBeLessThan(step04.top);
    expect(new Set(positions.map((position) => position.left)).size).toBe(1);
  } else {
    expect(step01.left).toBe(step03.left);
    expect(step02.left).toBe(step04.left);
    expect(step01.left).toBeLessThan(step02.left);
    expect(step03.top).toBeGreaterThan(step01.top);
    expect(step04.top).toBeGreaterThan(step02.top);
  }

  expect(observations.consoleErrors).toEqual([]);
  expect(observations.externalRequests).toEqual([]);
});

test('keeps one active generation and restores every request control', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const nativeWorker = globalThis.Worker;
    const instrumentedWorker = new Proxy(nativeWorker, {
      construct(target, argumentsList) {
        const current = Number(
          Reflect.get(globalThis, '__stagefabricWorkerCount') ?? 0,
        );
        Reflect.set(globalThis, '__stagefabricWorkerCount', current + 1);
        return new target(
          argumentsList[0] as string | URL,
          argumentsList[1] as WorkerOptions | undefined,
        );
      },
    });
    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      value: instrumentedWorker,
      writable: true,
    });
  });
  await page.goto('/');
  await expect(page.locator('#run-button')).toBeVisible();

  const inFlight = await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('#run-button');
    const input = document.querySelector<HTMLTextAreaElement>('#privacy-input');
    const runtime =
      document.querySelector<HTMLSelectElement>('#runtime-select');
    const proof = document.querySelector<HTMLSelectElement>('#proof-select');
    const panel = document.querySelector<HTMLElement>('#request-panel');
    if (
      button === null ||
      input === null ||
      runtime === null ||
      proof === null ||
      panel === null
    ) {
      throw new Error('request_controls_missing');
    }

    button.click();
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        ctrlKey: true,
        key: 'Enter',
      }),
    );
    return {
      button: button.disabled,
      input: input.disabled,
      panelBusy: panel.getAttribute('aria-busy'),
      proof: proof.disabled,
      runtime: runtime.disabled,
    };
  });

  expect(inFlight).toEqual({
    button: true,
    input: true,
    panelBusy: 'true',
    proof: true,
    runtime: true,
  });
  await expect(page.locator('#egress-status')).toHaveText(
    'Exact output permitted',
  );
  expect(
    await page.evaluate(() =>
      Number(Reflect.get(globalThis, '__stagefabricWorkerCount') ?? 0),
    ),
  ).toBe(1);
  await expect(page.locator('#request-panel')).toHaveAttribute(
    'data-run-generation',
    '1',
  );
  await expect(page.locator('#request-panel')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.locator('#privacy-input')).toBeEnabled();
  await expect(page.locator('#runtime-select')).toBeEnabled();
  await expect(page.locator('#proof-select')).toBeEnabled();
  await expect(page.locator('#run-button')).toBeEnabled();
});
