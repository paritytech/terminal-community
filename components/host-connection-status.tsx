"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useWeb3Store } from "@/lib/web3/store/use-web3-store";
import { describeHostConnectionFailure } from "@/lib/host/connection-status";

const SLOW_CONNECT_MS = 15_000;

interface HostConnectionHintProps {
  /** `caption` for the splash, `body` for the shell screens' "Welcome" state. */
  size?: "caption" | "body";
}

/**
 * What to show while the terminal has no merchant account yet. Reads the
 * auto-connect outcome from the web3 store: a quiet "Connecting to host…"
 * while it runs (with a nudge once it drags), and a titled failure card with
 * a Retry once it fails — the reason is the part the merchant or tester can
 * act on (see lib/host/connection-status.ts).
 */
export function HostConnectionHint({ size = "body" }: HostConnectionHintProps) {
  const hostConnection = useWeb3Store((state) => state.hostConnection);
  const [slow, setSlow] = useState(false);

  const connecting = hostConnection.status === "idle" || hostConnection.status === "connecting";

  // Arm the "taking longer than usual" nudge only while a connect is in
  // flight; the timer callback is the only place that flips it.
  useEffect(() => {
    if (!connecting) return;
    const timer = setTimeout(() => setSlow(true), SLOW_CONNECT_MS);
    return () => clearTimeout(timer);
  }, [connecting]);

  const textClass = size === "caption" ? "text-caption text-fg-tertiary" : "text-body-m text-fg-tertiary";

  if (hostConnection.status !== "failed") {
    return (
      <p className={textClass} data-testid="host-connection-pending">
        {connecting && slow
          ? "Still connecting to host… the app is taking longer than usual."
          : "Connecting to host…"}
      </p>
    );
  }

  const copy = describeHostConnectionFailure(hostConnection.reason, hostConnection.detail);

  return (
    <div
      className="w-full max-w-sm rounded-container bg-surface-container p-4 text-left space-y-2"
      data-testid="host-connection-failed"
      data-reason={hostConnection.reason}
      role="alert"
    >
      <p className="text-label-l text-fg-primary">{copy.title}</p>
      <p className="text-body-s text-fg-secondary">{copy.body}</p>
      {copy.hint && <p className="text-caption text-fg-tertiary">{copy.hint}</p>}
      <div className="pt-1">
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.location.reload()}
          data-testid="btn-retry-host-connection"
        >
          Retry
        </Button>
      </div>
    </div>
  );
}
