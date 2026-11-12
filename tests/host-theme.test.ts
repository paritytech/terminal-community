import { describe, expect, it } from "vitest";
import { hostThemeToChoice, type HostTheme } from "@/lib/host/theme";

/**
 * lib/host/theme.ts maps the Polkadot app's theme onto the design system's.
 * The host names its theme in `Custom` with the ids both Android and iOS use;
 * a known id selects our theme of the same name, anything else falls back to
 * the light/dark Berlin pair.
 */

const custom = (value: string, variant: "Light" | "Dark"): HostTheme =>
  ({ name: { tag: "Custom", value }, variant }) as HostTheme;
const unnamed = (variant: "Light" | "Dark"): HostTheme =>
  ({ name: { tag: "Default", value: undefined }, variant }) as HostTheme;

describe("hostThemeToChoice", () => {
  it.each([
    ["berlinDay", "Light", "berlin-day"],
    ["berlinNight", "Dark", "berlin-night"],
    ["lisbon", "Light", "lisbon"],
    ["malta", "Light", "malta"],
    ["tokyo", "Light", "tokyo"],
  ] as const)("follows the host's named theme %s", (id, variant, expected) => {
    expect(hostThemeToChoice(custom(id, variant))).toBe(expected);
  });

  it("follows the variant when the host names no theme", () => {
    expect(hostThemeToChoice(unnamed("Light"))).toBe("berlin-day");
    expect(hostThemeToChoice(unnamed("Dark"))).toBe("berlin-night");
  });

  it("follows the variant for a theme id it does not know", () => {
    expect(hostThemeToChoice(custom("oslo", "Light"))).toBe("berlin-day");
    expect(hostThemeToChoice(custom("oslo", "Dark"))).toBe("berlin-night");
    // Not an own key of the lookup, even though every object has it.
    expect(hostThemeToChoice(custom("constructor", "Dark"))).toBe("berlin-night");
  });

  it("follows the variant when a known theme comes in the other variant", () => {
    // Our Tokyo is light-only; a dark Tokyo on the host must not render light.
    expect(hostThemeToChoice(custom("tokyo", "Dark"))).toBe("berlin-night");
    expect(hostThemeToChoice(custom("berlinNight", "Light"))).toBe("berlin-day");
  });
});
