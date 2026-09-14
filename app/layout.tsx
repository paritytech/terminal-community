import type { Metadata, Viewport } from "next";
import { Inter, Manrope, Martian_Mono } from "next/font/google";
import { Web3Provider } from "@/lib/web3";
import { ReportJobProvider } from "@/lib/components/report-job-provider";
import { ServiceWorkerRegister } from "@/lib/components/service-worker-register";
import { SentryTags } from "@/lib/components/sentry-tags";
import { TestHook } from "@/lib/components/test-hook";
import { HostThemeSync } from "@/lib/components/host-theme-sync";
import "./globals.css";

// The design system's three faces — Inter for UI, Manrope for display,
// Martian Mono for numbers and identifiers — self-hosted by next/font so the
// static export works offline. All three are variable fonts, so no weight
// list is needed. app/globals.css points the theme's font primitives at these
// variables; they must sit on <html> (":root") for that indirection to
// resolve.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const manrope = Manrope({ variable: "--font-manrope", subsets: ["latin"] });
const martianMono = Martian_Mono({ variable: "--font-martian-mono", subsets: ["latin"] });

// Anti-flash: reapply a stored theme choice before first paint, so a returning
// merchant doesn't see the default theme for one frame and then the switch.
// Same key and attribute as theme/theme.ts `setTheme`; because this script is
// inlined in <head>, `initTheme()` is never called at boot (never both). The
// stored choice is written by HostThemeSync, which follows the Polkadot app's
// theme while running inside it.
const THEME_INIT_SCRIPT =
  "try{var t=localStorage.getItem('pds-theme');if(t)document.documentElement.setAttribute('data-theme',t)}catch(e){}";

export const metadata: Metadata = {
  title: "T3rminal — Payment Terminal",
  description: "Accept payments instantly with Polkadot. Private by default.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "T3rminal",
  },
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  // No `theme-color` here: the surface colour now depends on the active theme
  // and a <meta> can't read a CSS token. See the design-system gap list.
  other: {
    "mobile-web-app-capable": "yes",
    "apple-mobile-web-app-capable": "yes",
    "apple-mobile-web-app-status-bar-style": "black-translucent",
  },
};

// `color-scheme` is owned by the theme (themes.css sets it per theme), so it's
// deliberately not declared here.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${manrope.variable} ${martianMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <Web3Provider>
          <SentryTags />
          <TestHook />
          <HostThemeSync />
          <ReportJobProvider>
            {children}
          </ReportJobProvider>
        </Web3Provider>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
