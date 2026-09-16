/**
 * Host API PAPI providers
 *
 * Routes all chain RPC through the Polkadot Desktop host container, with a WS
 * fallback for chains the host doesn't yet expose.
 *
 * On polkadot-api v2 every layer (`getWsProvider`, product-sdk's
 * `createPapiProvider`, `createClient`) speaks `JsonRpcMessage` objects, so
 * no string↔object adapters are needed.
 */

import { createPapiProvider } from "@novasamatech/host-api-wrapper"
import { createClient, PolkadotClient } from "polkadot-api"
import { getWsProvider } from "@polkadot-api/ws-provider"
import { isProductWebSocketBlocked } from "./detect"

// Paseo Individuality (Next v2) — people-system parachain hosting pallet-coinage
// and the pUSD foreign asset. Paseo Next v2 is re-genesised periodically (last
// on 2026-08; verified 2026-08-28 via `chain_getBlockHash(0)`). The hash MUST
// match the host's chain list (Firebase `chains_v2` → "Paseo Next V2 People"):
// inside the Polkadot app the wrapper gates chain access on
// `host_feature_supported(Chain, genesis)`, and a stale hash makes the host
// answer "unsupported" — the WS fallback below is blocked in the product
// sandbox, so every chain read then times out ("Offline"). The RPC endpoint
// itself survives a reset; only the genesis changes.
export const PASEO_INDIVIDUALITY_GENESIS =
  "0x89a63b11fef2c0273fc72c0d864da0793a665dade5db153e0cab995348c5440f" as `0x${string}`
export const PASEO_INDIVIDUALITY_WS = "wss://paseo-people-next-system-rpc.polkadot.io"

// Paseo Asset Hub Next (v2) — Revive contracts (T3rminalBulletinIndex).
// Same re-genesis caveat as above (verified 2026-08-28); must also match the
// genesis baked into `@parity/product-sdk-descriptors/paseo-asset-hub` and
// `.papi/polkadot-api.json`, otherwise PAPI's computed `additionalSigned`
// diverges from the chain's expectation and every signed extrinsic dies with
// `BadProof`. A reset also wipes deployed contracts — redeploy the index
// (`npm run deploy:contract`) and update NEXT_PUBLIC_BULLETIN_INDEX_ADDRESS.
export const PASEO_ASSET_HUB_GENESIS =
  "0x23e730eb1c6fecae09c917439a5038cb6122d0d48980e8b9bbf0ff56f94a2ca6" as `0x${string}`
// Overridable at build time so a deploy to a different chain (e.g. previewnet)
// points the runtime app at the same chain its contract was deployed to.
// scripts/deploy-bulletin-index.ts writes NEXT_PUBLIC_ASSET_HUB_WS into
// .env.local; unset falls back to Paseo Asset Hub Next.
export const PASEO_ASSET_HUB_WS =
  process.env.NEXT_PUBLIC_ASSET_HUB_WS ?? "wss://paseo-asset-hub-next-rpc.polkadot.io"

// Bulletin chain access goes through host `preimageManager.submit` (see
// lib/bulletin/client.ts) — the host's local signer is the only path that
// fits the multi-KB preimage payload, so we don't keep a direct PAPI
// client here. The merchant-signed alternative (signPayload via host)
// fails on the phone wallet's 256-byte payload ceiling.

/**
 * Direct-WS fallback for chains the host doesn't expose. The Polkadot phone
 * app answers `chainSupported` → false for both chains below, so on Android
 * every chain read actually goes over this fallback. The iOS native container
 * blocks product-side WebSockets outright (`new WebSocket` throws), so there
 * the fallback can only throw — pass none and let the wrapper report the chain
 * as unsupported instead. Coins settlement never needs these reads (see
 * lib/payments/host-reachability.ts); the pUSD path does.
 */
function wsFallback(url: string) {
  if (isProductWebSocketBlocked()) {
    console.warn(`[Host Provider] product WebSockets are blocked by the host sandbox — no direct fallback for ${url}`)
    return undefined
  }
  return getWsProvider(url)
}

let paseoIndividualityClient: PolkadotClient | null = null
let paseoAssetHubClient: PolkadotClient | null = null

export function getPaseoIndividualityClient(): PolkadotClient {
  if (paseoIndividualityClient) return paseoIndividualityClient
  // Pass a WS fallback so we still connect on hosts that don't yet expose this
  // chain as a known target. createPapiProvider probes host support during
  // isReady() and falls through to WS when absent.
  const provider = createPapiProvider(PASEO_INDIVIDUALITY_GENESIS, wsFallback(PASEO_INDIVIDUALITY_WS))
  paseoIndividualityClient = createClient(provider)
  console.log("[Host Provider] Paseo Individuality client created (WS fallback)")
  return paseoIndividualityClient
}

export async function getPaseoIndividualityClientAsync(): Promise<PolkadotClient> {
  return getPaseoIndividualityClient()
}

export function getPaseoAssetHubClient(): PolkadotClient {
  if (paseoAssetHubClient) return paseoAssetHubClient
  // Route through host bridge with WS fallback. createPapiProvider probes
  // `host_feature_supported(Chain, genesis)` and falls through to the
  // provided WS provider when the host doesn't advertise the chain — so
  // standalone (regular browser tab) still works without code change.
  // Signing also goes through the host product-account signer (see
  // lib/host/accounts.ts), so chain RPC + signing share the host transport.
  const provider = createPapiProvider(PASEO_ASSET_HUB_GENESIS, wsFallback(PASEO_ASSET_HUB_WS))
  paseoAssetHubClient = createClient(provider)
  console.log("[Host Provider] Paseo Asset Hub Next client created (host bridge + WS fallback)")
  return paseoAssetHubClient
}

export function resetClients(): void {
  if (paseoIndividualityClient) { paseoIndividualityClient.destroy(); paseoIndividualityClient = null }
  if (paseoAssetHubClient) { paseoAssetHubClient.destroy(); paseoAssetHubClient = null }
}
