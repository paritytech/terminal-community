"use client";

/**
 * The codec-2 host client — `@parity/product-sdk-host`, which wraps
 * `@parity/truapi` and speaks the Polkadot app's Rust core.
 *
 * Why a second client at all. The wire has two incompatible envelopes and no
 * in-band negotiation between them:
 *
 *   codec 1  `@novasamatech/host-api` 0.12 — the native container that every
 *            release build of the phone apps, Desktop and dot.li still runs.
 *   codec 2+ the TrUAPI Rust core — the default in Android debug builds and
 *            iOS nightly. Core 0.16 spoke codec 2; the nightlies built from
 *            trinity-user-agents (core 0.23 on) speak codec 3.
 *
 * A codec-1 client gets no answer from a TrUAPI host and vice versa, so the
 * terminal has to carry both and pick one per launch. `isTruApiRuntime()`
 * makes that choice (lib/host/detect.ts). Between TrUAPI versions the codec
 * follows the host, because the terminal adopts the client the host publishes
 * (below); this SDK's own codec-2 client only serves cores that publish none.
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

/** The client newer cores build inside the page and hand to the product. */
function hostProvidedClient(): unknown {
  if (typeof window === "undefined") return null;
  return (window as { __HOST_API_CLIENT__?: { client?: unknown } }).__HOST_API_CLIENT__?.client ?? null;
}

/**
 * Load the codec-2 SDK and, where the host offers one, make it use the host's
 * own client.
 *
 * Adopting beats connecting. Newer cores construct the TrUAPI client in the
 * page and publish it on `window.__HOST_API_CLIENT__`, leaving the
 * `__HOST_API_PORT__` MessagePort behind only as a compatibility path for
 * older SDKs. Taking their client means the wire codec is whatever the two
 * halves of the host already agreed on, so the terminal stops caring which
 * codec version this build of the app happens to ship — the failure mode this
 * whole migration exists to avoid.
 *
 * `setTruApiClient` lives on the SDK's `/testing` entry because its intended
 * use is a fake in a test, and it warns when called from a production build.
 * There is no other seam for adoption today; the warning is the price and it
 * is worth asking the SDK owners for a supported one.
 *
 * Safe to call repeatedly — one module instance per session, so one transport
 * and one set of port handlers.
 */
export function loadHostSdk(): Promise<HostSdk> {
  sdkPromise ??= (async () => {
    const sdk = await import("@parity/product-sdk-host");
    const provided = hostProvidedClient();
    if (provided) {
      const { setTruApiClient } = await import("@parity/product-sdk-host/testing");
      setTruApiClient(provided as Parameters<typeof setTruApiClient>[0]);
      console.log("[Host] Adopted the client the host published on __HOST_API_CLIENT__");
    }
    return sdk;
  })();
  return sdkPromise;
}

/** True when this launch should talk codec 2. */
export function usesTruApiRuntime(): boolean {
  return isTruApiRuntime();
}

/**
 * The client, or `null` outside a host container. The SDK builds its client
 * on first use and caches it internally, so this is cheap after the first
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
