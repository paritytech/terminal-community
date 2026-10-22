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

import type { ThemeMode } from "@novasamatech/host-api-wrapper"
import type { ThemeChoice } from "@/theme/theme"
import { isInHost, isTruApiRuntime } from "./detect"

export type HostTheme = ThemeMode

/**
 * Both clients expose the same `{ name, variant }` theme and the same
 * subscribe shape, so only the import differs. It is loaded lazily and only
 * for the live codec — see lib/host/runtime-init.ts for why importing the
 * other one is not free.
 */
async function subscribeThemeForActiveCodec(
  onTheme: (theme: HostTheme) => void,
): Promise<{ unsubscribe: () => void; onInterrupt?: (cb: () => void) => void }> {
  if (isTruApiRuntime()) {
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
