"use client";

/**
 * Keeps the merchant Pocket card's snapshot current while the app runs.
 *
 * The card is drawn by a separate executable, the Pocket worker
 * (pocket/worker.ts), which can read nothing of the app but product host
 * storage. So whenever the sales change, this writes the small snapshot the
 * worker draws from (lib/pocket/merchant-card.ts) under SNAPSHOT_KEY. The
 * sales are the ones History and the Sales screen show — `useSalesHistory`,
 * the merchant's own — so the card and the app cannot disagree.
 *
 * Only on the TrUAPI runtime: Pocket cards are drawn by its core, and the
 * native container has no workers, so a snapshot there would never be read.
 */

import { useEffect, useRef } from "react";
import { isInHost, isTruApiRuntime } from "@/lib/host/detect";
import { useSalesHistory } from "@/lib/storage";
import { writeValue } from "@/lib/storage/host-storage";
import { PUSD_DECIMALS, PUSD_SYMBOL } from "@/lib/utils/asset-ids";
import { SNAPSHOT_KEY, buildSnapshot } from "./merchant-card";

/** Sales land in bursts (a sale, then its finality patch): write once they settle. */
const WRITE_DELAY_MS = 500;

export function PocketCardSync() {
  const { sales, isLoading } = useSalesHistory();
  const written = useRef<string | null>(null);

  useEffect(() => {
    if (isLoading || !sales || !isInHost() || !isTruApiRuntime()) return;
    const timer = setTimeout(() => {
      const snapshot = buildSnapshot(sales, { symbol: PUSD_SYMBOL, decimals: PUSD_DECIMALS });
      // Compared without the write time, which changes on every build of it.
      const key = JSON.stringify({ ...snapshot, updatedAt: 0 });
      if (key === written.current) return;
      writeValue(SNAPSHOT_KEY, snapshot)
        .then(() => {
          written.current = key;
        })
        .catch((error: unknown) => console.warn("[pocket] could not write the card snapshot", error));
    }, WRITE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [sales, isLoading]);

  return null;
}
