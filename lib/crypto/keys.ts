/**
 * X25519 Encryption Keypair Management
 *
 * When running inside a host (Polkadot Desktop / dot.li), the keypair is
 * derived deterministically from the user's wallet account via
 * `accountsProvider.getProductAccountAlias(identifier, 0)`. The alias is a
 * Bandersnatch VRF preoutput computed on the phone using the user's actual
 * wallet bandersnatch entropy + a deterministic context derived from the
 * productId — fully cross-device portable (same wallet imported on any
 * device → same alias → same encryption keypair).
 *
 * We intentionally do NOT use `deriveEntropy` here even though it's wrapped
 * in similar plumbing: the desktop host's `secrets.entropy` is a per-SSO-
 * pairing random value, not derived from the user's wallet, so two devices
 * paired with the same wallet get different `deriveEntropy` outputs. Aliases
 * go through the phone's wallet keypair instead, which IS shared across
 * devices (same imported mnemonic).
 *
 * Standalone (dev) mode falls back to a random keypair in memory.
 */

"use client"

import { nacl } from "@/lib/crypto/primitives"

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

const STORAGE_KEY = "encryption_keypair"
const RECIPIENTS_KEY = "encryption_recipients"

/**
 * Get the product identifier used by the host to scope account derivation.
 * The host uses this same value as productId when phone computes the alias —
 * keep in sync with lib/host/accounts.ts:getProductIdentifier().
 */
function getProductIdentifier(): string | null {
  if (typeof window === "undefined") return null
  return window.location.host || null
}

