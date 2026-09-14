"use client"

import { useEffect } from "react"
import { hostThemeToChoice, subscribeHostTheme } from "@/lib/host/theme"
import { applyHostTheme } from "@/lib/config/appearance"

/**
 * Keeps the app's theme in step with the Polkadot app's.
 *
 * Every host theme event maps Light/Dark onto Berlin Day/Night and is handed
 * to the appearance preference (lib/config/appearance.ts), which applies it
 * while the merchant is on "Follow Polkadot app" and only records it when
 * they have picked a theme by hand in Settings → Appearance. Applying goes
 * through `setTheme`: `data-theme` on <html> re-resolves every token at
 * runtime (no reload) and the choice is stored for the anti-flash script in
 * app/layout.tsx, so the next launch paints the right theme from the first
 * frame.
 *
 * Outside a host nothing happens here and the bundle's default stands
 * (Berlin Day following the OS to Berlin Night).
 */
export function HostThemeSync() {
  useEffect(() => {
    return subscribeHostTheme((theme) => {
      const choice = hostThemeToChoice(theme)
      console.log(`[HostTheme] ${theme.name.tag}/${theme.variant} → ${choice}`)
      applyHostTheme(choice)
    })
  }, [])

  return null
}
