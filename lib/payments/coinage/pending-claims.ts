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

/** Record (or extend) the pending claim for `paymentId` with `topUpIds`. */
export async function savePendingClaim(claim: Omit<PendingClaim, "createdAt">): Promise<void> {
  const all = await getPendingClaims();
  const existing = all.find((c) => c.paymentId === claim.paymentId);
  const topUpIds = [...new Set([...(existing?.topUpIds ?? []), ...claim.topUpIds])];
  const next: PendingClaim = {
    ...claim,
    topUpIds,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  await writeTable(TABLE, [...all.filter((c) => c.paymentId !== claim.paymentId), next]);
}

export async function dropPendingClaim(paymentId: string): Promise<void> {
  const all = await getPendingClaims();
  if (!all.some((c) => c.paymentId === paymentId)) return;
  await writeTable(TABLE, all.filter((c) => c.paymentId !== paymentId));
}

// Claims this document is running itself; a resume leaves them alone.
const inSession = new Set<string>();
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
}

/**
 * Follow every pending claim from an earlier launch to its first settling
 * status and record the sale (or drop the claim when nothing was credited).
 * A claim whose status cannot be read now (the host dropped us) stays
 * pending for the next launch. Returns the number of sales recorded.
 */
export async function resumePendingClaims(deps: ResumeDeps): Promise<number> {
  const addSale = deps.addSale ?? ((sale) => addSaleRecord(sale as Omit<SaleRecord, "id" | "createdAt">));
  let recorded = 0;
  for (const claim of await getPendingClaims()) {
    if (inSession.has(claim.paymentId)) continue;
    if (await deps.saleExists(claim.paymentId)) {
      await dropPendingClaim(claim.paymentId);
      continue;
    }

    let settled: { status: SettledTopUpStatus; topUpId: string } | null = null;
    let allUnknown = true;
    // Newest registration first: a retry supersedes the one before it.
    for (const topUpId of [...claim.topUpIds].reverse()) {
      try {
        const status = await awaitTopUpStatus(deps.host, topUpIdFromHex(topUpId), settles, deps.signal);
        settled = { status, topUpId };
        allUnknown = false;
        break;
      } catch (error) {
        if (deps.signal?.aborted) return recorded;
        if (!isNotFound(error)) allUnknown = false;
      }
    }

    if (!settled) {
      // Every registration is unknown to the host: nothing was taken.
      if (allUnknown) await dropPendingClaim(claim.paymentId);
      continue;
    }

    const { status, topUpId } = settled;
    const credited =
      status.type === "claimed"
        ? claim.requestedAmount
        : status.type === "claimedPartially"
          ? formatAmountFromPlanck(status.actualClaimed.toString(), DECIMALS)
          : null;
    if (credited === null || (status.type === "claimedPartially" && status.actualClaimed <= 0n)) {
      console.log(`[PendingClaims] ${claim.paymentId}: nothing was credited — forgetting the claim`);
      await dropPendingClaim(claim.paymentId);
      continue;
    }

    const partial = status.type === "claimedPartially";
    const finalized = partial || (status.type === "claimed" && status.finalized);
    await addSale({
      ...coinsSaleRecord(
        claim.draft,
        { paymentId: claim.paymentId, amount: credited, requestedAmount: claim.requestedAmount, partial, finalized, topUpId },
        new Date(),
      ),
      syncStatus: "pending",
    });
    await dropPendingClaim(claim.paymentId);
    recorded++;
    console.log(`[PendingClaims] ${claim.paymentId}: recorded the sale the host claimed after a restart`);
    if (!finalized) deps.watchFinality({ saleId: claim.paymentId, topUpIdHex: topUpId });
  }
  return recorded;
}
