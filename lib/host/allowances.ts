/**
 * Host resource-allowance claim.
 *
 * Asks the host (Polkadot Desktop/Mobile) to grant the on-chain quotas that
 * Paseo Asset Hub Next runtime extensions require:
 *   - `BulletinAllowance`         — preimage submits to Paseo Bulletin
 *   - `SmartContractAllowance(0)` — REQUIRED for `Revive.call`. Without it
 *     the chain's `AsPgas` signed-extension has no PGAS budget and rejects
 *     every signed extrinsic with `InvalidTransaction::BadProof`.
 *   - `AutoSigning`               — best-effort; host returns `NotAvailable`
 *     today but we still request so it activates the moment it ships.
 *
 * Single batched `requestResourceAllocation([...])` call; cached for the page
 * lifetime so the host modal only opens once. Already-granted outcomes are
 * idempotent on the host side too. Each host client is loaded only on the
 * runtime that uses it.
 */

"use client";

import { onTruApi } from "./detect";
import { loadHostSdk } from "./sdk";

const REQUESTED = ["BulletinAllowance", "SmartContractAllowance(0)", "AutoSigning"] as const;

let cached: Promise<void> | null = null;

export function claimDefaultAllowances(): Promise<void> {
  if (cached) return cached;
  cached = doClaim().catch((err) => {
    cached = null; // allow retry on failure
    throw err;
  });
  return cached;
}

function logOutcomes(outcomes: ReadonlyArray<string | undefined>): void {
  outcomes.forEach((outcome, i) => console.info(`[allowances] ${REQUESTED[i]}: ${outcome ?? "unknown"}`));
}

async function doClaim(): Promise<void> {
  console.info("[allowances] requesting BulletinAllowance + SmartContractAllowance(0) + AutoSigning");

  if (await onTruApi()) {
    const result = await (await loadHostSdk()).requestResourceAllocation([
      { tag: "BulletinAllowance" },
      { tag: "SmartContractAllowance", value: { tag: "Index", value: 0 } },
      { tag: "AutoSigning" },
    ]);
    if (result.ok) logOutcomes(result.value);
    else console.warn("[allowances] requestResourceAllocation failed:", result.error);
    return;
  }

  const [{ hostApi }, { enumValue }] = await Promise.all([
    import("@novasamatech/host-api-wrapper"),
    import("@novasamatech/host-api"),
  ]);
  const result = await hostApi.requestResourceAllocation(
    enumValue("v1", [
      enumValue("BulletinAllowance", undefined),
      // RFC 0022 (host-api 0.9.x): derivation indices are `Index(u32) | Raw([u8;32])`
      enumValue("SmartContractAllowance", enumValue("Index", 0)),
      enumValue("AutoSigning", undefined),
    ]),
  );
  result.match(
    (response) => {
      const outcomes = ((response as { value?: unknown }).value as { tag?: string }[]) ?? [];
      logOutcomes(outcomes.map((o) => o.tag));
    },
    (err: unknown) => {
      console.warn("[allowances] requestResourceAllocation failed:", err);
    },
  );
}

let permissionCached: Promise<void> | null = null;

/**
 * Grant the host-side `PreimageSubmit` remote permission — the slot that lets
 * the host sign + submit `TransactionStorage.store` preimages on our behalf.
 * Distinct from `BulletinAllowance` (the on-chain quota): without this the host
 * silently drops the submit request and the call hangs. Memoized for the page
 * lifetime; a failure clears the cache so a retry re-prompts.
 */
export function ensurePreimageSubmitPermission(): Promise<void> {
  if (permissionCached) return permissionCached;
  permissionCached = doRequestPreimagePermission().catch((err) => {
    permissionCached = null;
    throw err;
  });
  return permissionCached;
}

async function requestPreimageSubmit(): Promise<boolean> {
  if (await onTruApi()) {
    const result = await (await loadHostSdk()).requestPermission({ tag: "PreimageSubmit" });
    if (!result.ok) {
      throw new Error(`Host rejected the PreimageSubmit permission request: ${result.error.message}`);
    }
    return result.value;
  }
  const { requestPermission } = await import("@novasamatech/host-api-wrapper");
  return requestPermission({ tag: "PreimageSubmit", value: undefined }).match(
    (ok) => ok,
    (err) => {
      throw new Error(
        `Host rejected the PreimageSubmit permission request: ${err?.payload?.reason ?? "transport error"}`,
      );
    },
  );
}

async function doRequestPreimagePermission(): Promise<void> {
  console.info("[allowances] requesting PreimageSubmit remote permission");
  if (!(await requestPreimageSubmit())) {
    throw new Error(
      "The host did not grant the PreimageSubmit permission. Approve the Bulletin write " +
        "permission in the Polkadot app, then retry the report upload.",
    );
  }
}
