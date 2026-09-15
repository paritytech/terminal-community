import { merchantCustomerTest as test, expect } from './fixtures';
import { waitForAppReady, selectMerchantMode, navigateToTerminal, enterAmount } from './helpers';

test.describe('Payment flow — merchant to customer', () => {
  test('merchant generates a pUSD payment QR', async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await selectMerchantMode(frame);
    await navigateToTerminal(testHost);
    await enterAmount(frame, '1');

    // Keypad → Charge arms the QR directly (no review step)
    await frame.locator('[data-testid="btn-charge"]').click();

    await expect(
      frame.locator('[data-testid="waiting-text"]'),
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      frame.locator('[data-testid="qr-code"]'),
    ).toBeVisible();

    const qrContainer = frame.locator('[data-testid="qr-code"] svg');
    await expect(qrContainer).toBeVisible({ timeout: 10_000 });
    // Amount only — the asset symbol is rendered in a separate element
    await expect(
      frame.locator('[data-testid="qr-amount"]'),
    ).toHaveText('1.00');
  });
});
