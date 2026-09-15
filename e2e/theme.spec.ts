import { merchantTest as test, expect } from './fixtures';
import { waitForAppReady, selectMerchantMode } from './helpers';

test.describe('Theme follows the host', () => {
  test('host light/dark switches the design-system theme without a reload', async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await selectMerchantMode(frame);

    const html = frame.locator('html');
    const bodyBackground = () =>
      frame.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);

    // Mark the document so we can prove nothing reloaded during the switches.
    await html.evaluate((el) => el.setAttribute('data-e2e-doc', 'same'));

    await testHost.setTheme('dark');
    await expect(html).toHaveAttribute('data-theme', 'berlin-night');
    const darkBackground = await bodyBackground();

    await testHost.setTheme('light');
    await expect(html).toHaveAttribute('data-theme', 'berlin-day');
    const lightBackground = await bodyBackground();

    expect(darkBackground).not.toBe(lightBackground);
    await expect(html).toHaveAttribute('data-e2e-doc', 'same');

    // The choice is persisted for the anti-flash script on the next launch.
    const stored = await frame.locator('body').evaluate(() => localStorage.getItem('pds-theme'));
    expect(stored).toBe('berlin-day');
  });

  test('a theme picked in Settings overrides the host until set back to follow', async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await selectMerchantMode(frame);
    const html = frame.locator('html');

    await testHost.setTheme('dark');
    await expect(html).toHaveAttribute('data-theme', 'berlin-night');

    // Home → gear → Settings → Appearance dropdown
    await frame.getByRole('link', { name: 'Home', exact: true }).click();
    await frame.getByRole('link', { name: 'Settings' }).click();
    const appearance = frame.getByRole('combobox', { name: 'Appearance' });
    await expect(appearance).toHaveText('Follow Polkadot app');

    await appearance.click();
    await frame.getByRole('option', { name: 'Lisbon' }).click();
    await expect(html).toHaveAttribute('data-theme', 'lisbon');
    await expect(appearance).toHaveText('Lisbon');

    // The host changing its mind no longer moves the app…
    await testHost.setTheme('light');
    await expect(html).toHaveAttribute('data-theme', 'lisbon');

    // …until the merchant hands the choice back, which picks up the host's
    // latest theme (light → Berlin Day).
    await appearance.click();
    await frame.getByRole('option', { name: 'Follow Polkadot app' }).click();
    await expect(html).toHaveAttribute('data-theme', 'berlin-day');
  });
});
