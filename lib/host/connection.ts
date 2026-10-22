"use client"

/**
 * The host connection — and the one place that knows the terminal speaks two
 * wire protocols.
 *
 * The Polkadot ecosystem has two incompatible envelopes and no negotiation
 * between them (see ./sdk.ts):
 *
 *   codec 1  `@novasamatech/host-api-wrapper` — the native container, still
 *            what every release build of the phone apps, Desktop and dot.li
 *            run.
 *   codec 2  `@parity/product-sdk-host` over the TrUAPI Rust core — Android
 *            debug builds and iOS nightly. Newer cores speak codec 3 through
 *            the client they publish, which ./sdk.ts adopts.
 *
 * Everything above this module asks for `getAccountsPort()` and gets the same
 * shape either way. Which client backs it is decided once per launch by
 * `isTruApiRuntime()`.
 *
 * **Both clients are imported lazily and only one ever loads.** Each claims
 * `window.__HOST_API_PORT__.onmessage` when its transport module evaluates —
 * the legacy wrapper does it at import time — so a static import of the
 * unused one would quietly steal the other's replies. That is why nothing
 * here is imported at the top of the file.
 */

import type { PolkadotSigner } from "polkadot-api"
import { awaitHostRuntime, isInHost } from "./detect"
import { loadHostSdk } from "./sdk"

/** A product-derived account, in the shape both clients agree on. */
export interface HostProductAccount {
  publicKey: Uint8Array
  dotNsIdentifier: string
  derivationIndex: number
}

/** A legacy wallet account, where the host still offers them. */
export interface HostLegacyAccount {
  publicKey: Uint8Array
  name?: string
}

/**
 * What the app needs from a host's accounts surface, normalised across the
 * two clients. Every method resolves rather than throwing: a host that
 * refuses is a state to render, not an exception to chase.
 */
export interface HostAccountsPort {
  readonly codec: 1 | 2
  getProductAccount(identifier: string, derivationIndex: number): Promise<HostProductAccount | null>
  getProductAccountSigner(account: HostProductAccount): PolkadotSigner
  getLegacyAccounts(): Promise<HostLegacyAccount[]>
  getLegacyAccountSigner(account: HostLegacyAccount): PolkadotSigner | null
  /** Fires with the host's connection state; returns an unsubscribe. */
  subscribeConnectionStatus(onStatus: (connected: boolean) => void): () => void
}

let portPromise: Promise<HostAccountsPort | null> | null = null
let connected = false

/** Build the codec-2 port over `@parity/product-sdk-host`. */
async function createTruApiPort(): Promise<HostAccountsPort | null> {
  const sdk = await loadHostSdk()
  const accounts = await sdk.getAccountsProvider()
  if (!accounts) return null

  return {
    codec: 2,
    async getProductAccount(identifier, derivationIndex) {
      return accounts.getProductAccount(identifier, derivationIndex).match(
        (account) => ({
          publicKey: account.publicKey,
          dotNsIdentifier: identifier,
          derivationIndex,
        }),
        (error) => {
          console.warn("[Host] getProductAccount refused:", JSON.stringify(error))
          return null
        },
      )
    },
    getProductAccountSigner(account) {
      // The codec-2 SDK returns a PAPI signer whose `signTx` already sends a
      // runtime-listed `txExtVersion`, so the codec-1 workaround in
      // ./product-signer.ts is not needed on this path.
      return accounts.getProductAccountSigner({
        dotNsIdentifier: account.dotNsIdentifier,
        derivationIndex: account.derivationIndex,
        publicKey: account.publicKey,
      })
    },
    async getLegacyAccounts() {
      return accounts.getLegacyAccounts().match(
        (list) => list.map((a) => ({ publicKey: a.publicKey, name: a.name ?? undefined })),
        () => [],
      )
    },
    getLegacyAccountSigner(account) {
      try {
        return accounts.getLegacyAccountSigner({ publicKey: account.publicKey, name: account.name })
      } catch {
        return null
      }
    },
    subscribeConnectionStatus(onStatus) {
      const sub = accounts.subscribeAccountConnectionStatus((status: unknown) =>
        onStatus(String(status).toLowerCase() === "connected"),
      )
      return () => sub.unsubscribe()
    },
  }
}

