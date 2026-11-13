import { test, expect } from "../host/fixture";
import type { T3Host } from "../host/fixture";
import { bootTerminal } from "../host/flows";
import { gotoInFrame } from "./screens.helpers";

// Port of e2e/daily-reports.spec.ts onto the Terminal test host. The legacy
// /daily-reports page has no menu entry, so it is reached by URL — and the
// product document is let settle after the location change.
async function openReports(host: T3Host) {
  await gotoInFrame(host, "/daily-reports");
  await expect(host.productFrame().locator('[data-testid="reports-header"]')).toBeVisible({ timeout: 30_000 });
}

test.describe("Daily reports page", () => {
  test("navigates to reports and shows header", async ({ host }) => {
    await bootTerminal(host);
    await openReports(host);
    await expect(host.productFrame().locator('[data-testid="reports-header"]')).toHaveText("Reports");
  });

  test("displays the report history section", async ({ host }) => {
    await bootTerminal(host);
    await openReports(host);
    await expect(host.productFrame().getByText("Report history")).toBeVisible();
  });

  test("shows the empty state on a fresh install", async ({ host }) => {
    await bootTerminal(host);
    await openReports(host);
    const frame = host.productFrame();
    // The host starts with empty storage: no reports, so the empty state.
    await expect(frame.locator('[data-testid="reports-empty"]')).toHaveText("No reports yet");
    await expect(frame.locator('[data-testid="report-view-0"]')).toHaveCount(0);
  });

  test("CSV export keeps working while its Home tile is parked", async ({ host }) => {
    const frame = await bootTerminal(host);

    // The app lands on Check out, so open the Home tab first.
    await frame.getByRole("link", { name: "Home", exact: true }).click();
    await frame.locator('[data-testid="todays-income"]').waitFor();

    // R1 hides the Export CSV tile behind FEATURES.becomeMerchant (off by
    // default), so nothing on Home leads to the export screen.
    await expect(frame.getByRole("link", { name: "Export CSV" })).toHaveCount(0);

    // The screen itself is untouched and still routable by URL.
    await gotoInFrame(host, "/home/export");
    await expect(frame.getByText("New report")).toBeVisible({ timeout: 30_000 });
    await expect(frame.locator('[data-testid="btn-generate-report"]')).toBeVisible();
  });
});
