import { test, expect } from "../host/fixture";
import { bootTerminal } from "../host/flows";

// Port of e2e/theme.spec.ts onto the Terminal test host.
//
// FIXME(host): the two original tests need live host theme changes, which this
// host does not deliver yet. The product posts host_theme_subscribe_start
// BEFORE host_handshake_request; e2e/host/page.ts tags that subscription with
// the previous generation and prunes it when the handshake arrives, so
// host.setTheme() has no subscriber left. Both stay fixme until the host keeps
// subscriptions opened just before a document's handshake.
test.describe("Theme follows the host", () => {
  test.fixme("host light/dark switches the design-system theme without a reload", async ({ host }) => {
    const frame = await bootTerminal(host);

    const html = frame.locator("html");
    const bodyBackground = () => frame.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor);

    // Mark the document so we can prove nothing reloaded during the switches.
    await html.evaluate((el) => el.setAttribute("data-e2e-doc", "same"));

    await host.setTheme("dark");
    await expect(html).toHaveAttribute("data-theme", "berlin-night");
    const darkBackground = await bodyBackground();

    await host.setTheme("light");
    await expect(html).toHaveAttribute("data-theme", "berlin-day");
    const lightBackground = await bodyBackground();

    expect(darkBackground).not.toBe(lightBackground);
    await expect(html).toHaveAttribute("data-e2e-doc", "same");

    // The choice is persisted for the anti-flash script on the next launch.
    const stored = await frame.locator("body").evaluate(() => localStorage.getItem("pds-theme"));
    expect(stored).toBe("berlin-day");
  });

  test.fixme("a theme picked in Settings overrides the host until set back to follow", async ({ host }) => {
    const frame = await bootTerminal(host);
    const html = frame.locator("html");

    await host.setTheme("dark");
    await expect(html).toHaveAttribute("data-theme", "berlin-night");

    // Home → gear → Settings → Appearance dropdown
    await frame.getByRole("link", { name: "Home", exact: true }).click();
    await frame.getByRole("link", { name: "Settings" }).click();
    const appearance = frame.getByRole("combobox", { name: "Appearance" });
    await expect(appearance).toHaveText("Follow Polkadot app");

    await appearance.click();
    await frame.getByRole("option", { name: "Lisbon" }).click();
    await expect(html).toHaveAttribute("data-theme", "lisbon");
    await expect(appearance).toHaveText("Lisbon");

    // The host changing its mind no longer moves the app…
    await host.setTheme("light");
    await expect(html).toHaveAttribute("data-theme", "lisbon");

    // …until the merchant hands the choice back, which picks up the host's
    // latest theme (light → Berlin Day).
    await appearance.click();
    await frame.getByRole("option", { name: "Follow Polkadot app" }).click();
    await expect(html).toHaveAttribute("data-theme", "berlin-day");
  });

  test.describe("on a dark host", () => {
    test.use({ hostOptions: { theme: "dark" } });

    // What runs today without live theme events: the theme the host reports
    // at launch, a manual override, and handing the choice back.
    test("a theme picked in Settings overrides the host's, and Follow brings the host's back", async ({ host }) => {
      const frame = await bootTerminal(host);
      const html = frame.locator("html");
      await expect(html).toHaveAttribute("data-theme", "berlin-night");
      const darkBackground = await frame.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor);

      await frame.getByRole("link", { name: "Home", exact: true }).click();
      await frame.getByRole("link", { name: "Settings" }).click();
      const appearance = frame.getByRole("combobox", { name: "Appearance" });
      await expect(appearance).toHaveText("Follow Polkadot app");

      await appearance.click();
      await frame.getByRole("option", { name: "Lisbon" }).click();
      await expect(html).toHaveAttribute("data-theme", "lisbon");
      await expect(appearance).toHaveText("Lisbon");
      expect(await frame.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(darkBackground);
      expect(await html.evaluate(() => localStorage.getItem("pds-theme"))).toBe("lisbon");

      await appearance.click();
      await frame.getByRole("option", { name: "Follow Polkadot app" }).click();
      await expect(html).toHaveAttribute("data-theme", "berlin-night");
      await expect(appearance).toHaveText("Follow Polkadot app");
      expect(await html.evaluate(() => localStorage.getItem("pds-theme"))).toBe("berlin-night");
    });
  });
});
