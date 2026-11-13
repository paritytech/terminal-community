import { test, expect } from "../host/fixture";
import { bootTerminal } from "../host/flows";

// Port of e2e/theme.spec.ts onto the Terminal test host.

test.describe("Theme follows the host", () => {
  test("host light/dark switches the design-system theme without a reload", async ({ host }) => {
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

  test("a named host theme selects the design-system theme of the same name", async ({ host }) => {
    const frame = await bootTerminal(host);
    const html = frame.locator("html");

    // The ids the Polkadot app sends on Android and iOS.
    const named = (custom: string, variant: "Light" | "Dark") => host.setTheme({ custom, variant });

    await named("tokyo", "Light");
    await expect(html).toHaveAttribute("data-theme", "tokyo");

    await named("lisbon", "Light");
    await expect(html).toHaveAttribute("data-theme", "lisbon");

    await named("malta", "Light");
    await expect(html).toHaveAttribute("data-theme", "malta");

    await named("berlinNight", "Dark");
    await expect(html).toHaveAttribute("data-theme", "berlin-night");

    await named("berlinDay", "Light");
    await expect(html).toHaveAttribute("data-theme", "berlin-day");

    // A theme the terminal doesn't have falls back to the light/dark pair.
    await named("oslo", "Dark");
    await expect(html).toHaveAttribute("data-theme", "berlin-night");
  });

  test("a theme picked in Settings overrides the host until set back to follow", async ({ host }) => {
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

    // The theme the host reports at launch (no live change involved), a
    // manual override, and handing the choice back.
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
