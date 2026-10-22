/**
 * T3rminal-side admin QR ingest helpers.
 *
 * The terminal scans a single QR from the W3sPay admin and gets back
 * everything it needs to operate against this merchant:
 *
 *   - the full item catalog (mapped into `lib/items/catalog`),
 *   - the merchant/display/payout binding (persisted as settings),
 *   - the report password derived by the admin (kept locally so future
 *     report encryption can recover it without re-prompting).
 *
 * Decode + multipart reassembly is delegated to the shared
 * `@/lib/config/t3rminal-config-qr` package — this module only owns
 * persistence and the catalog hand-off. Scanner failures are surfaced
 * as `null` results, never thrown exceptions, so the UI can show a
 * recoverable error instead of crashing the route.
 */

"use client";

import {
  createT3rminalConfigQrMultipartDecoder,
  decodeT3rminalConfigQr,
  type DecodedT3rminalConfigQr,
  type T3rminalConfigQrPayloadV2,
} from "@/lib/config/t3rminal-config-qr";

import { overwriteCatalogFromQr } from "@/lib/items/catalog";
import { registerSecret } from "@/lib/telemetry/scrub";
import { getSetting, setSetting } from "@/lib/storage/database";
import { ADMIN_QR_PAYLOAD_SETTING } from "./admin-qr-binding";

/** Settings key holding the raw uppercase UR string of the most recent scan. */
export const ADMIN_QR_RAW_SETTING = "admin-qr/raw";

export type AdminQrScanOutcome =
  | { readonly kind: "v2-imported"; readonly payload: T3rminalConfigQrPayloadV2 }
  | { readonly kind: "v1-acknowledged"; readonly payload: DecodedT3rminalConfigQr & { kind: "v1-json" } }
  | { readonly kind: "invalid" };

/**
 * Try to decode a single scanned QR text frame as a non-multipart admin
 * config QR. Returns `null` if the frame is not a complete payload — the
 * caller should keep scanning and feed subsequent frames to a multipart
 * accumulator (see {@link createAdminQrScanAccumulator}).
 */
export function tryDecodeAdminQrFrame(raw: string): DecodedT3rminalConfigQr | null {
  return decodeT3rminalConfigQr(raw);
}

/**
 * Create an accumulator suitable for streaming raw QR text frames from
 * `html5-qrcode`. Single-frame URs decode immediately; multipart URs
 * accumulate until the fountain code completes.
 */
export function createAdminQrScanAccumulator() {
  return createT3rminalConfigQrMultipartDecoder();
}

/**
 * Persist the raw UR string and the decoded v2 payload, then overwrite
 * the on-device catalog with the items embedded in the payload.
 *
 * Catalog overwrite uses the shared QR config — the synthesized
 * category/item ids are local to this terminal; the merchant binding
 * lives in settings, not in the catalog rows.
 */
export async function importAdminQrConfig(
  payload: T3rminalConfigQrPayloadV2,
  rawUr: string,
): Promise<void> {
  registerSecret(payload.reportPassword);
  // Serialize the two `settings` writes — they target the same host-storage
  // table and a concurrent read/modify/write race here was producing
  // `StorageErr::Unknown` in the host. The catalog overwrite hits different
  // tables so it can run alongside.
  await Promise.all([
    (async () => {
      await setSetting(ADMIN_QR_RAW_SETTING, rawUr);
      await setSetting(ADMIN_QR_PAYLOAD_SETTING, JSON.stringify(payload));
    })(),
    overwriteCatalogFromQr(payload.config),
  ]);
}

/**
 * Return the most recently scanned admin QR payload, or `null` if the
 * terminal has never been bound or the stored payload is malformed.
 * Malformed input does not throw — operators just see "no config" and
 * can rescan.
 */
/**
 * RETIRED (2026-08): the back-office admin-QR binding is parked until the
 * multi-terminal / Back Office upgrade. The read paths return `null`
 * unconditionally, so every consumer (payout address, business identity,
 * terminal/merchant ids, item catalog) falls back to manual configuration —
 * the merchant profile and the host product account. The import/scan helpers
 * above are kept intact for when the flow returns; any previously stored
 * payload stays in storage but is never read.
 *
 * Lives in ./admin-qr-binding so the five screens that only ask for the
 * binding never pull the CBOR decoder (and the built-in shims it carries)
 * into the boot graph — see that module's header.
 */
export { ADMIN_QR_PAYLOAD_SETTING, loadAdminQrPayload, useAdminQrPayload } from "./admin-qr-binding";

/** Return the most recent raw UR text, or `null` if none stored. */
export async function loadAdminQrRaw(): Promise<string | null> {
  const raw = await getSetting(ADMIN_QR_RAW_SETTING);
  return raw ?? null;
}
