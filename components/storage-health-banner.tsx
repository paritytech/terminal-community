"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { probeStorage, type StorageFailure } from "@/lib/storage/host-storage";
import { useSaleStorageHealth, useStorageHealth } from "@/lib/storage/hooks";
import { saveUnsavedSales, useUnsavedSales } from "@/lib/payments/coinage/unsaved-sales";

/** What the merchant reads when storage a table sales do not need fails. */
function describeOtherFailure(kind: StorageFailure): string {
  return kind === "corrupt"
    ? "Some saved data in the Polkadot app can't be read. Sales are not affected."
    : "Some data couldn't be saved in the Polkadot app. Sales are not affected.";
}

/** What the merchant reads when the storage a sale needs fails. */
export function describeStorageFailure(kind: StorageFailure): string {
  switch (kind) {
    case "full":
      return "The Polkadot app's storage is full, so new sales can't be saved. Payments are paused until there is room.";
    case "corrupt":
      return "Saved data in the Polkadot app can't be read, so new sales can't be saved. Payments are paused.";
    case "timeout":
    case "unavailable":
    default:
      return "Can't save to the Polkadot app right now, so new sales can't be saved. Payments are paused.";
  }
}

const FAILURE_COPY = new Set<string>(
  (["full", "corrupt", "timeout", "unavailable"] as const).map((k) => describeStorageFailure(k)),
);

/** True for text `describeStorageFailure` wrote. */
export function isStorageFailureCopy(text: string): boolean {
  return FAILURE_COPY.has(text);
}

/**
 * Shown across the shell while the host's storage fails: sales and the
 * claims behind them cannot be kept, so the merchant must know (the terminal
 * also refuses to charge). "Check again" writes a probe; the banner goes away
 * on the first write that succeeds.
 */
export function StorageHealthBanner() {
  const health = useStorageHealth();
  const saleHealth = useSaleStorageHealth();
  const unsaved = useUnsavedSales();
  const [checking, setChecking] = useState(false);
  if (health.ok && unsaved.length === 0) return null;

  const check = async () => {
    if (checking) return;
    setChecking(true);
    try {
      await probeStorage();
      // Try them whatever the probe said: the save is the real test.
      await saveUnsavedSales();
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      data-testid="storage-health-banner"
      data-kind={!saleHealth.ok ? saleHealth.kind : health.ok ? "unsaved" : `other-${health.kind}`}
      role="alert"
      className="mx-4 mt-3 rounded-nested bg-action-error px-4 py-3 flex flex-col gap-2"
    >
      {!saleHealth.ok ? (
        <p className="text-label-m text-fg-error">{describeStorageFailure(saleHealth.kind)}</p>
      ) : (
        !health.ok && <p className="text-label-m text-fg-error">{describeOtherFailure(health.kind)}</p>
      )}
      {unsaved.length > 0 && (
        <p data-testid="unsaved-sales-count" className="text-label-m text-fg-error">
          {unsaved.length === 1
            ? "1 paid sale isn't saved yet."
            : `${unsaved.length} paid sales aren't saved yet.`}
        </p>
      )}
      <Button
        variant="secondary"
        data-testid="btn-storage-check"
        disabled={checking}
        onClick={() => void check()}
        className="self-start h-auto py-2 px-4 text-label-m"
      >
        {checking ? "Checking…" : "Check again"}
      </Button>
    </div>
  );
}
