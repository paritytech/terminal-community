import { merchantTest as test, expect } from './fixtures';
import { waitForAppReady, selectMerchantMode, openReports } from './helpers';

test.describe('Daily reports page', () => {
  test('navigates to reports and shows header', async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await selectMerchantMode(frame);

    // Reports now live under Settings → Reports & Backup → Save reports.
    await openReports(frame);

    await expect(
      frame.locator('[data-testid="reports-header"]'),
    ).toBeVisible({ timeout: 30_000 });
  });

  test('displays the report history section', async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await selectMerchantMode(frame);

    await openReports(frame);

    // The report history section always renders (empty or populated).
    await expect(frame.getByText('Report history')).toBeVisible();
  });

  test('shows empty state or report list', async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await selectMerchantMode(frame);

    await openReports(frame);

    // Either the empty state or at least one report row should be present.
    const empty = frame.locator('[data-testid="reports-empty"]');
    const firstReport = frame.locator('[data-testid="report-view-0"]');
    await expect(empty.or(firstReport)).toBeVisible();
  });

  test('CSV export keeps working while its Home tile is parked', async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await selectMerchantMode(frame);

    // The app lands on Check out, so open the Home tab first.
    await frame.getByRole('link', { name: 'Home', exact: true }).click();
    await frame.locator('[data-testid="todays-income"]').waitFor();

    // R1 hides the Export CSV tile behind FEATURES.becomeMerchant (off by
    // default), so nothing on Home leads to the export screen.
    await expect(frame.getByRole('link', { name: 'Export CSV' })).toHaveCount(0);

    // The screen itself is untouched and still routable by URL — flipping the
    // flag back puts the tile on Home and lands here. (The legacy Settings
    // entry was removed in the Settings redesign; /settings/export is still
    // routable by URL too.)
    await frame.locator('body').evaluate(() => {
      window.location.href = '/home/export';
    });
    await expect(
      frame.getByText('New report'),
    ).toBeVisible({ timeout: 30_000 });
  });
});
