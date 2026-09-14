import { merchantTest as test, expect } from './fixtures';
import { waitForAppReady, selectMerchantMode } from './helpers';

test.describe('Home page loads via Host API', () => {
  test('shows T3RMINAL heading after host connection', async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);

    await expect(
      frame.locator('[data-testid="app-heading"]'),
    ).toBeVisible();

    await expect(
      frame.locator('[data-testid="app-heading"]'),
    ).toHaveText('T3RMINAL');
  });

  test('auto-redirects to checkout with bottom nav', async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);

    // Once the host connection resolves, `/` auto-redirects to /terminal —
    // the amount keypad is the first screen a merchant sees.
    await selectMerchantMode(frame);
    await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();

    // Bottom nav tabs should be visible on the checkout screen.
    await expect(frame.getByRole('link', { name: 'Check out', exact: true })).toBeVisible();
    await expect(frame.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
    await expect(frame.getByText('History')).toBeVisible();

    // Settings left the nav — it opens via the gear icon on the Home dashboard.
    await frame.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(frame.getByRole('link', { name: 'Settings' })).toBeVisible();
  });
});