export interface EncryptionKeypair {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

export interface Recipient {
  id: string
  name: string
  pubkeyHex: string
  addedAt: string
  isOwn: boolean  // true = this terminal's own key
}

/** Generate a random X25519 encryption keypair (standalone fallback) */
export function generateKeypair(): EncryptionKeypair {
  const kp = nacl.box.keyPair()
  return { publicKey: kp.publicKey, secretKey: kp.secretKey }
}

// ── Deterministic derivation from host account ──────────────────

/**
 * Derive a deterministic X25519 keypair from the user's wallet via
 * `getProductAccountAlias`. The phone computes the alias as
 * `BandersnatchVrf::alias_in_context(walletEntropy, blake2b256("/product/{productId}/0"))`
 * — a deterministic VRF preoutput. Same wallet (mnemonic) + same productId
 * → same alias on every device.
 *
 * Returns null when not in host, no product identifier is available, or the
 * alias call fails (e.g., phone not connected, user rejected permission).
 */
async function deriveFromAccountAlias(): Promise<EncryptionKeypair | null> {
  const { isInHost } = await import("@/lib/host/detect")
  if (!isInHost()) return null

  const identifier = getProductIdentifier()
  if (!identifier) return null

  try {
    type AliasResult = {
      match<T>(ok: (v: { alias: Uint8Array }) => T, err: (e: unknown) => T): T
    }
    // Codec-1 only: the account alias has no counterpart on the TrUAPI client
    // yet. Importing the wrapper is also what claims the host port, so the
    // guard has to come before the import, not after it (see
    // lib/host/runtime-init.ts).
    const { isTruApiRuntime } = await import("@/lib/host/detect")
    if (isTruApiRuntime()) {
      console.log("[Crypto] account alias unavailable on the TrUAPI runtime")
      return null
    }

    const { sandboxTransport, createAccountsProvider } = await import(
      "@novasamatech/host-api-wrapper"
    )
    const provider = createAccountsProvider(sandboxTransport) as unknown as {
      getProductAccountAlias?: (id: string, idx?: number) => PromiseLike<AliasResult>
    }

    if (typeof provider.getProductAccountAlias !== "function") {
      console.error("[Crypto] ✗ getProductAccountAlias not available on this product-sdk")
      return null
    }

    const result = await provider.getProductAccountAlias(identifier, 0)
    return result.match<EncryptionKeypair | null>(
      (value) => {
        const alias = value.alias
        if (!(alias instanceof Uint8Array) || alias.length !== 32) {
          console.error(`[Crypto] ✗ alias has unexpected shape: ${alias?.constructor?.name} len=${(alias as Uint8Array)?.length}`)
          return null
        }
        const kp = nacl.box.keyPair.fromSecretKey(alias)
        console.log(
          `[Crypto] ✓ Derived deterministic keypair from wallet alias: 0x${bytesToHex(kp.publicKey)}`
        )
        return { publicKey: kp.publicKey, secretKey: kp.secretKey }
      },
      (err: unknown) => {
        const e = err as { payload?: { reason?: string }; message?: string }
        const reason = e?.payload?.reason ?? e?.message ?? String(err)
        console.error(
          `[Crypto] ✗ getProductAccountAlias returned error — cross-device decryption WILL FAIL: ${reason}`
        )
        return null
      }
    )
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    console.error(
      `[Crypto] ✗ getProductAccountAlias threw — cross-device decryption WILL FAIL: ${message}`
    )
    return null
  }
}

// ── Storage helpers (cache / standalone fallback) ───────────────

async function getStorage() {
  const { isInHost, isTruApiRuntime } = await import("@/lib/host/detect")
  if (isInHost()) {
    if (isTruApiRuntime()) {
      const { loadHostSdk } = await import("@/lib/host/sdk")
      const store = await (await loadHostSdk()).getHostLocalStorage()
      if (store) return store
    } else {
      const { hostLocalStorage } = await import("@novasamatech/host-api-wrapper")
      return hostLocalStorage
    }
  }
  // Memory fallback for dev
  const mem: Record<string, any> = (globalThis as any).__cryptoStore ??= {}
  return {
    readJSON: async (k: string) => mem[k] ?? null,
    writeJSON: async (k: string, v: unknown) => { mem[k] = v; return undefined },
    clear: async (k: string) => { delete mem[k]; return undefined },
  }
}

// ── Keypair persistence ─────────────────────────────────────────

/** Load keypair from storage cache */
async function loadFromCache(): Promise<EncryptionKeypair | null> {
  try {
    const storage = await getStorage()
    const data = await storage.readJSON(STORAGE_KEY)
    if (!data?.publicKey || !data?.secretKey) return null
    return {
      publicKey: hexToBytes(data.publicKey),
      secretKey: hexToBytes(data.secretKey),
    }
  } catch {
    return null
  }
}

/** Save keypair to storage cache */
async function saveToCache(kp: EncryptionKeypair): Promise<void> {
  const storage = await getStorage()
  await storage.writeJSON(STORAGE_KEY, {
    publicKey: bytesToHex(kp.publicKey),
    secretKey: bytesToHex(kp.secretKey),
  })
}

/**
 * Load this account's keypair.
 *
 * In host mode: derives deterministically from the user's wallet via
 * `getProductAccountAlias` (cross-device portable). Falls back to cache if
 * alias retrieval fails. In standalone mode: reads from memory cache,
 * returns null if none.
 */
export async function loadKeypair(): Promise<EncryptionKeypair | null> {
  // Try deterministic derivation first (wallet-bound, cross-device portable)
  const derived = await deriveFromAccountAlias()
  if (derived) {
    await saveToCache(derived)
    return derived
  }

  // Fallback to cache (offline / alias unavailable)
  return loadFromCache()
}

/** @deprecated Use loadKeypair() — kept for backward compat */
export async function saveKeypair(kp: EncryptionKeypair): Promise<void> {
  await saveToCache(kp)
}

/**
 * Get this account's keypair, creating one if necessary.
 *
 * Priority:
 *   1. `getProductAccountAlias` (deterministic, wallet-bound, cross-device)
 *   2. Cached keypair from storage
 *   3. Random keypair (standalone dev only)
 */
export async function getOrCreateKeypair(): Promise<EncryptionKeypair> {
  // Try deterministic derivation (same wallet → same keypair on any device)
  const derived = await deriveFromAccountAlias()
  if (derived) {
    await saveToCache(derived)
    return derived
  }

  // Fallback: cache or generate random (standalone)
  const cached = await loadFromCache()
  if (cached) return cached

  const kp = generateKeypair()
  await saveToCache(kp)
  console.log("[Crypto] Generated random keypair (standalone):", bytesToHex(kp.publicKey).slice(0, 16) + "...")
  return kp
}

// ── Recipients management ───────────────────────────────────────

/** Load the recipients list */
export async function loadRecipients(): Promise<Recipient[]> {
  try {
    const storage = await getStorage()
    const data = await storage.readJSON(RECIPIENTS_KEY)
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

/** Save the recipients list */
export async function saveRecipients(recipients: Recipient[]): Promise<void> {
  const storage = await getStorage()
  await storage.writeJSON(RECIPIENTS_KEY, recipients)
}

/** Ensure this terminal is in the recipients list */
export async function ensureSelfInRecipients(): Promise<Recipient[]> {
  const kp = await getOrCreateKeypair()
  const pubHex = bytesToHex(kp.publicKey)
  const recipients = await loadRecipients()

  const selfExists = recipients.some((r) => r.pubkeyHex === pubHex)
  if (selfExists) return recipients

  const self: Recipient = {
    id: crypto.randomUUID(),
    name: "This Terminal",
    pubkeyHex: pubHex,
    addedAt: new Date().toISOString(),
    isOwn: true,
  }
  const updated = [self, ...recipients]
  await saveRecipients(updated)
  console.log("[Crypto] Added self to recipients list")
  return updated
}

/** Add a new recipient by pubkey hex */
export async function addRecipient(name: string, pubkeyHex: string): Promise<Recipient[]> {
  const clean = pubkeyHex.replace(/^0x/, "").toLowerCase()
  if (clean.length !== 64) throw new Error("Public key must be 32 bytes (64 hex chars)")

  // Validate it's valid hex
  hexToBytes(clean)

  const recipients = await loadRecipients()
  if (recipients.some((r) => r.pubkeyHex === clean)) {
    throw new Error("This public key is already in the recipients list")
  }

  const recipient: Recipient = {
    id: crypto.randomUUID(),
    name,
    pubkeyHex: clean,
    addedAt: new Date().toISOString(),
    isOwn: false,
  }
  const updated = [...recipients, recipient]
  await saveRecipients(updated)
  return updated
}

/** Remove a recipient by id */
export async function removeRecipient(id: string): Promise<Recipient[]> {
  const recipients = await loadRecipients()
  const updated = recipients.filter((r) => r.id !== id)
  await saveRecipients(updated)
  return updated
}

// ── Diagnostics ──────────────────────────────────────────────────

export type KeypairSource = "derived" | "cached" | "fresh-random" | "none"

export interface KeypairDiagnostics {
  /** Hex-encoded public key (with 0x prefix), if any. */
  pubkeyHex: string | null
  /** Where the key came from for the current session. */
  source: KeypairSource
  /** Whether the app is running inside a host (Polkadot Desktop / dot.li). */
  inHost: boolean
  /** Whether `deriveEntropy` succeeded against the host. */
  deriveEntropyAvailable: boolean
  /** Error reason from deriveEntropy if it failed. */
  deriveEntropyError: string | null
  /** The window.location.host value visible to the app — host scopes derivation by this. */
  windowHost: string | null
  /** Blake2b-256 hex digest of the raw entropy seed returned by deriveEntropy. */
  seedHash: string | null
}

/**
 * Diagnostic helper — reports the state of the encryption keypair without
 * mutating it. Useful from devtools to compare two devices that should map
 * to the same account.
 *
 * Open devtools and run:
 *   import("/lib/crypto/keys").then(m => m.inspectKeypair()).then(console.log)
 */
export async function inspectKeypair(): Promise<KeypairDiagnostics> {
  const { isInHost } = await import("@/lib/host/detect")
  const inHost = isInHost()
  const { blake2b } = await import("@noble/hashes/blake2.js")

  const windowHost = typeof window !== "undefined" ? window.location.host : null
  const identifier = getProductIdentifier()

  let deriveEntropyAvailable = false
  let deriveEntropyError: string | null = null
  let derivedPubHex: string | null = null
  let seedHash: string | null = null

  if (inHost && identifier) {
    try {
      type AliasResult = {
        match<T>(ok: (v: { alias: Uint8Array }) => T, err: (e: unknown) => T): T
      }
      const { isTruApiRuntime } = await import("@/lib/host/detect")
      const provider = isTruApiRuntime()
        ? null
        : await (async () => {
            const { sandboxTransport, createAccountsProvider } = await import(
              "@novasamatech/host-api-wrapper"
            )
            return createAccountsProvider(sandboxTransport) as unknown as {
              getProductAccountAlias?: (id: string, idx?: number) => PromiseLike<AliasResult>
            }
          })()

      if (provider && typeof provider.getProductAccountAlias === "function") {
        const aliasResult = await provider.getProductAccountAlias(identifier, 0)
        aliasResult.match<void>(
          (value) => {
            const alias = value.alias
            if (alias instanceof Uint8Array && alias.length === 32) {
              // Hash the alias so we can compare across devices without leaking it.
              seedHash = `0x${bytesToHex(blake2b(alias, { dkLen: 32 }))}`
              const kp = nacl.box.keyPair.fromSecretKey(alias)
              derivedPubHex = `0x${bytesToHex(kp.publicKey)}`
              deriveEntropyAvailable = true
            } else {
              deriveEntropyError = `alias has unexpected shape (len=${(alias as Uint8Array)?.length})`
            }
          },
          (err: unknown) => {
            const e = err as { payload?: { reason?: string }; message?: string }
            deriveEntropyError = e?.payload?.reason ?? e?.message ?? String(err)
          }
        )
      } else {
        deriveEntropyError = "getProductAccountAlias not exposed by product-sdk"
      }
    } catch (e: unknown) {
      deriveEntropyError = e instanceof Error ? e.message : String(e)
    }
  }

  if (derivedPubHex) {
    return {
      pubkeyHex: derivedPubHex,
      source: "derived",
      inHost,
      deriveEntropyAvailable,
      deriveEntropyError,
      windowHost,
      seedHash,
    }
  }

  const cached = await loadFromCache()
  if (cached) {
    return {
      pubkeyHex: `0x${bytesToHex(cached.publicKey)}`,
      source: "cached",
      inHost,
      deriveEntropyAvailable,
      deriveEntropyError,
      windowHost,
      seedHash,
    }
  }

  return {
    pubkeyHex: null,
    source: "none",
    inHost,
    deriveEntropyAvailable,
    deriveEntropyError,
    windowHost,
    seedHash,
  }
}
