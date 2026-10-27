/**
 * What the Pocket worker does, apart from the SDK calls that wire it up
 * (pocket/worker.ts), so it can run against a fake host in the tests.
 *
 * Built around the worker lifecycle, as pocket-reciept's worker is:
 *   - the worker runs only while the card's face is on screen. There is no
 *     background tick, and nothing here assumes the worker stays warm.
 *   - the host stores every face it is sent, so a face goes out only when what
 *     it shows changed.
 *   - the snapshot changes when the app writes it. Hosts that serve
 *     `localStorage.subscribe` push that; elsewhere a short poll picks it up.
 *     The poll also moves the card across midnight and into a new week.
 *
 * ASCII only: bundled into the Pocket worker.
 */

import { CARD_ID, faceFor, type MerchantSnapshot } from "./merchant-card";
import type { RendererNode } from "./nodes";

/** How often a card on screen re-reads the snapshot: one small local key. */
export const POLL_MS = 5_000;

type Cleanup = (() => void) | void;

export interface MerchantCardDeps {
  /** `getPocketManager().drawCard`, or a fake. */
  drawCard(cardId: string, draw: (send: (face: RendererNode) => void) => Cleanup | Promise<Cleanup>): unknown;
  readSnapshot(): Promise<MerchantSnapshot | null>;
  /** Calls `onChange` on every write to the snapshot; resolves to how to stop, or null where the host cannot push. */
  watchSnapshot?(onChange: () => void): Promise<(() => void) | null>;
  /** Records that the card was drawn, for the app to see that it is in Pocket. */
  markSeen?(): Promise<void>;
  now?(): Date;
  pollMs?: number;
  log?: Pick<Console, "info" | "warn">;
}

export function registerMerchantCard(deps: MerchantCardDeps): void {
  const log = deps.log ?? console;
  const now = deps.now ?? (() => new Date());

  deps.drawCard(CARD_ID, async (send) => {
    deps.markSeen?.().catch((error: unknown) => log.warn("[pocket] could not mark the card seen", error));

    let shown = "";
    // One read at a time, so a poll and a pushed change cannot send the same face twice.
    let queue = Promise.resolve();
    const repaint = () => {
      queue = queue
        .then(async () => {
          const face = faceFor(await deps.readSnapshot(), now());
          const key = JSON.stringify(face);
          if (key === shown) return;
          shown = key;
          send(face);
        })
        .catch((error: unknown) => log.warn("[pocket] snapshot read failed", error));
      return queue;
    };

    await repaint();
    const poll = setInterval(repaint, deps.pollMs ?? POLL_MS);
    const stopWatching = deps.watchSnapshot ? await deps.watchSnapshot(repaint).catch(() => null) : null;

    // The host calls this when the card leaves the screen.
    return () => {
      clearInterval(poll);
      stopWatching?.();
    };
  });
  log.info("[pocket] merchant card renderer registered");
}
