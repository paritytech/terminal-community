"use client";

/**
 * The admin-QR *binding* — what the rest of the app asks for ("is this
 * terminal bound to a Back Office profile?"), split away from the code that
 * decodes an admin QR.
 *
 * The split is not tidiness. `lib/config/admin-qr.ts` pulls the CBOR/UR
 * decoder, and `@bcts/dcbor` bundles the `collections` shims, which run
 * `Object.empty = …` and `Array.empty = …` at import time — they extend the
 * built-in constructors. In a realm whose intrinsics are sealed that throws
 * `TypeError: Cannot add property empty, object is not extensible` while the
 * module graph is still evaluating, so the whole terminal dies into the error
 * boundary before it renders. That is what the Polkadot app's TrUAPI runtime
 * showed on 2026-09-29 (device log, `terminal-test5.paseo`).
 *
 * Five screens import only the binding below, which is a retired stub that
 * returns `null`. Pointing them here keeps the decoder — and the shims — out
 * of the boot graph entirely; it is loaded only where a QR is actually being
 * scanned.
 *
 * The binding itself is RETIRED (2026-08): the Back Office flow that produced
 * it is gone, so there is no binding until it returns. The shape is kept so
 * the call sites stay untouched.
 */

import type { T3rminalConfigQrPayloadV2 } from "./t3rminal-config-qr";

/** Settings key holding the decoded v2 payload (JSON of the typed object). */
export const ADMIN_QR_PAYLOAD_SETTING = "admin-qr/payload-v2";

/** Always `null` — no admin binding exists until the Back Office flow returns. */
export async function loadAdminQrPayload(): Promise<T3rminalConfigQrPayloadV2 | null> {
  return null;
}

/** Always `null`. See {@link loadAdminQrPayload}. */
export function useAdminQrPayload(): T3rminalConfigQrPayloadV2 | null | undefined {
  return null;
}

export type { T3rminalConfigQrPayloadV2 };
