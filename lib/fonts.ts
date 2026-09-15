import { Inter, Manrope, Martian_Mono } from "next/font/google";

// The design system's three faces — Inter for UI, Manrope for display,
// Martian Mono for numbers and identifiers — self-hosted by next/font so the
// static export works offline. All three are variable fonts, so no weight
// list is needed. app/globals.css points the theme's font primitives at these
// variables; they must sit on <html> (":root") for that indirection to
// resolve. Shared by the root layout and the global error boundary, which has
// to render its own <html>.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const manrope = Manrope({ variable: "--font-manrope", subsets: ["latin"] });
const martianMono = Martian_Mono({ variable: "--font-martian-mono", subsets: ["latin"] });

export const fontVariablesClassName = `${inter.variable} ${manrope.variable} ${martianMono.variable}`;

// Anti-flash: reapply a stored theme choice before first paint, so a returning
// merchant doesn't see the default theme for one frame and then the switch.
// Same key and attribute as theme/theme.ts `setTheme`; inlined in <head>, so
// `initTheme()` is never called at boot (never both). The stored choice is
// written by HostThemeSync / Settings → Appearance.
export const THEME_INIT_SCRIPT =
  "try{var t=localStorage.getItem('pds-theme');if(t)document.documentElement.setAttribute('data-theme',t)}catch(e){}";
