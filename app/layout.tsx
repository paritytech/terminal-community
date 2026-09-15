import type { Metadata, Viewport } from "next";
import { Web3Provider } from "@/lib/web3";
import { ReportJobProvider } from "@/lib/components/report-job-provider";
import { ServiceWorkerRegister } from "@/lib/components/service-worker-register";
import { SentryTags } from "@/lib/components/sentry-tags";
import { TestHook } from "@/lib/components/test-hook";
import { HostThemeSync } from "@/lib/components/host-theme-sync";
import { fontVariablesClassName, THEME_INIT_SCRIPT } from "@/lib/fonts";
import "./globals.css";

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
    <html lang="en" className={fontVariablesClassName}>
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
