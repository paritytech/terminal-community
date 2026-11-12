import type { NextConfig } from "next";

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

export default nextConfig;