/** Build the codec-1 port over `@novasamatech/host-api-wrapper`. */
async function createLegacyPort(): Promise<HostAccountsPort | null> {
  const { sandboxProvider, sandboxTransport, createAccountsProvider } = await import(
    "@novasamatech/host-api-wrapper"
  )
  if (!sandboxProvider.isCorrectEnvironment()) {
    console.log("[Host] Not in correct environment")
    return null
  }
  const provider = createAccountsProvider(sandboxTransport) as unknown as {
    getProductAccount?: (id: string, index: number) => { match: <T>(ok: (v: { publicKey: Uint8Array }) => T, err: (e: unknown) => T) => Promise<T> }
    getProductAccountSigner?: (account: unknown, slot: string) => unknown
    getLegacyAccounts?: () => { match: <T>(ok: (v: Array<{ publicKey: Uint8Array; name?: string }>) => T, err: (e: unknown) => T) => Promise<T> }
    getLegacyAccountSigner?: (account: unknown) => PolkadotSigner
    subscribeAccountConnectionStatus: (cb: (s: string) => void) => { unsubscribe: () => void }
  }
  const { createProductAccountSigner } = await import("./product-signer")

  return {
    codec: 1,
    async getProductAccount(identifier, derivationIndex) {
      if (typeof provider.getProductAccount !== "function") return null
      return provider.getProductAccount(identifier, derivationIndex).match(
        (account) => ({ publicKey: account.publicKey, dotNsIdentifier: identifier, derivationIndex }),
        (error) => {
          console.warn("[Host] getProductAccount refused:", JSON.stringify(error))
          return null
        },
      )
    },
    getProductAccountSigner(account) {
      // The wrapper derives a `txExtVersion` the runtime rejects; ./product-signer
      // replaces `signTx` with one that sends a listed version.
      return createProductAccountSigner(
        account,
        provider.getProductAccountSigner!(account, "createTransaction") as never,
      )
    },
    async getLegacyAccounts() {
      if (typeof provider.getLegacyAccounts !== "function") return []
      return provider.getLegacyAccounts().match(
        (list) => list.map((a) => ({ publicKey: a.publicKey, name: a.name ?? undefined })),
        () => [],
      )
    },
    getLegacyAccountSigner(account) {
      if (typeof provider.getLegacyAccountSigner !== "function") return null
      return provider.getLegacyAccountSigner({
        dotNsIdentifier: "",
        derivationIndex: 0,
        publicKey: account.publicKey,
      })
    },
    subscribeConnectionStatus(onStatus) {
      const sub = provider.subscribeAccountConnectionStatus((status) =>
        onStatus(String(status).toLowerCase() === "connected"),
      )
      return () => sub.unsubscribe()
    },
  }
}

/**
 * The accounts port for this launch, or `null` outside a host. One instance
 * per session — the underlying transport must not be built twice.
 */
export function getAccountsPort(): Promise<HostAccountsPort | null> {
  portPromise ??= (async () => {
    if (!isInHost()) return null
    // Which runtime is live can still be unknown at this point — Android can
    // register the TrUAPI bootstrap after the page's own scripts. Waiting is
    // the difference between picking the right client and spending ten
    // seconds on a handshake the other one will never answer.
    const runtime = await awaitHostRuntime()
    console.log(`[Host] Runtime: ${runtime}`)
    const port = runtime === "truapi" ? await createTruApiPort() : await createLegacyPort()
    if (port) {
      connected = true
      console.log(`[Host] Transport ready (codec ${port.codec})`)
    }
    return port
  })().catch((error) => {
    console.log(`[Host] Connection error: ${error?.message || error}`)
    return null
  })
  return portPromise
}

export async function connectToHost(): Promise<boolean> {
  return (await getAccountsPort()) !== null
}

export function isHostConnected(): boolean {
  return connected
}

/** For tests: forget the resolved port so the next call rebuilds it. */
export function resetHostConnection(): void {
  portPromise = null
  connected = false
}
