/**
 * Host API PAPI providers
 *
 * All chain RPC goes through the host, for whichever client this launch is
 * on — the TrUAPI SDK's `getHostProvider` (structured `chain.*` calls) or the
 * codec-1 wrapper's `createPapiProvider`. The terminal never opens a
 * connection of its own: a chain the host does not serve is unavailable, not
 * reached some other way. Each host client is loaded lazily, on the runtime
 * that uses it.
 *
 * The clients stay synchronous for their callers: `getSyncProvider` hands
 * PAPI a provider at once and connects it when the host has answered.
 */

import { createClient, type JsonRpcProvider, type PolkadotClient } from "polkadot-api"
import { getSyncProvider } from "@polkadot-api/json-rpc-provider-proxy"
import { awaitHostRuntime, isInHost } from "./detect"
import { loadHostSdk } from "./sdk"

// Paseo Individuality (Next v2) — people-system parachain hosting pallet-coinage
// and the pUSD foreign asset. Paseo Next v2 is re-genesised periodically (last
// on 2026-08; verified 2026-08-28 via `chain_getBlockHash(0)`). The hash MUST
// match the host's chain list (Firebase `chains_v2` → "Paseo Next V2 People"):
// the host gates chain access on `featureSupported(Chain, genesis)`, and a
// stale hash makes the host answer "unsupported", so every chain read then
// times out ("Offline").
export const PASEO_INDIVIDUALITY_GENESIS =
  "0x89a63b11fef2c0273fc72c0d864da0793a665dade5db153e0cab995348c5440f" as `0x${string}`

// Paseo Asset Hub Next (v2) — Revive contracts (T3rminalBulletinIndex).
// Same re-genesis caveat as above (verified 2026-08-28); must also match the
// genesis baked into `@parity/product-sdk-descriptors/paseo-asset-hub` and
// `.papi/polkadot-api.json`, otherwise PAPI's computed `additionalSigned`
// diverges from the chain's expectation and every signed extrinsic dies with
// `BadProof`. A reset also wipes deployed contracts — redeploy the index
// (`npm run deploy:contract`) and update NEXT_PUBLIC_BULLETIN_INDEX_ADDRESS.
export const PASEO_ASSET_HUB_GENESIS =
  "0x23e730eb1c6fecae09c917439a5038cb6122d0d48980e8b9bbf0ff56f94a2ca6" as `0x${string}`

// Bulletin chain access goes through host preimages (lib/host/preimage.ts) —
// the host's local signer is the only path that fits the multi-KB preimage
// payload, so we don't keep a direct PAPI client here.

/** A provider for a chain the host does not serve: requests are logged, never answered. */
function unavailable(genesis: string): JsonRpcProvider {
  return () => ({
    send() {
      console.error(`[Host Provider] chain ${genesis} is not served by the host`)
    },
    disconnect() {},
  })
}

/**
 * The host's provider for `genesis`, or one that reports the chain
 * unavailable when the host does not serve it. Rejects when the host could
 * not be asked (a timeout, a dropped link) — that is not an answer, and the
 * caller tries again.
 */
async function resolveProvider(genesis: `0x${string}`): Promise<JsonRpcProvider> {
  // A plain browser tab (local dev) has no host to ask.
  if (!isInHost()) {
    console.warn(`[Host Provider] not inside a host — chain ${genesis} is unavailable`)
    return unavailable(genesis)
  }

  if ((await awaitHostRuntime()) === "truapi") {
    const sdk = await loadHostSdk()
    try {
      const provider = await sdk.getHostProvider(genesis)
      if (provider) return provider
    } catch (error) {
      if (!(error instanceof sdk.ChainNotSupportedError)) throw error
    }
    console.warn(`[Host Provider] the host does not serve ${genesis}`)
    return unavailable(genesis)
  }

  // The codec-1 provider asks the host itself, and logs a chain it does not serve.
  const { createPapiProvider } = await import("@novasamatech/host-api-wrapper")
  return createPapiProvider(genesis)
}

/**
 * A synchronous provider that connects once the host has answered. The
 * decision is kept once made; a failed attempt is not, and `onResult(null)`
 * has `getSyncProvider` try again with its own backoff.
 */
function hostChainProvider(genesis: `0x${string}`): JsonRpcProvider {
  let resolved: Promise<JsonRpcProvider> | null = null
  let failures = 0
  return getSyncProvider((onResult) => {
    let active = true
    let retry: ReturnType<typeof setTimeout> | null = null
    const attempt = (resolved ??= resolveProvider(genesis))
    void attempt.then(
      (provider) => {
        failures = 0
        if (active) onResult((onMessage) => provider(onMessage))
      },
      (error) => {
        if (resolved === attempt) resolved = null
        // getSyncProvider retries a `null` result at once; pace it ourselves.
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** failures++)
        console.warn(`[Host Provider] could not reach the host for ${genesis}, retrying in ${delay}ms:`, error)
        retry = setTimeout(() => {
          if (active) onResult(null)
        }, delay)
      },
    )
    return () => {
      active = false
      if (retry) clearTimeout(retry)
    }
  })
}

const RETRY_BASE_MS = 500
const RETRY_MAX_MS = 30_000

let paseoIndividualityClient: PolkadotClient | null = null
let paseoAssetHubClient: PolkadotClient | null = null

export function getPaseoIndividualityClient(): PolkadotClient {
  paseoIndividualityClient ??= createClient(hostChainProvider(PASEO_INDIVIDUALITY_GENESIS))
  return paseoIndividualityClient
}

export async function getPaseoIndividualityClientAsync(): Promise<PolkadotClient> {
  return getPaseoIndividualityClient()
}

/**
 * Paseo Asset Hub Next. Signing goes through the host product-account signer
 * (see lib/host/accounts.ts), so chain RPC and signing share the host.
 */
export function getPaseoAssetHubClient(): PolkadotClient {
  paseoAssetHubClient ??= createClient(hostChainProvider(PASEO_ASSET_HUB_GENESIS))
  return paseoAssetHubClient
}

export function resetClients(): void {
  if (paseoIndividualityClient) { paseoIndividualityClient.destroy(); paseoIndividualityClient = null }
  if (paseoAssetHubClient) { paseoAssetHubClient.destroy(); paseoAssetHubClient = null }
}
