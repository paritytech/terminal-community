/**
 * Report encryption under the merchant's passphrase.
 *
 * Reports go to Bulletin, which anyone can read, forever. So the key that
 * seals them has to resist offline guessing:
 *
 *   v3 (current) — key = scrypt(passphrase, random 16-byte salt), the salt
 *     and scrypt parameters in the envelope. A guess costs one scrypt per
 *     envelope, and no table computed once works against every merchant.
 *     `meta.keyCheck` lets the reader tell "wrong key" from "damaged copy";
 *     it is derived from the salted key, so it is no cheaper to attack than
 *     the AEAD tag itself.
 *   v2 (legacy, read-only) — key = SHA-256 of a fixed prefix + passphrase,
 *     with the key's fingerprint in the clear. Kept so reports already on
 *     the chain still open; nothing writes it any more.
 *
 * Both use XChaCha20-Poly1305: hex(nonce(24) || ciphertext).
 */

"use client"

import { scryptAsync } from "@noble/hashes/scrypt.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { randomBytes } from "@noble/hashes/utils.js"
import { xchachaEncryptPacked, xchachaDecryptPacked } from "@/lib/crypto/primitives"
import { deriveLegacyKey, legacyKeyFingerprint } from "@/lib/crypto/manual-key"

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) throw new Error("Invalid hex")
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/** scrypt cost for new envelopes: 2^15 × 8 × 128 B = 32 MiB, ~0.1–0.5 s. */
export const REPORT_KDF = { name: "scrypt", N: 2 ** 15, r: 8, p: 1 } as const
/** The most an envelope may ask a reader to spend, so a forged one can't hang the app. */
const MAX_N = 2 ** 17
const SALT_LENGTH = 16
const KEY_CHECK_DOMAIN = new TextEncoder().encode("t3rminal-report-key-check")

interface ReportMeta {
  date: string
  txCount: number
  terminal: string
  encryptedAt: string
}

export interface EncryptedReportV3 {
  v: 3
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string }
  encrypted: string
  meta: ReportMeta & {
    /** First 4 bytes of SHA-256(domain || key): tells a wrong key from a damaged copy. */
    keyCheck: string
  }
}

export interface EncryptedReportV2 {
  v: 2
  encrypted: string
  meta: ReportMeta & { keyFingerprint: string }
}

export type EncryptedReport = EncryptedReportV2 | EncryptedReportV3

function normalisePassphrase(passphrase: string): Uint8Array {
  return new TextEncoder().encode(passphrase.trim().normalize("NFKC"))
}

async function deriveReportKey(
  passphrase: string,
  salt: Uint8Array,
  params: { N: number; r: number; p: number },
): Promise<Uint8Array> {
  return scryptAsync(normalisePassphrase(passphrase), salt, { ...params, dkLen: 32 })
}

function keyCheck(key: Uint8Array): string {
  const input = new Uint8Array(KEY_CHECK_DOMAIN.length + key.length)
  input.set(KEY_CHECK_DOMAIN, 0)
  input.set(key, KEY_CHECK_DOMAIN.length)
  return bytesToHex(sha256(input)).slice(0, 8)
}

/** Seal a report under `passphrase` as a v3 envelope (fresh salt, fresh nonce). */
export async function encryptReport(
  reportJson: string,
  passphrase: string,
  meta: { date: string; txCount: number; terminal: string },
): Promise<EncryptedReportV3> {
  const salt = randomBytes(SALT_LENGTH)
  const { N, r, p } = REPORT_KDF
  const key = await deriveReportKey(passphrase, salt, { N, r, p })
  try {
    const packed = xchachaEncryptPacked(new TextEncoder().encode(reportJson), key)
    return {
      v: 3,
      kdf: { name: "scrypt", N, r, p, salt: bytesToHex(salt) },
      encrypted: bytesToHex(packed),
      meta: { ...meta, encryptedAt: new Date().toISOString(), keyCheck: keyCheck(key) },
    }
  } finally {
    key.fill(0)
  }
}

/** The passphrase on this device is not the one the report was sealed with. */
export class WrongReportKeyError extends Error {
  /** v2 envelopes name the key they need; v3 ones do not publish it. */
  readonly fingerprint?: string
  constructor(fingerprint?: string) {
    super(
      `This report was encrypted with a different key${fingerprint ? ` (${fingerprint})` : ""}. ` +
        "Set that key in Settings → Report Encryption to open it.",
    )
    this.name = "WrongReportKeyError"
    this.fingerprint = fingerprint
  }
}

/** The key is right but the ciphertext does not open: a damaged copy. */
export class DamagedReportError extends Error {
  constructor() {
    super("This report could not be decrypted: the stored copy looks damaged.")
    this.name = "DamagedReportError"
  }
}

function validKdf(kdf: EncryptedReportV3["kdf"]): boolean {
  return (
    kdf?.name === "scrypt" &&
    Number.isInteger(kdf.N) && kdf.N >= 2 && kdf.N <= MAX_N && (kdf.N & (kdf.N - 1)) === 0 &&
    kdf.r === 8 && kdf.p === 1 &&
    typeof kdf.salt === "string" && /^[0-9a-f]{32}$/i.test(kdf.salt)
  )
}

/** Open a v2 or v3 envelope with `passphrase`; returns the report JSON. */
export async function decryptReport(envelope: EncryptedReport, passphrase: string): Promise<string> {
  if (envelope.v === 2) {
    const sealedWith = envelope.meta?.keyFingerprint?.toUpperCase()
    const current = legacyKeyFingerprint(passphrase)
    if (sealedWith && sealedWith !== current) throw new WrongReportKeyError(sealedWith)
    const key = deriveLegacyKey(passphrase)
    try {
      return new TextDecoder().decode(xchachaDecryptPacked(hexToBytes(envelope.encrypted), key))
    } catch {
      if (sealedWith) throw new DamagedReportError()
      throw new WrongReportKeyError()
    } finally {
      key.fill(0)
    }
  }

  if (!validKdf(envelope.kdf)) throw new DamagedReportError()
  const { N, r, p, salt } = envelope.kdf
  const key = await deriveReportKey(passphrase, hexToBytes(salt), { N, r, p })
  try {
    const check = envelope.meta?.keyCheck?.toLowerCase()
    if (check && check !== keyCheck(key)) throw new WrongReportKeyError()
    try {
      return new TextDecoder().decode(xchachaDecryptPacked(hexToBytes(envelope.encrypted), key))
    } catch {
      if (check) throw new DamagedReportError()
      throw new WrongReportKeyError()
    }
  } finally {
    key.fill(0)
  }
}

export function isEncryptedReport(data: unknown): data is EncryptedReport {
  if (!data || typeof data !== "object") return false
  const d = data as Record<string, unknown>
  return (d.v === 2 || d.v === 3) && typeof d.encrypted === "string" && typeof d.meta === "object"
}
