import type { TestHost } from '@parity/host-api-test-sdk/playwright';
import type { FrameLocator } from '@playwright/test';

const PRODUCT_PORT = '5199';

/**
 * Wait for the app to be fully ready inside the test host iframe:
 * 1. Host API connection established (product-sdk <-> host-container)
 * 2. App heading rendered (React mounted + wallet auto-connected)
 */
export async function waitForAppReady(
  testHost: TestHost,
  options?: { timeout?: number },
): Promise<FrameLocator> {
  const timeout = options?.timeout ?? 90_000;
  const frame = testHost.productFrame();

  // Wait for product-sdk to connect to host container
  await testHost.waitForConnection(timeout);

  // Wait for the T3RMINAL heading (app has mounted + host auto-connect done)
  await frame
    .locator('[data-testid="app-heading"]')
    .waitFor({ state: 'visible', timeout });

  return frame;
}

/**
 * Wait for the merchant home to be ready.
 *
 * There is no merchant/customer landing step anymore: once the host
 * connection resolves, `/` auto-redirects to Check out (`/terminal`), the
 * amount keypad. This waits for the app shell to render (bottom nav present)
 * instead of clicking a (no-longer-existent) "merchant" button. Kept under
 * the old name so the specs read the same.
 */
export async function selectMerchantMode(
  frame: FrameLocator,
  options?: { timeout?: number },
): Promise<void> {
  const timeout = options?.timeout ?? 30_000;
  await frame
    .getByRole('link', { name: 'Check out', exact: true })
    .waitFor({ state: 'visible', timeout });
}

/**
 * Open the legacy daily-reports page directly. Its menu entries are gone (the
 * new Reports UI lives on Home → Reports, merchant-gated), so specs navigate
 * the product iframe straight to /daily-reports — same technique as
 * navigateToTerminal.
 */
export async function openReports(
  frame: FrameLocator,
  options?: { timeout?: number },
): Promise<void> {
  const timeout = options?.timeout ?? 30_000;
  await frame.locator('body').evaluate(() => {
    window.location.href = '/daily-reports';
  });
  await frame
    .locator('[data-testid="reports-header"]')
    .waitFor({ state: 'visible', timeout });
}

/**
 * Wait until the product iframe has stopped reloading.
 *
 * After a location change the test host reloads the product frame twice,
 * roughly 100–250 ms apart (host-bridge re-injection). The keypad renders
 * before the last reload — the account is cached — so anything a spec typed
 * in that window was silently wiped, which made every keypad assertion racy.
 * We stamp the current document and only return once one document has
 * survived untouched for `quietMs`.
 */
async function settleProductFrame(
  testHost: TestHost,
  options?: { quietMs?: number; timeout?: number },
): Promise<void> {
  const quietMs = options?.quietMs ?? 700;
  const deadline = Date.now() + (options?.timeout ?? 30_000);
  while (Date.now() < deadline) {
    const productFrame = testHost.page.frames().find((f) => f.url().includes(PRODUCT_PORT));
    if (!productFrame) {
      await testHost.page.waitForTimeout(100);
      continue;
    }
    const mark = `${Date.now()}`;
    try {
      await productFrame.evaluate((m) => {
        document.documentElement.dataset.e2eMark = m;
      }, mark);
      await testHost.page.waitForTimeout(quietMs);
      const still = await productFrame.evaluate(() => document.documentElement.dataset.e2eMark);
      if (still === mark) return;
    } catch {
      // The document was replaced mid-check — loop and stamp the new one.
    }
  }
  throw new Error('settleProductFrame: product frame kept reloading');
}

/**
 * Open the amount keypad (`/terminal`) — the "Check out" tab target. Navigates
 * the product iframe directly so specs don't depend on nav-tab wiring, then
 * waits for the host's reload cycle to finish before handing back control.
 */
export async function navigateToTerminal(
  testHost: TestHost,
  options?: { timeout?: number },
): Promise<void> {
  const timeout = options?.timeout ?? 30_000;
  const productFrame = testHost
    .page
    .frames()
    .find((f) => f.url().includes(PRODUCT_PORT));
  if (!productFrame) throw new Error('navigateToTerminal: product frame not found');
  await productFrame.evaluate(() => {
    window.location.href = '/terminal';
  });
  await settleProductFrame(testHost, { timeout });
  await testHost
    .productFrame()
    .locator('[data-testid="terminal-header"]')
    .waitFor({ state: 'visible', timeout });
}

/**
 * Enter an amount via the POS keypad by clicking digit buttons.
 *
 * The keypad is cents-based: digits fill from the right and there is no
 * decimal key ("1250" → 12.50). This converts a decimal amount to its cents
 * digit sequence, so specs can keep passing human amounts.
 *
 * @example enterAmount(frame, '12.50') // clicks 1, 2, 5, 0
 */
export async function enterAmount(
  frame: FrameLocator,
  amount: string,
): Promise<void> {
  const cents = Math.round(parseFloat(amount) * 100).toString();
  for (const char of cents) {
    await frame.locator(`[data-testid="calc-digit-${char}"]`).click();
  }
}
