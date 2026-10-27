"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { WalletCards } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isInHost, isTruApiRuntime } from "@/lib/host/detect";
import { requestAddMerchantCard, watchMerchantCard, type CardState } from "@/lib/pocket/card-state";

// The runtime is settled before Settings can be reached, so there is nothing to subscribe to.
const noSubscription = () => () => {};
const inPocketHost = () => isInHost() && isTruApiRuntime();

/**
 * Settings row for the merchant Pocket card: offers adding it until it is in
 * Pocket. Adding is the user's consent on the host's sheet, so the button only
 * asks the host to show it (lib/pocket/card-state.ts).
 *
 * Shown on the TrUAPI runtime only. Pocket cards are drawn by its core; the
 * native container has none to offer.
 */
export function PocketCardRow() {
  // The page is prerendered without the host's globals, so the server answer
  // is "no Pocket"; the client reads the runtime once it hydrates.
  const available = useSyncExternalStore(noSubscription, inPocketHost, () => false);
  const [card, setCard] = useState<CardState>("unknown");
  const [asking, setAsking] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);

  useEffect(() => (available ? watchMerchantCard(setCard) : undefined), [available]);

  if (!available) return null;

  const add = async () => {
    setAsking(true);
    setFallback(null);
    try {
      const { opened, link } = await requestAddMerchantCard();
      if (!opened) setFallback(link);
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="py-4 px-2 -mx-2">
      <div className="flex items-center gap-4">
        <WalletCards className="size-6 text-fg-primary shrink-0" aria-hidden />
        <span className="flex-1 min-w-0">
          <span className="block text-label-l text-fg-primary">Pocket card</span>
          <span className="block text-body-s text-fg-secondary mt-0.5">
            Today&apos;s and this week&apos;s sales, in your Pocket
          </span>
        </span>
        {card === "in-pocket" ? (
          <span className="text-body-m text-fg-secondary shrink-0">On your Pocket</span>
        ) : (
          <Button
            variant="secondary"
            className="text-label-m shrink-0 cursor-pointer"
            onClick={() => void add()}
            disabled={asking}
          >
            {asking ? "Opening…" : "Add to Pocket"}
          </Button>
        )}
      </div>
      {fallback ? (
        <p className="text-body-s text-fg-secondary mt-3">
          The Polkadot app didn&apos;t open the add sheet. Open this link on the phone to add the card:{" "}
          <span className="font-mono break-all text-fg-primary">{fallback}</span>
        </p>
      ) : null}
    </div>
  );
}
