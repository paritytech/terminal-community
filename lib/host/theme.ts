/**
 * Host theme
 *
 * The Polkadot app tells products which theme it is showing through
 * `host_theme_subscribe` (host-api protocol v1, upstream 0.8):
 *
 *   { name: Default | Custom(<host theme id>), variant: "Light" | "Dark" }
 *
 * We map that onto the design system's themes (theme/theme.ts). Only the
 * `variant` has a counterpart today — Berlin Day / Berlin Night are the
 * light/dark pair, and the tonal themes (Lisbon, Malta, Tokyo) are light-only
 * with no host name agreed for them — so a `Custom` name is honoured by its
 * variant alone. Revisit `hostThemeToChoice` once design maps host theme ids
 * to ours.
 *
 * Outside a host container nothing subscribes and the bundle's default
 * applies: no `data-theme`, i.e. Berlin Day following the OS to Berlin Night.
 */

"use client"

import {
  createThemeProvider,
  sandboxProvider,
  sandboxTransport,
  type ThemeMode,
} from "@novasamatech/host-api-wrapper"
import type { ThemeChoice } from "@/theme/theme"
import { isInHost } from "./detect"

export type HostTheme = ThemeMode

let themeProvider: ReturnType<typeof createThemeProvider> | null = null

function getThemeProvider() {
  if (!themeProvider) {
    themeProvider = createThemeProvider(sandboxTransport)
  }
  return themeProvider
}

/** The design-system theme that matches what the host is showing. */
export function hostThemeToChoice(theme: HostTheme): ThemeChoice {
  return theme.variant === "Dark" ? "berlin-night" : "berlin-day"
}

/**
 * Follow the host's theme. Fires with the current theme and again on every
 * change. Returns an unsubscribe; a no-op outside a host container or when
 * the host predates the theme slot.
 */
export function subscribeHostTheme(onTheme: (theme: HostTheme) => void): () => void {
  if (!isInHost()) return () => {}
  if (!sandboxProvider.isCorrectEnvironment()) return () => {}

  try {
    const sub = getThemeProvider().subscribeTheme(onTheme)
    // A host that stops serving the slot leaves the last applied theme in
    // place — there is nothing better to switch to.
    sub.onInterrupt(() => console.log("[HostTheme] Subscription interrupted by host"))
    return () => sub.unsubscribe()
  } catch (e: unknown) {
    // Older hosts don't implement host_theme_subscribe — keep the default.
    console.log(`[HostTheme] Subscription unavailable: ${(e as Error)?.message ?? e}`)
    return () => {}
  }
}
