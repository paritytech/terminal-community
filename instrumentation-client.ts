/**
 * Browser-side boot. Next.js loads this automatically before any app code
 * runs (no manual import needed), so the polyfill and the log capture below
 * are in place for the very first render.
 */

import { installLogCapture } from "@/lib/debug/log-capture";

// ── Promise.withResolvers polyfill (old Android WebViews) ───────────
//
// Locked-down Sunmi terminals ship an old, non-updatable Android System
// WebView — e.g. the Sunmi V3 renders on Chromium 101 (mid-2022).
// `Promise.withResolvers()` only landed in Chromium 119, so the QR scanner
// (lib/scan/*) — which uses it in its mount path — throws
// "Promise.withResolvers is not a function" and the camera scan fails to
// start. Install a tiny shim before any app code can call it. No-op on
// modern engines that already have it.
if (typeof Promise.withResolvers !== "function") {
  Promise.withResolvers = function withResolvers<T>(): PromiseWithResolvers<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

// Mirror every console.* call (and uncaught errors) into an in-memory buffer
// so Settings → Debug logs can export them — phones in the host webview have
// no dev console. Installed first so it sits beneath every other wrapper and
// catches everything.
installLogCapture();

// ── Suppress Next.js dev-only `missingSlots` Set warning ────────────
//
// Next 16.2.6 always allocates a `Set` for `InitialRSCPayload.m`
// (a.k.a. `missingSlots`) when `process.env.__NEXT_DEV_SERVER` is true —
// see `node_modules/next/dist/esm/server/app-render/app-render.js`
// (`missingSlots = new Set()` ~L919, then `m: missingSlots` ~L1002).
// React 19's stricter RSC serializer then console.errors on every
// navigation:
//
//   "Only plain objects can be passed to Client Components from Server
//    Components. Set objects are not supported."
//
// The Set is empty in this app (we don't use parallel routes / @slots),
// so the warning is pure framework noise. We filter exactly that one
// message — never anything else — and only in dev. Production payloads
// don't include the Set at all, so this code is a no-op there.
//
// IMPORTANT: if you ever introduce parallel routes / named slots, drop
// this filter so you can see real missing-slot warnings again.
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  const FILTER_FLAG = "__t3rminalNextSetFilter" as const;

  const isNextSetWarning = (args: readonly unknown[]): boolean => {
    const first = args[0];
    if (typeof first !== "string") return false;
    if (!first.includes("Only plain objects can be passed to Client Components")) {
      return false;
    }
    // The offending type name may be inlined in the format string OR
    // passed as a separate `%s` substitution argument — accept either.
    if (first.includes("Set objects are not supported")) return true;
    return args.slice(1).some((a) => a === "Set");
  };

  // Install on top of whatever `console.error` exists right now. We may
  // run before Next's `patchConsoleError` (in which case our wrap is
  // first and Next will wrap us); we may run after it (in which case
  // we sit on top of theirs). Re-install across a few task boundaries
  // so we end up on top regardless of timing.
  const install = (): void => {
    const upstream = window.console.error as typeof console.error & {
      [FILTER_FLAG]?: true;
    };
    if (upstream[FILTER_FLAG]) return;
    const filter = ((...args: unknown[]) => {
      if (isNextSetWarning(args)) return;
      return upstream.apply(window.console, args as Parameters<typeof console.error>);
    }) as typeof console.error & { [FILTER_FLAG]?: true };
    filter[FILTER_FLAG] = true;
    window.console.error = filter;
  };

  install();
  queueMicrotask(install);
  setTimeout(install, 0);
  setTimeout(install, 100);
  setTimeout(install, 500);
}
