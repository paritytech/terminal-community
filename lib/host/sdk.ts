"use client";

/**
 * The TrUAPI host client — `@parity/product-sdk-host`, which wraps
 * `@parity/truapi` and speaks the Polkadot app's Rust core.
 *
 * Why a second client at all. The wire has two incompatible envelopes and no
 * in-band negotiation between them:
 *
 *   codec 1  `@novasamatech/host-api` 0.12 — the native container that every
 *            release build of the phone apps, Desktop and dot.li still runs.
 *   TrUAPI   the Rust core — the default in Android debug builds and iOS
 *            nightly. Core 0.16 spoke codec 2; the nightlies built from
 *            trinity-user-agents (core 0.23 on) speak codec 3.
 *
 * A codec-1 client gets no answer from a TrUAPI host and vice versa, so the
 * terminal has to carry both and pick one per launch. `isTruApiRuntime()`
 * makes that choice (lib/host/detect.ts).
 *
 * Between TrUAPI versions the codec follows the host. Newer cores build the
 * client inside the page and publish it on `window.__HOST_API_CLIENT__`, and
 * `@parity/truapi` (0.26 on) uses that client instead of opening its own, so
 * the wire is whatever the two halves of the host already agreed on. Only a
 * core that publishes none (0.16 and its era) gets this SDK's own codec-3
 * client, which it cannot answer — those cores had no payments either.
 *
 * **Everything here is loaded lazily, and that is load-bearing.** Both
 * clients claim `window.__HOST_API_PORT__.onmessage` the moment their
 * transport module evaluates — the legacy wrapper does it at import time, in
 * `sandboxTransport`. Two live transports means the second silently eats the
 * first one's replies, which looks exactly like a host that stopped
 * answering. So neither client is imported at module scope anywhere: each
 * path awaits its own loader, and only the path in use ever evaluates.
 */

import { isTruApiRuntime } from "./detect";

type HostSdk = typeof import("@parity/product-sdk-host");

let sdkPromise: Promise<HostSdk> | null = null;

/**
 * Load the SDK. Safe to call repeatedly — one module instance per session, so
 * one transport and one set of port handlers.
 */
export function loadHostSdk(): Promise<HostSdk> {
  sdkPromise ??= import("@parity/product-sdk-host");
  return sdkPromise;
}

/** True when this launch should talk TrUAPI. */
export function usesTruApiRuntime(): boolean {
  return isTruApiRuntime();
}

/**
 * The client, or `null` outside a host container. The SDK builds (or adopts)
 * its client on first use and caches it, so this is cheap after the first
 * call.
 */
export async function getTruApiClient() {
  const sdk = await loadHostSdk();
  return sdk.getTruApi();
}

/** For tests: drop the cached module handle. */
export function resetHostSdkCache(): void {
  sdkPromise = null;
}
