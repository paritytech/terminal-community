/**
 * On-chain indexing toggle.
 *
 * When ON (default): after the bulletin upload, `storeDailyReportViaRevive`
 * writes the same CID to the `T3rminalBulletinIndex` contract so the report is
 * mirrored on-chain. Turning it OFF keeps the CID in local storage only — the
 * bulletin upload still happens (reports stay retrievable by CID), but no
 * contract write pins it on-chain.
 *
 * When ON: after the bulletin upload, `storeDailyReportViaRevive` writes
 * the same CID to the `T3rminalBulletinIndex` contract on Paseo Asset Hub
 * via the host's signer. This costs the merchant a signed transaction (and
 * requires statement-slot allowance on the bridging chain), but produces
 * an audit trail the customer / regulator can read directly from chain
 * state without trusting the merchant's local DB.
 */

"use client";

import { getSetting, setSetting } from "@/lib/storage/database";
import { onStorageChange } from "@/lib/storage/host-storage";
import { useEffect, useState } from "react";

export const ONCHAIN_INDEXING_SETTING = "daily-report/onchain-indexing";

export async function isOnchainIndexingEnabled(): Promise<boolean> {
  const raw = await getSetting(ONCHAIN_INDEXING_SETTING);
  // Default ON — only an explicit "false" disables on-chain mirroring.
  return raw !== "false";
}

export async function setOnchainIndexingEnabled(enabled: boolean): Promise<void> {
  await setSetting(ONCHAIN_INDEXING_SETTING, enabled ? "true" : "false");
}

/**
 * Reactive hook — flips whenever the setting changes from any tab/page.
 * Returns `undefined` until the first read resolves so the UI can show a
 * loading state instead of flashing the default.
 */
export function useOnchainIndexing(): {
  enabled: boolean | undefined;
  setEnabled: (next: boolean) => Promise<void>;
} {
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void isOnchainIndexingEnabled().then(
        (v) => {
          if (alive) setEnabled(v);
        },
        (err) => {
          // Unreadable: keep the default (on) rather than loading forever.
          console.warn("[OnchainIndexing] setting unreadable:", err);
          if (alive) setEnabled((prev) => prev ?? true);
        },
      );
    };
    refresh();
    const off = onStorageChange("settings", refresh);
    return () => {
      alive = false;
      off();
    };
  }, []);

  return {
    enabled,
    setEnabled: async (next: boolean) => {
      await setOnchainIndexingEnabled(next);
      setEnabled(next);
    },
  };
}
