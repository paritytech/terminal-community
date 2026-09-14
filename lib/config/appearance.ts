"use client"

/**
 * Appearance preference — which theme the terminal shows and who decides.
 *
 * Two sources compete for the theme: the Polkadot app (host_theme_subscribe,
 * see lib/host/theme.ts) and the merchant's own pick in Settings → Appearance.
 * This module holds the tie-breaker:
 *
 *   "auto"   — follow the host (the default). Outside a host container that
 *              means the bundle's default: Berlin Day following the OS.
 *   <theme>  — a manual choice; host theme events are recorded but ignored
 *              until the merchant switches back to "auto".
 *
 * The applied theme itself always goes through theme/theme.ts `setTheme`, so
 * `data-theme` is set on <html> (every token re-resolves, no reload) and the
 * choice lands in `pds-theme`, which the anti-flash script in app/layout.tsx
 * replays before first paint. Only the *source* is stored here, in
 * localStorage as well — it has to be readable synchronously at boot.
 */

import { useSyncExternalStore } from "react"
import { getTheme, setTheme, THEMES, type Theme, type ThemeChoice } from "@/theme/theme"

export type AppearanceChoice = "auto" | Theme

const SOURCE_KEY = "pds-theme-source"

/** The host's latest theme this session — what "auto" switches back to. */
let lastHostChoice: ThemeChoice | null = null

const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value)
}

function readSource(): "auto" | "manual" {
  try {
    return localStorage.getItem(SOURCE_KEY) === "manual" ? "manual" : "auto"
  } catch {
    return "auto"
  }
}

/** True while the host (or, outside a host, the OS) decides the theme. */
export function isFollowingHost(): boolean {
  return readSource() === "auto"
}

export function getAppearance(): AppearanceChoice {
  if (readSource() !== "manual") return "auto"
  const stored = getTheme()
  return isTheme(stored) ? stored : "auto"
}

export function setAppearance(choice: AppearanceChoice): void {
  try {
    localStorage.setItem(SOURCE_KEY, choice === "auto" ? "auto" : "manual")
  } catch {
    /* storage unavailable — the theme still applies for this session */
  }
  setTheme(choice === "auto" ? (lastHostChoice ?? "system") : choice)
  emit()
}

/**
 * Called by HostThemeSync on every host theme event. Always remembered so
 * "auto" can pick it up later; applied only while following the host.
 */
export function applyHostTheme(choice: ThemeChoice): void {
  lastHostChoice = choice
  if (isFollowingHost()) setTheme(choice)
}

export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getServerAppearance = (): AppearanceChoice => "auto"

/** Reactive view of the preference for the Settings control. */
export function useAppearance(): [AppearanceChoice, (choice: AppearanceChoice) => void] {
  const choice = useSyncExternalStore(subscribeAppearance, getAppearance, getServerAppearance)
  return [choice, setAppearance]
}
