"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Shield,
  Key,
  Eye,
  EyeOff,
  Save,
  Trash2,
  Check,
} from "lucide-react";
import {
  setManualPassphrase,
  getManualPassphrase,
  clearManualPassphrase,
  manualKeyFingerprint,
} from "@/lib/crypto/manual-key";
import { journeyTracker, breadcrumb } from "@/lib/telemetry";

const UNDO_WINDOW_MS = 10_000;

export default function EncryptionSettingsPage() {
  const [passphrase, setPassphrase] = useState("");
  const [show, setShow] = useState(false);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Clear acts at once and offers Undo for a while, rather than asking first:
  // the product runs in a sandboxed host frame where window.confirm() is
  // ignored (it returns false), and the design system prefers act-then-undo.
  const [cleared, setCleared] = useState<string | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
  }, []);

  const refresh = useCallback(() => {
    setPassphrase(getManualPassphrase() ?? "");
    setFingerprint(manualKeyFingerprint());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSave = () => {
    setError(null);
    journeyTracker.start("encryption-key-set");
    try {
      setManualPassphrase(passphrase);
      refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      journeyTracker.complete("encryption-key-set");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save key";
      setError(msg);
      journeyTracker.fail("encryption-key-set", msg);
    }
  };

  const handleClear = () => {
    const previous = getManualPassphrase();
    breadcrumb("settings", "Encryption key cleared by merchant");
    clearManualPassphrase();
    refresh();
    if (!previous) return;
    setCleared(previous);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setCleared(null), UNDO_WINDOW_MS);
  };

  const handleUndo = () => {
    if (!cleared) return;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setManualPassphrase(cleared);
    setCleared(null);
    refresh();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 min-h-0 flex flex-col max-w-md mx-auto w-full">
        {/* Header */}
        <header className="flex items-center justify-between px-4 py-4">
          <Link href="/settings" className="p-2">
            <ArrowLeft className="w-6 h-6 text-white" />
          </Link>
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-white" />
            <span className="text-white font-medium">Report Encryption</span>
          </div>
          <div className="w-10" />
        </header>

        <main className="flex-1 min-h-0 px-6 py-4 space-y-6 overflow-auto">
          {/* Explainer */}
          <section className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 text-sm text-neutral-300 space-y-2">
            <p className="text-white font-medium">How it works</p>
            <p>
              Pick a secret phrase. We use it to encrypt your daily reports before they leave this device, and to decrypt them when you open them again.
            </p>
            <p>
              Use the <span className="text-white">same phrase</span> on every device that needs to read the reports. If you change or lose it, older reports can no longer be opened.
            </p>
          </section>

          {/* Current key fingerprint */}
          <section className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Key className="w-4 h-4 text-neutral-400" />
              <span className="text-neutral-400 text-sm">Active key</span>
            </div>
            {fingerprint ? (
              <div className="flex items-center justify-between">
                <span className="text-white font-mono text-lg tracking-wider">{fingerprint}</span>
                <span className="text-xs text-green-400">Set</span>
              </div>
            ) : (
              <span className="text-neutral-500 text-sm">No key set — reports will upload as plaintext</span>
            )}
            {cleared && (
              <div
                data-testid="encryption-key-cleared"
                className="mt-3 flex items-center justify-between gap-3 text-sm"
              >
                <span className="text-neutral-300">
                  Key removed from this device. Reports already on the chain can&apos;t be opened until the same key is set again.
                </span>
                <button onClick={handleUndo} className="shrink-0 text-white font-medium underline">
                  Undo
                </button>
              </div>
            )}
          </section>

          {/* Set / update form */}
          <section className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 space-y-3">
            <label className="text-white font-medium text-sm">Set encryption key</label>
            <div className="relative">
              <input
                type={show ? "text" : "password"}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Enter a secret phrase"
                className="w-full bg-neutral-800 text-white placeholder-neutral-500 rounded-xl py-3 pl-4 pr-12 outline-none focus:ring-2 focus:ring-neutral-600"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-white p-1"
                aria-label={show ? "Hide" : "Show"}
              >
                {show ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
              </button>
            </div>

            {error && (
              <div className="bg-red-900/30 border border-red-800 rounded-lg p-2 text-red-400 text-xs">
                {error}
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={handleSave}
                disabled={!passphrase.trim()}
                className="flex-1 bg-white text-black font-medium py-3 rounded-xl flex items-center justify-center gap-2 disabled:opacity-40"
              >
                {saved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                <span>{saved ? "Saved" : "Save"}</span>
              </button>
              {fingerprint && (
                <button
                  onClick={handleClear}
                  className="bg-neutral-800 hover:bg-neutral-700 text-red-400 font-medium py-3 px-4 rounded-xl flex items-center justify-center gap-2"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>Clear</span>
                </button>
              )}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
