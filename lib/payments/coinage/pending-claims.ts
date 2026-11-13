/**
 * Claims that were handed to the host but had not reached their first
 * `claimed` yet, kept in host storage so an app restart cannot lose them.
 *
 * The claim itself lives in memory (use-coinage-payment.ts): the cheque's
 * keys, the payment id, the status subscription. Before the terminal
 * registers a top-up it writes a pending claim here — the sale as it would
 * be recorded, plus every registration id that may hold the coins. If the
 * app restarts before the claim settles, the host still claims the coins and
 * reports it on those ids; `resumePendingClaims` (run at launch, see
 * lib/components/topup-watcher-boot.tsx) follows them and records the sale,
 * or forgets the claim when nothing was credited.
 *
 * In the normal case the sale is written in-session and the pending claim is
 * dropped right after.
 */

import { addSaleRecord } from "@/lib/storage/database";
import { readTable, writeTable } from "@/lib/storage/host-storage";
import type { SaleRecord } from "@/lib/storage/types";
import { amountToPlanck, formatAmountFromPlanck } from "@/lib/utils/format";
import {
  awaitTopUpStatus,
  topUpIdFromHex,
  type ClaimHost,
  type SettledTopUpStatus,
  type TopUpStatusEvent,
} from "./claim";

const TABLE = "pendingClaims";
/** CASH has 6 decimals. */
const DECIMALS = 6;
/** How long one launch waits for a pending claim to settle before leaving it for the next. */
const RESUME_TTL_MS = 60 * 60 * 1000;
/** A claim nobody could settle in this long is given up (and reported). */
const MAX_PENDING_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** The parts of a coins sale that come from the terminal, not from the claim. */
export interface CoinsSaleDraft {
  asset: string;
  assetId: string;
  merchantAddress: string;
  items?: SaleRecord["items"];
  tip?: string;
  note?: string;
}

/** How a claim settled — what the sale record needs from it. */
export interface CoinsClaimOutcome {
  paymentId: string;
  /** Decimal amount credited. */
  amount: string;
  /** Decimal amount the cheque asked for. */
  requestedAmount: string;
  partial: boolean;
  finalized: boolean;
  /** Hex (no 0x) of the registration that holds the coins. */
  topUpId: string;
}

export interface PendingClaim {
  paymentId: string;
  /** Decimal amount the cheque asked for. */
  requestedAmount: string;
  /** Registration ids (hex, no 0x) that may hold the coins, oldest first. */
  topUpIds: string[];
  draft: CoinsSaleDraft;
  createdAt: string;
}

/** The sale record for a settled coins claim. One shape for every path that writes one. */
export function coinsSaleRecord(
  draft: CoinsSaleDraft,
  outcome: CoinsClaimOutcome,
  at: Date,
): Omit<SaleRecord, "id" | "createdAt" | "syncStatus"> {
  return {
    saleId: outcome.paymentId,
    amount: outcome.amount,
    amountPlanck: amountToPlanck(outcome.amount, DECIMALS).toString(),
    asset: draft.asset,
    assetId: draft.assetId,
    merchantAddress: draft.merchantAddress,
    customerAddress: "anonymous",
    merchantAddressNormalized: draft.merchantAddress,
    customerAddressNormalized: "anonymous",
    transactionHash: outcome.paymentId,
    blockNumber: 0,
    blockHash: outcome.paymentId,
    timestamp: at,
    // Final only when the host said so (or the claim settled partially,
    // which is final). Otherwise the watcher stamps it later.
    finalizedAt: outcome.finalized ? at : undefined,
    topUpId: outcome.topUpId,
    requestedAmount: outcome.partial ? outcome.requestedAmount : undefined,
    requestedAmountPlanck: outcome.partial
      ? amountToPlanck(outcome.requestedAmount, DECIMALS).toString()
      : undefined,
    type: "incoming",
    items: draft.items,
    tip: draft.tip,
    note: draft.note,
  };
}

export async function getPendingClaims(): Promise<PendingClaim[]> {
  return readTable<PendingClaim>(TABLE);
}

// The table is read, changed and written back; run those one at a time so a
// save and a drop that overlap cannot erase each other.
let tableQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(change: () => Promise<T>): Promise<T> {
  const run = tableQueue.then(change, change);
  tableQueue = run.catch(() => undefined);
  return run;
}

