/**
 * The merchant's report-encryption passphrase.
 *
 * The merchant types it on Settings → Report Encryption (or Merchant
 * Profile); it is kept in this device's localStorage and never leaves it.
 * Reports are sealed under a key derived from it per report with scrypt and a
 * random salt (see lib/crypto/symmetric-report.ts).
 *
 * The fingerprint shown in Settings lets the merchant check that two
 * terminals hold the same phrase. It is computed on the device only and is no
 * longer written into new reports.
 */

"use client"

import { sha256 } from "@noble/hashes/sha2.js"

const PASSPHRASE_KEY = "t3rminal:manual-encryption-passphrase"

/** Reports are public ciphertext, so the phrase has to be long enough to resist guessing. */
export const MIN_PASSPHRASE_LENGTH = 12

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** Why `passphrase` can't be used as the report key, or null when it can. */
export function passphraseProblem(passphrase: string): string | null {
  const trimmed = passphrase.trim()
  if (!trimmed) return "Passphrase cannot be empty"
  if ([...trimmed].length < MIN_PASSPHRASE_LENGTH) {
    return `Use at least ${MIN_PASSPHRASE_LENGTH} characters — a few words work well.`
  }
  return null
}

export function setManualPassphrase(passphrase: string): void {
  if (typeof window === "undefined") return
  const problem = passphraseProblem(passphrase)
  if (problem) throw new Error(problem)
  localStorage.setItem(PASSPHRASE_KEY, passphrase.trim())
}

/**
 * Put back a phrase this device held a moment ago (Settings → Clear → Undo).
 * Skips the length rule: a phrase set before the rule existed still has to
 * come back, or its reports could no longer be opened.
 */
export function restoreManualPassphrase(passphrase: string): void {
  if (typeof window === "undefined") return
  const trimmed = passphrase.trim()
  if (!trimmed) return
  localStorage.setItem(PASSPHRASE_KEY, trimmed)
}

export function getManualPassphrase(): string | null {
  if (typeof window === "undefined") return null
  return localStorage.getItem(PASSPHRASE_KEY)
}

export function clearManualPassphrase(): void {
  if (typeof window === "undefined") return
  localStorage.removeItem(PASSPHRASE_KEY)
}

export function hasManualKey(): boolean {
  return getManualPassphrase() !== null
}

/**
 * The legacy (v2) report key: one SHA-256 over a fixed prefix and the phrase.
 * Only for opening reports sealed before v3 — never used to seal.
 */
export function deriveLegacyKey(passphrase: string): Uint8Array {
  return sha256(utf8(`t3rminal-manual-key:${passphrase.trim()}`))
}

/** First 8 hex chars of SHA-256 over the legacy key — what v2 envelopes carry. */
export function legacyKeyFingerprint(passphrase: string): string {
  const key = deriveLegacyKey(passphrase)
  try {
    return bytesToHex(sha256(key)).slice(0, 8).toUpperCase()
  } finally {
    key.fill(0)
  }
}

/**
 * Short fingerprint of this device's phrase, for comparing terminals in
 * Settings. Same value as the legacy v2 envelopes named, so a merchant can
 * still match an old report's key; computed locally, never published.
 */
export function manualKeyFingerprint(): string | null {
  const p = getManualPassphrase()
  if (!p) return null
  return legacyKeyFingerprint(p)
}
