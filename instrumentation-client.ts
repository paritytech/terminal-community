/**
 * Browser-side Sentry init. Next.js loads this automatically before any app
 * code runs (no manual import needed), so errors thrown during the very first
 * render are captured.
 *
 * Don't move this into a React component — `Sentry.init()` inside a
 * `useEffect` would miss early-render errors and race-condition with other
 * hooks.
 */

import * as Sentry from "@sentry/nextjs";
import { installLogCapture } from "@/lib/debug/log-capture";
import { commonInitOptions } from "@/lib/telemetry/sentry-init";
import { getE2eTag } from "@/lib/telemetry/e2e-tag";

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
// catches everything, including Sentry's own logging.
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

// ── Sentry ──────────────────────────────────────────────────────────
//
// Telemetry must never take the terminal down. Product sandboxes rewrite
// browser globals: the Polkadot app's TrUAPI runtime "deletes" XMLHttpRequest
// by redefining it as a getter that returns `undefined`, so
// `"XMLHttpRequest" in window` stays true while `XMLHttpRequest.prototype`
// throws — which is exactly what Sentry's default `BrowserApiErrors`
// integration does in `setupOnce`. Left alone, `Sentry.init()` throws before
// React hydrates and the merchant is stuck on a static "Connecting to host…"
// (iOS nightly, 2026-09-15). So: only patch XHR when it really is a
// constructor, and treat any init failure as "no telemetry", never "no app".
const xhrAvailable = typeof XMLHttpRequest === "function";
try {
  Sentry.init({
    ...commonInitOptions(),
    integrations: [
      Sentry.browserApiErrorsIntegration({ XMLHttpRequest: xhrAvailable }),
      // Keep error-only session replay (no session recording, 100% on error).
      Sentry.replayIntegration(),
    ],
    replaysSessionSampleRate: 0.0,
    replaysOnErrorSampleRate: 1.0,
  });

  // Tag synthetic E2E traffic so production error alerts can exclude it.
  const e2eTag = getE2eTag();
  if (e2eTag) Sentry.setTag("tag", e2eTag);
} catch (error) {
  console.warn("[telemetry] Sentry init failed; continuing without error reporting:", error);
}

// Required for Next.js App Router navigation instrumentation
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
