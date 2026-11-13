"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  RefreshCw,
  Loader2,
  FileText,
  Calendar,
  Clock,
  Lock,
  CloudDownload,
} from "lucide-react";
import { isInHost } from "@/lib/host/detect";
import {
  getMerchantTerminal,
  getAllDatesViaRevive,
  getMetadataViaRevive,
  type OnChainDayMetadata,
} from "@/lib/contracts/revive-bulletin-index";
import { restoreReportsFromChain, type RestoreResult } from "@/lib/bulletin/restore-reports";
import { captureError } from "@/lib/telemetry";

interface ReportEntry {
  date: string;
  metadata: OnChainDayMetadata;
}

export default function BackupRestorePage() {
  const [entries, setEntries] = useState<ReportEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  // Gate host-dependent UI until after mount so the static-export prerender
  // (always "not in host") matches the first client render — avoids hydration
  // mismatch when the app is actually running inside the Polkadot host.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const inHost = mounted && isInHost();

  const load = useCallback(async () => {
    if (!isInHost()) return;
    setIsLoading(true);
    setError(null);
    try {
      const { merchantId, terminalId } = await getMerchantTerminal();
      const dates = await getAllDatesViaRevive(merchantId, terminalId);
      const rows: ReportEntry[] = [];
      for (const date of dates) {
        try {
          const metadata = await getMetadataViaRevive(merchantId, terminalId, date);
          if (metadata.exists) rows.push({ date, metadata });
        } catch (err) {
          console.warn(`[Backup] metadata fetch failed for ${date}:`, err);
        }
      }
      rows.sort((a, b) => b.date.localeCompare(a.date));
      setEntries(rows);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load backup";
      setError(msg);
      captureError(err, { component: "backup", phase: "load" });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRestore = async () => {
    setRestoring(true);
    setError(null);
    setRestoreResult(null);
    try {
      const { merchantId, terminalId } = await getMerchantTerminal();
      const result = await restoreReportsFromChain(merchantId, terminalId);
      setRestoreResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Restore failed";
      setError(msg);
      captureError(err, { component: "backup", phase: "restore" });
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 min-h-0 flex flex-col max-w-md mx-auto w-full">
        {/* Header */}
        <header className="flex items-center justify-between px-4 py-4">
          <Link href="/settings/backup" className="p-2">
            <ArrowLeft className="w-6 h-6 text-white" />
          </Link>
          <div className="flex items-center gap-2">
            <CloudDownload className="w-5 h-5 text-white" />
            <span className="text-white font-medium">Backup &amp; Restore</span>
          </div>
          <button onClick={() => void load()} disabled={isLoading} className="p-2">
            <RefreshCw className={`w-5 h-5 text-white ${isLoading ? "animate-spin" : ""}`} />
          </button>
        </header>

        {mounted && !inHost && (
          <div className="px-6 py-2">
            <div className="bg-yellow-900/30 border border-yellow-800 rounded-lg p-3 text-yellow-400 text-sm">
              Backup is only available inside Polkadot
            </div>
          </div>
        )}

        {/* Restore action */}
        <div className="px-6 py-2 space-y-2">
          <p className="text-neutral-400 text-xs">
            Your backed-up reports for this terminal. Restore re-populates your
            local report list — use it if this device lost its local data.
          </p>
          <button
            type="button"
            onClick={handleRestore}
            disabled={restoring || !inHost}
            className="w-full bg-neutral-800 hover:bg-neutral-700 text-white py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition border border-neutral-700 disabled:opacity-40"
          >
            {restoring ? (
              <><Loader2 className="w-5 h-5 animate-spin" /><span>Restoring…</span></>
            ) : (
              <><CloudDownload className="w-5 h-5" /><span>Restore backup</span></>
            )}
          </button>
          {restoreResult && (
            <div className="bg-green-900/30 border border-green-800 rounded-lg p-3 text-green-400 text-sm">
              Restored {restoreResult.restored} of {restoreResult.total} report(s).
              {restoreResult.skipped > 0 && ` ${restoreResult.skipped} already present.`}
            </div>
          )}
          {error && (
            <div data-testid="restore-error" className="bg-red-900/30 border border-red-800 rounded-lg p-3 text-red-400 text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Backed-up report list */}
        <main className="flex-1 min-h-0 px-6 py-4 overflow-hidden flex flex-col">
          <h3 className="text-white font-medium mb-4">Backed-up reports ({entries.length})</h3>

          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 className="w-8 h-8 text-neutral-400 animate-spin mb-4" />
              <p className="text-neutral-500 text-sm">Loading…</p>
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <FileText className="w-12 h-12 text-neutral-700 mb-4" />
              <p className="text-neutral-500 text-sm">No backed-up reports for this terminal</p>
            </div>
          ) : (
            <div className="space-y-3 overflow-y-auto flex-1 pb-4">
              {entries.map((entry) => (
                <div
                  key={entry.date}
                  className="bg-neutral-900 border border-neutral-800 rounded-xl p-4"
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-neutral-400" />
                      <span className="text-white font-medium">{entry.date}</span>
                    </div>
                    {entry.metadata.finalized ? (
                      <span className="text-xs px-2 py-1 rounded bg-green-500/20 text-green-400 flex items-center gap-1">
                        <Lock className="w-3 h-3" />
                        Finalized
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-1 rounded bg-yellow-500/20 text-yellow-400">
                        Draft
                      </span>
                    )}
                  </div>
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Transactions</span>
                      <span className="text-neutral-300">{entry.metadata.entryCount}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-neutral-500 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        Saved
                      </span>
                      <span className="text-neutral-300">
                        {entry.metadata.publishedAt
                          ? new Date(entry.metadata.publishedAt * 1000).toLocaleString("en-US", {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "—"}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>

    </div>
  );
}
