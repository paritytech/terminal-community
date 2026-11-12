/**
 * Next.js server-side instrumentation entrypoint. Loaded once at boot.
 *
 * With `output: 'export'` there's no Node runtime in production — these
 * imports only matter for `next dev` and `next build`.
 */

// ── Suppress Next.js dev-only `missingSlots` Set warning (server side) ──
//
// React 19's RSC serializer runs on the server while encoding the
// `InitialRSCPayload`. Next 16.2.6 stuffs a fresh `Set()` into
// `payload.m` whenever `process.env.__NEXT_DEV_SERVER` is true (see
// `node_modules/next/dist/esm/server/app-render/app-render.js`,
// `missingSlots = new Set()` ~L919 → `m: missingSlots` ~L1002), so the
// serializer warns on every render — and Next then replays the warning
// in the browser via React's server-log forwarding.
//
// The browser-side filter lives in `instrumentation-client.ts`. This
// half silences the matching log in the `next dev` terminal. Scoped to
// dev only; production `next build` / `output: 'export'` don't allocate
// the Set and this code is a no-op there.
//
// IMPORTANT: drop this filter if you ever introduce parallel routes /
// named slots — then a non-empty `missingSlots` set becomes a real
// signal that a slot is missing and the warning is actionable.
if (process.env.NODE_ENV !== "production") {
  const FILTER_FLAG = "__t3rminalNextSetFilter" as const;

  const isNextSetWarning = (args: readonly unknown[]): boolean => {
    const first = args[0];
    if (typeof first !== "string") return false;
    if (!first.includes("Only plain objects can be passed to Client Components")) {
      return false;
    }
    if (first.includes("Set objects are not supported")) return true;
    return args.slice(1).some((a) => a === "Set");
  };

  const upstream = globalThis.console.error as typeof console.error & {
    [FILTER_FLAG]?: true;
  };
  if (!upstream[FILTER_FLAG]) {
    const filter = ((...args: unknown[]) => {
      if (isNextSetWarning(args)) return;
      return upstream.apply(globalThis.console, args as Parameters<typeof console.error>);
    }) as typeof console.error & { [FILTER_FLAG]?: true };
    filter[FILTER_FLAG] = true;
    globalThis.console.error = filter;
  }
}
