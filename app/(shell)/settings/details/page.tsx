"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { SubpageHeader, iconButtonClass } from "@/components/subpage-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setTerminalName, useTerminalIdentity } from "@/lib/config/terminal";

/**
 * Settings → Details: this terminal's identity. The name is merchant-chosen;
 * the Terminal ID is minted once per device and read-only — it tags receipts
 * and payment deeplinks. This page is where the ID is shown on purpose (with
 * a copy control), so it is the sanctioned place for the raw value.
 */
export default function DetailsSettingsPage() {
  const { name, terminalId, isLoading } = useTerminalIdentity();
  const [draftName, setDraftName] = useState("");
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isLoading) setDraftName(name);
    // Only seed the draft once the stored name arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  const handleSave = async () => {
    await setTerminalName(draftName);
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  const handleCopy = async () => {
    if (!terminalId) return;
    try {
      await navigator.clipboard.writeText(terminalId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the ID is short enough to retype */
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 min-h-0 flex flex-col max-w-md mx-auto w-full">
        <SubpageHeader title="Details" backHref="/settings" backLabel="Back to settings" />

        <main className="flex-1 min-h-0 overflow-y-auto flex flex-col px-6 pb-6">
          {/* Terminal name */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="terminal-name" className="text-label-m text-fg-secondary">
              Terminal name
            </Label>
            <Input
              id="terminal-name"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              maxLength={48}
              placeholder="e.g. Front counter"
              className="h-12"
            />
            <p className="text-caption text-fg-tertiary">A label for this device.</p>
          </div>

          {/* Terminal ID — read-only, on a container surface (not a control,
              so no hairline) */}
          <div className="mt-5 rounded-nested bg-surface-container px-4 py-3 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-caption text-fg-tertiary mb-0.5">Terminal ID</p>
              <p className="text-body-l font-mono text-fg-primary">{terminalId ?? "…"}</p>
            </div>
            <button
              type="button"
              onClick={handleCopy}
              aria-label="Copy terminal ID"
              className={`${iconButtonClass} shrink-0 text-fg-secondary`}
            >
              {copied ? <Check className="size-5 text-fg-success" /> : <Copy className="size-5" />}
            </button>
          </div>
          <p className="text-caption text-fg-tertiary mt-2">
            Generated once for this device. Shown on receipts and attached to
            payments.
          </p>

          <div className="flex-1" />
          {/* The screen's one action, in the bottom slot */}
          <Button
            type="button"
            onClick={handleSave}
            disabled={isLoading || draftName.trim() === name.trim()}
            className="mt-8 w-full h-auto rounded-full px-6 py-3.5 text-label-l font-semibold disabled:bg-action-disabled disabled:text-fg-disabled disabled:opacity-100"
          >
            {saved ? (
              <>
                <Check className="size-5" aria-hidden /> Saved
              </>
            ) : (
              "Save"
            )}
          </Button>
        </main>
      </div>
    </div>
  );
}
