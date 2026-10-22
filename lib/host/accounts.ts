/**
 * Host account management
 *
 * Two paths:
 *
 *  1. **Product account** (`getProductAccount(identifier, 0)`) — preferred.
 *     Polkadot Desktop ≥ 0.7.5 (commit 835a3a9) accepts both `.dot` domains
 *     and `localhost:PORT` identifiers, so this works in both prod and dev.
 *     Signing goes through the `createTransaction` host slot; the signer is
 *     the wrapper's with `signTx` replaced (lib/host/product-signer.ts) so the
 *     `txExtVersion` it sends is one the runtime actually lists — the wrapper's
 *     own derivation is rejected by Polkadot App ≥ PR #1004.
 *
 *  2. **Legacy account** (`getLegacyAccounts`) — kept as fallback for hosts
 *     that don't yet ship the localhost-identifier feature, or 0.6.x hosts.
 *     The legacy `signPayloadWithLegacyAccount` slot is still flagged as a
 *     stub in the desktop integration (TODO comment), so signing through it
 *     does not reliably reach the phone.
 */

"use client"

import { AccountId } from "polkadot-api"
import type { PolkadotSigner } from "polkadot-api"
import type { Account } from "@/lib/web3/types/web3"
import { WalletProviderType } from "@/lib/web3/types/web3"
import { getAccountsPort } from "./connection"

export interface HostAccount extends Account {
  polkadotSigner: PolkadotSigner
  publicKey: Uint8Array
}

const accountIdCodec = AccountId()

// RFC-0022 product accounts: on Polkadot Desktop the first request opens the
// "Setting up product accounts" dialog and round-trips to the paired phone
// over SSO, so the host legitimately takes well over the old 5s. Android
// answers from the local subtree in well under a second.
const PRODUCT_ACCOUNT_TIMEOUT_MS = 60_000

/**
 * The identifier the host uses to scope our product (dotNS hostname or
 * localhost:PORT). Read from `window.location.host` — matches what
 * `parseLocalhostUrl` / `parseDotNsUrl` produce on the desktop side.
 */
function getProductIdentifier(): string | null {
  if (typeof window === "undefined") return null
  return window.location.host || null
}

/** Race a promise against a timeout */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ])
}

/**
 * Try the product-account path: accountsProvider.getProductAccount(identifier, 0).
 * Returns a single derived account whose signer goes through the host's
 * non-legacy `signPayload` slot.
 */
async function tryProductAccount(): Promise<HostAccount[] | null> {
  const identifier = getProductIdentifier()
  if (!identifier) return null

  const port = await getAccountsPort()
  if (!port) return null

  try {
    console.log(`[Host Accounts] getProductAccount("${identifier}", 0) over codec ${port.codec}...`)
    const account = await withTimeout(
      port.getProductAccount(identifier, 0),
      PRODUCT_ACCOUNT_TIMEOUT_MS,
      "getProductAccount",
    )
    if (!account) return null

    const address = accountIdCodec.dec(account.publicKey)
    console.log(`[Host Accounts] Product account: ${address} (identifier=${identifier})`)
    return [
      {
        name: `T3rminal merchant`,
        address,
        provider: WalletProviderType.HostAPI,
        polkadotSigner: port.getProductAccountSigner(account),
        publicKey: account.publicKey,
      },
    ] satisfies HostAccount[]
  } catch (e: any) {
    console.warn("[Host Accounts] getProductAccount failed:", e?.message || e)
    return null
  }
}
/**
 * Try the 0.7.x path: accountsProvider.getLegacyAccounts()
 */
async function tryLegacyAccounts(): Promise<HostAccount[] | null> {
  const port = await getAccountsPort()
  if (!port) return null

  try {
    console.log("[Host Accounts] Trying getLegacyAccounts...")
    const accounts = await withTimeout(port.getLegacyAccounts(), 5000, "getLegacyAccounts")
    if (accounts.length === 0) {
      console.log("[Host Accounts] getLegacyAccounts returned empty")
      return [] as HostAccount[]
    }
    console.log(`[Host Accounts] Got ${accounts.length} legacy account(s)`)
    return accounts.flatMap((acc) => {
      const signer = port.getLegacyAccountSigner(acc)
      if (!signer) return []
      const address = accountIdCodec.dec(acc.publicKey)
      console.log(`[Host Accounts] Account: ${acc.name || "unnamed"} ${address}`)
      return [
        {
          name: acc.name || "Host Account",
          address,
          provider: WalletProviderType.HostAPI,
          polkadotSigner: signer,
          publicKey: acc.publicKey,
        },
      ]
    })
  } catch (e: any) {
    console.warn("[Host Accounts] getLegacyAccounts failed:", e?.message || e)
    return null
  }
}
export async function getHostAccounts(): Promise<HostAccount[]> {
  // Product account is the only signing path that goes end-to-end on the
  // current host-api 0.8.x protocol (Polkadot Desktop ≥0.7.5 + Android v2).
  // The legacy `signPayloadWithLegacyAccount` slot is an explicit stub that
  // rejects every request not derived from the product account, so legacy
  // accounts are returned only for UI display (e.g. Coinage receive address).
  const productResult = await tryProductAccount()
  if (productResult !== null && productResult.length > 0) return productResult
  return (await tryLegacyAccounts()) ?? []
}

export function subscribeHostAccounts(
  onAccountsChanged: (accounts: HostAccount[]) => void
): () => void {
  let stop = () => {}
  let cancelled = false

  void getAccountsPort().then((port) => {
    if (!port || cancelled) return
    stop = port.subscribeConnectionStatus(async (isConnected) => {
      onAccountsChanged(isConnected ? await getHostAccounts() : [])
    })
  })

  return () => {
    cancelled = true
    stop()
  }
}