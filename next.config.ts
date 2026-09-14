import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  output: 'export',
  images: {
    unoptimized: true,
  },
  trailingSlash: true,
  // Monorepo: each app is its own workspace root. Without this Turbopack
  // walks up looking for lockfiles and can pick the repo root instead.
  turbopack: {
    root: __dirname,
    // The shadcn CLI writes `import { cn } from "cn"` (a bare specifier, not
    // the components.json alias) into every generated component. components/ui
    // is installed, never hand-edited, so the fix lives here: point the bare
    // name at the design system's cn (lib/cn.ts — tailwind-merge with the
    // theme's class groups registered). Mirrored in tsconfig `paths`.
    resolveAlias: {
      cn: "./lib/cn.ts",
    },
  },
};

// Sentry build plugin. With `output: 'export'` there's no server to upload
// source maps for; only the client bundle matters. Source map upload runs
// only when SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_PROJECT are set, so
// `dot deploy` / static builds without those env vars stay clean.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: true,
});
