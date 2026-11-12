/**
 * Bulletin Chain client — host preimage path.
 *
 * Uploads route through `preimageManager.submit(value)` from product-sdk:
 * the host (Polkadot Desktop) signs and submits `TransactionStorage.store`
 * on Paseo Bulletin Next.
 *
 * Why not merchant-signed locally:
 *  We tried building the extrinsic locally, signing with the host's
 *  product-account signer, and submitting via WS-direct. That path fails
 *  on the host with `SigningErr: message too big` — the host's signPayload
 *  slot relays the entire encoded tx to the phone wallet, which caps it
 *  at ~256 bytes. Preimage extrinsics are a few KB.
 *
 * Allowance prerequisite:
 *  The host forwards the preimage submit to the phone wallet, the phone
 *  signs, and the chain validates. The chain rejects with
 *  `StatementStore: no allowance set for account` unless the user's
 *  host-derived account has an active `BulletInAllowance` on-chain.
 *  We grant that lazily via `ensureBootstrap` (lib/host/allowances.ts) —
 *  one host modal per session, memoized.
 *
 * Permission prerequisite:
 *  The host gates the submit slot behind the `PreimageSubmit` remote
 *  permission, granted via `ensurePreimageSubmitPermission`
 *  (lib/host/allowances.ts) before every submit. Distinct from the on-chain
 *  `BulletInAllowance` above; without it the host silently drops the request
 *  and the call hangs forever.
 *
 * Reads go through the same host preimage path: `lookup(key)` — the host
 * serves the bytes from its own Bulletin node. The lookup key is the CID's
 * Blake2b-256 multihash digest (see `cidToPreimageKey`), which is the exact
 * hash `submit` returned at upload time. There is no public-gateway fallback:
 * everything the terminal reads or writes goes through the host. A report the
 * host cannot serve (uploaded from another device, not yet propagated) is
 * reported as unavailable rather than fetched over the open web.
 *
 * Both host clients are covered by lib/host/preimage.ts and
 * lib/host/allowances.ts, so this module works on either runtime.
 */

"use client"

import { calculateCID, cidToPreimageKey } from "./cid"
import { claimDefaultAllowances, ensurePreimageSubmitPermission } from "@/lib/host/allowances"
import { lookupPreimage, submitPreimage } from "@/lib/host/preimage"

/**
 * Parity's Bulletin IPFS gateway. Only used to build the `gatewayUrl` stored
 * with each report as metadata; the terminal never fetches from it.
 */
const BULLETIN_GATEWAY = "https://paseo-bulletin-next-ipfs.polkadot.io/ipfs/"

export interface BulletinUploadResult {
  cid: string
  kind: "preimage"
  gatewayUrl: string
  /** SS58 of the account the host used to submit the preimage. */
  signedBy: string
}

const PREIMAGE_SUBMIT_TIMEOUT_MS = 120_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `${label} timed out after ${ms}ms — the host did not respond. Ensure the ` +
                `PreimageSubmit permission was granted in the Polkadot app and retry.`,
            ),
          ),
        ms,
      ),
    ),
  ])
}

export async function uploadToBulletinChain(
  data: Uint8Array,
): Promise<BulletinUploadResult> {
  const { isInHost } = await import("@/lib/host/detect")
  if (!isInHost()) {
    throw new Error(
      "Bulletin upload requires a host environment (Polkadot Desktop). " +
      "Open T3rminal inside the desktop product container so the host can " +
      "submit preimages on Paseo Bulletin on your behalf.",
    )
  }

  // Claim on-chain BulletInAllowance (idempotent — cached per session). Host
  // forwards the resulting modal to the phone wallet; once granted, repeated
  // calls within the page lifetime short-circuit.
  await claimDefaultAllowances()

  // Must precede submit: the host silently drops un-permitted submits (hangs).
  await ensurePreimageSubmitPermission()

  const cid = calculateCID(data)
  const gatewayUrl = gatewayUrlForCid(cid)

  console.log("[Bulletin] Submitting preimage via host API, size:", data.length)
  let key: string
  try {
    key = await withTimeout(submitPreimage(data), PREIMAGE_SUBMIT_TIMEOUT_MS, "host preimage submit")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/no allowance set for account/i.test(message)) {
      throw new Error(
        "Paseo Bulletin rejected the preimage submission (`no allowance " +
        "set for account`). The host-side allowance modal completed but " +
        "the on-chain grant didn't land — open Polkadot Mobile, approve " +
        "the pending Bulletin allowance request, and retry. If no request " +
        "is pending, your phone wallet may have signed before the grant " +
        "extrinsic landed; wait one block and try again.",
      )
    }
    throw err
  }
  console.log("[Bulletin] Preimage stored, host key:", key)

  return {
    cid,
    kind: "preimage",
    gatewayUrl,
    signedBy: "host:product-account",
  }
}

const PREIMAGE_LOOKUP_TIMEOUT_MS = 15_000

/**
 * Resolve a preimage by key through the host, wrapping the callback-style
 * `lookup` subscription into a promise. Resolves `null` if the host produces no
 * preimage within `timeoutMs`; rejects if the host drops the lookup.
 */
function lookupPreimageOnce(key: `0x${string}`, timeoutMs: number): Promise<Uint8Array | null> {
  return new Promise<Uint8Array | null>((resolve, reject) => {
    let done = false
    const finish = (settle: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      subscription.unsubscribe()
      settle()
    }
    const subscription = lookupPreimage(key, (preimage) => {
      if (preimage) finish(() => resolve(preimage))
    })
    subscription.onInterrupt?.((reason) =>
      finish(() => reject(reason instanceof Error ? reason : new Error(`host preimage lookup ended: ${String(reason)}`))),
    )
    const timer = setTimeout(() => finish(() => resolve(null)), timeoutMs)
  })
}

/**
 * Fetch JSON stored on Bulletin for a CID, through the host's preimage store.
 * The host serves preimages it can reach from its own Bulletin node; one it
 * cannot (uploaded on another device, not yet propagated) is an error here,
 * not a reason to go to the open web.
 */
export async function fetchJsonFromBulletin<T = unknown>(cid: string): Promise<T> {
  const { isInHost } = await import("@/lib/host/detect")
  if (!isInHost()) {
    throw new Error("Reading a report needs the Polkadot app: open the terminal inside it.")
  }

  const key = cidToPreimageKey(cid)
  console.log("[Bulletin] Looking up preimage via host API, key:", key)
  const bytes = await lookupPreimageOnce(key, PREIMAGE_LOOKUP_TIMEOUT_MS)
  if (!bytes) {
    throw new Error(
      "The Polkadot app could not find this report. It may have been uploaded from another " +
        "device or not have propagated yet — try again in a moment.",
    )
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}

/** The report's address on the Bulletin IPFS gateway — stored as metadata only. */
export function gatewayUrlForCid(cid: string): string {
  return `${BULLETIN_GATEWAY}${cid}`
}
