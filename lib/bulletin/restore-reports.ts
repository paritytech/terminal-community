"use client";

/**
 * Restore daily-report records from the on-chain BulletinIndex into local
 * storage. This is the recovery path: if a terminal loses its localStorage,
 * it can repopulate the report list (date + CID + metadata) straight from the
 * contract for its own (merchantId, terminalId).
 *
 * Reports already present locally are left untouched — restore never overwrites
 * a finalized day, it only fills gaps.
 */

import {
  getAllDatesViaRevive,
  getMetadataViaRevive,
} from "@/lib/contracts/revive-bulletin-index";
import { gatewayUrlForCid } from "./client";
import { addDailyReport, getAllDailyReports } from "@/lib/storage/database";

export interface RestoreResult {
  total: number; // dates found on-chain
  restored: number; // dates written into local storage
  skipped: number; // dates already present locally
}

export async function restoreReportsFromChain(
  merchantId: string,
  terminalId: string,
): Promise<RestoreResult> {
  const dates = await getAllDatesViaRevive(merchantId, terminalId);
  const local = await getAllDailyReports();
  const present = new Set(local.map((r) => r.date));

  let restored = 0;
  let skipped = 0;

  for (const date of dates) {
    if (present.has(date)) {
      skipped += 1;
      continue;
    }
    const meta = await getMetadataViaRevive(merchantId, terminalId, date);
    if (!meta.exists) {
      skipped += 1;
      continue;
    }
    await addDailyReport({
      date,
      cid: meta.cid,
      gatewayUrl: gatewayUrlForCid(meta.cid),
      bulletinBlockHash: "restored-from-chain",
      entryCount: meta.entryCount,
      merchantAddress: "",
      terminalId: meta.terminalId || terminalId,
      finalized: meta.finalized,
      signedBy: "",
      publishedAt: meta.publishedAt ? new Date(meta.publishedAt * 1000) : new Date(),
    });
    restored += 1;
  }

  return { total: dates.length, restored, skipped };
}
