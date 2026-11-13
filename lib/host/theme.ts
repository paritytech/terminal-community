/**
 * Host theme
 *
 * The Polkadot app tells products which theme it is showing through
 * `host_theme_subscribe` (host-api protocol v1, upstream 0.8):
 *
 *   { name: Default | Custom(<host theme id>), variant: "Light" | "Dark" }
 *
 * We map that onto the design system's themes (theme/theme.ts). The Polkadot
 * app ships the same five themes we do and names them in `Custom`, with the
 * same ids on Android (the theme enum, first letter lowered) and iOS
 * (`Theme.id` in polkadot-app-design-system-ios): `berlinDay`, `berlinNight`,
 * `lisbon`, `malta`, `tokyo`. A known id selects our theme of the same name.
 *
 * Anything else falls back to the variant — Berlin Day / Berlin Night are the
 * light/dark pair: `Default` (a host without named themes), an id we don't
 * have yet, or a known id whose variant disagrees with ours (a dark Tokyo
 * would otherwise render light while the host is dark).
 *
 * Outside a host container nothing subscribes and the bundle's default
 * applies: no `data-theme`, i.e. Berlin Day following the OS to Berlin Night.
 */

"use client"

import type { ThemeMode } from "@novasamatech/host-api-wrapper"
import { DARK_THEMES, type Theme } from "@/theme/theme"
import { isInHost, onTruApi } from "./detect"

export type HostTheme = ThemeMode

/**
 * Both clients expose the same `{ name, variant }` theme and the same
 * subscribe shape, so only the import differs. Each is loaded lazily, on the
 * runtime that uses it.
 */
async function subscribeThemeForActiveCodec(
  onTheme: (theme: HostTheme) => void,
): Promise<{ unsubscribe: () => void; onInterrupt?: (cb: () => void) => void }> {
  if (await onTruApi()) {
    const { loadHostSdk } = await import("./sdk")
    const provider = await (await loadHostSdk()).getThemeProvider()
    if (!provider) throw new Error("theme provider unavailable on the TrUAPI runtime")
    return provider.subscribeTheme(onTheme as (t: unknown) => void) as never
  }
  const { createThemeProvider, sandboxProvider, sandboxTransport } = await import(
    "@novasamatech/host-api-wrapper"
  )
  if (!sandboxProvider.isCorrectEnvironment()) {
    throw new Error("host transport not available")
  }
  return createThemeProvider(sandboxTransport).subscribeTheme(onTheme)
}

/** Host theme ids (`ThemeName::Custom`) and the design-system theme each one is. */
const HOST_THEME_IDS: ReadonlyMap<string, Theme> = new Map([
  ["berlinDay", "berlin-day"],
  ["berlinNight", "berlin-night"],
  ["lisbon", "lisbon"],
  ["malta", "malta"],
  ["tokyo", "tokyo"],
])

/** The design-system theme that matches what the host is showing. */
export function hostThemeToChoice(theme: HostTheme): Theme {
  const dark = theme.variant === "Dark"
  if (theme.name.tag === "Custom") {
    const named = HOST_THEME_IDS.get(theme.name.value)
    if (named && DARK_THEMES.includes(named) === dark) return named
  }
  return dark ? "berlin-night" : "berlin-day"
}

/**
 * Follow the host's theme. Fires with the current theme and again on every
 * change. Returns an unsubscribe; a no-op outside a host container or when
 * the host predates the theme slot.
 */
export function subscribeHostTheme(onTheme: (theme: HostTheme) => void): () => void {
  if (!isInHost()) return () => {}

  let stop = () => {}
  let cancelled = false

  void subscribeThemeForActiveCodec(onTheme)
    .then((sub) => {
      if (cancelled) {
        sub.unsubscribe()
        return
      }
      // A host that stops serving the slot leaves the last applied theme in
      // place — there is nothing better to switch to.
      sub.onInterrupt?.(() => console.log("[HostTheme] Subscription interrupted by host"))
      stop = () => sub.unsubscribe()
    })
    .catch((e: unknown) => {
      // Older hosts don't implement the theme slot — keep the default.
      console.log(`[HostTheme] Subscription unavailable: ${(e as Error)?.message ?? e}`)
    })

  return () => {
    cancelled = true
    stop()
  }
}