/** Record (or extend) the pending claim for `paymentId` with `topUpIds`. */
export function savePendingClaim(claim: Omit<PendingClaim, "createdAt">): Promise<void> {
  return serialized(async () => {
    const all = await getPendingClaims();
    const existing = all.find((c) => c.paymentId === claim.paymentId);
    const topUpIds = [...new Set([...(existing?.topUpIds ?? []), ...claim.topUpIds])];
    const next: PendingClaim = {
      ...claim,
      topUpIds,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    await writeTable(TABLE, [...all.filter((c) => c.paymentId !== claim.paymentId), next]);
  });
}

export function dropPendingClaim(paymentId: string): Promise<void> {
  return serialized(async () => {
    const all = await getPendingClaims();
    if (!all.some((c) => c.paymentId === paymentId)) return;
    await writeTable(TABLE, all.filter((c) => c.paymentId !== paymentId));
  });
}

// Claims this document is running itself; a resume leaves them alone.
const inSession = new Set<string>();
// Claims a resume is following right now: a second resume skips them.
const following = new Set<string>();
export function markClaimInSession(paymentId: string): void {
  inSession.add(paymentId);
}

function isNotFound(error: unknown): boolean {
  const payload = (error as { payload?: unknown })?.payload;
  const text = payload instanceof Error ? payload.name : JSON.stringify(payload ?? "");
  return /NotFound/i.test(text ?? "");
}

function settles(status: TopUpStatusEvent): status is SettledTopUpStatus {
  return status.type === "claimed" || status.type === "claimedPartially" || status.type === "notClaimed";
}

export interface ResumeDeps {
  host: Pick<ClaimHost, "subscribeTopUpStatus">;
  saleExists: (saleId: string) => Promise<boolean>;
  addSale?: (sale: Omit<SaleRecord, "id" | "createdAt">) => Promise<unknown>;
  /** Hand a recorded, not yet final sale to the finality watcher. */
  watchFinality: (target: { saleId: string; topUpIdHex: string }) => void;
  signal?: AbortSignal;
  /** How long to wait for one claim this launch (default an hour). */
  ttlMs?: number;
  now?: () => number;
}

/**
 * Follow every pending claim from an earlier launch, all at once, to the
 * registration that credited the coins, and record the sale; drop the claim
 * when no registration credited anything. A claim whose status cannot be read
 * now (the host dropped us, or it did not settle within the TTL) stays
 * pending for the next launch. Returns the number of sales recorded.
 */
export async function resumePendingClaims(deps: ResumeDeps): Promise<number> {
  const claims = await getPendingClaims();
  const results = await Promise.allSettled(claims.map((claim) => resumeClaim(claim, deps)));
  for (const r of results) {
    if (r.status === "rejected") console.warn("[PendingClaims] resume failed:", r.reason);
  }
  return results.filter((r) => r.status === "fulfilled" && r.value).length;
}

async function resumeClaim(claim: PendingClaim, deps: ResumeDeps): Promise<boolean> {
  const { paymentId } = claim;
  if (inSession.has(paymentId) || following.has(paymentId)) return false;
  following.add(paymentId);

  // One signal for this claim: the caller's, or the TTL running out.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deps.ttlMs ?? RESUME_TTL_MS);
  const onOuterAbort = () => abort.abort();
  deps.signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    if (await deps.saleExists(paymentId)) {
      await dropPendingClaim(paymentId);
      return false;
    }
    const age = (deps.now?.() ?? Date.now()) - Date.parse(claim.createdAt);
    if (age > MAX_PENDING_AGE_MS) {
      console.warn(`[PendingClaims] ${paymentId}: unsettled for over 30 days — giving up`, claim);
      await dropPendingClaim(paymentId);
      return false;
    }

    // Newest registration first. One that credited nothing does not mean an
    // older one didn't: a retry can follow a registration that already took
    // the coins, so keep going until one credited or all are accounted for.
    let credited: { status: SettledTopUpStatus; topUpId: string } | null = null;
    let unresolved = false;
    for (const topUpId of [...claim.topUpIds].reverse()) {
      let status: SettledTopUpStatus;
      try {
        status = await awaitTopUpStatus(deps.host, topUpIdFromHex(topUpId), settles, abort.signal);
      } catch (error) {
        if (abort.signal.aborted) {
          unresolved = true;
          break;
        }
        if (!isNotFound(error)) unresolved = true;
        continue;
      }
      if (status.type === "claimed" || (status.type === "claimedPartially" && status.actualClaimed > 0n)) {
        credited = { status, topUpId };
        break;
      }
    }

    if (!credited) {
      if (!unresolved) {
        console.log(`[PendingClaims] ${paymentId}: nothing was credited — forgetting the claim`);
        await dropPendingClaim(paymentId);
      }
      return false;
    }

    // Another path may have recorded it while we waited.
    if (await deps.saleExists(paymentId)) {
      await dropPendingClaim(paymentId);
      return false;
    }

    const { status, topUpId } = credited;
    const partial = status.type === "claimedPartially";
    const amount = formatAmountFromPlanck(
      (partial ? status.actualClaimed : amountToPlanck(claim.requestedAmount, DECIMALS)).toString(),
      DECIMALS,
    );
    const finalized = partial || (status.type === "claimed" && status.finalized);
    const addSale = deps.addSale ?? ((sale) => addSaleRecord(sale as Omit<SaleRecord, "id" | "createdAt">));
    const record = coinsSaleRecord(
      claim.draft,
      { paymentId, amount, requestedAmount: claim.requestedAmount, partial, finalized, topUpId },
      // The sale happened when the claim was registered, not at this launch.
      new Date(claim.createdAt),
    );
    await addSale({ ...record, finalizedAt: finalized ? new Date() : undefined, syncStatus: "pending" });
    await dropPendingClaim(paymentId);
    console.log(`[PendingClaims] ${paymentId}: recorded the sale the host claimed after a restart`);
    if (!finalized) deps.watchFinality({ saleId: paymentId, topUpIdHex: topUpId });
    return true;
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onOuterAbort);
    following.delete(paymentId);
  }
}
