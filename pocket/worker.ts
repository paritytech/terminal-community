/**
 * The terminal's Pocket worker: the host boots it headless to draw the
 * merchant card, and it never shares a document with the app.
 *
 * Built into `out-pocket/worker.js` by scripts/build-pocket-worker.mts and
 * published as the product's `worker` executable (bulletin-deploy.config.ts).
 * The card reads the snapshot the app keeps in product host storage
 * (lib/pocket/sync.tsx); everything it does with it is in
 * lib/pocket/worker-core.ts.
 *
 * Drawing goes through `getPocketManager()` rather than `renderer.onRender`:
 * the manager owns the client's single render slot, routes by card id, and
 * keeps a throw in the handler from ending the registration.
 *
 * ASCII only: the host reads worker JS as Latin-1.
 */

import { getHostLocalStorage, getPocketManager, getTruApi } from "@parity/product-sdk-host";
import { SEEN_KEY, SNAPSHOT_KEY, isSnapshot, type MerchantSnapshot } from "../lib/pocket/merchant-card";
import { registerMerchantCard } from "../lib/pocket/worker-core";

async function readSnapshot(): Promise<MerchantSnapshot | null> {
  const store = await getHostLocalStorage();
  if (!store) return null;
  try {
    const value = await store.readJSON(SNAPSHOT_KEY);
    return isSnapshot(value) ? value : null;
  } catch {
    // A key never written reads back empty, which is not JSON: no snapshot yet.
    return null;
  }
}

async function markSeen(): Promise<void> {
  const store = await getHostLocalStorage();
  await store?.writeString(SEEN_KEY, String(Date.now()));
}

/** Pushes on every write to the snapshot where the host serves `localStorage.subscribe`. */
async function watchSnapshot(onChange: () => void): Promise<(() => void) | null> {
  try {
    const truApi = await getTruApi();
    if (!truApi) return null;
    const subscription = truApi.localStorage.subscribe({ request: { key: SNAPSHOT_KEY } }).subscribe({
      next: () => onChange(),
      error: (error) => console.info("[pocket] storage change stream ended; polling only", error),
    });
    return () => subscription.unsubscribe();
  } catch (error) {
    console.info("[pocket] no storage change stream on this host; polling only", error);
    return null;
  }
}

async function start(): Promise<void> {
  const pocket = await getPocketManager();
  if (pocket == null) {
    // A host with no Pocket surface shows the static preview the card was added with.
    console.info("[pocket] no pocket surface on this host; the card stays static");
    return;
  }
  registerMerchantCard({
    drawCard: (cardId, draw) => pocket.drawCard(cardId, draw),
    readSnapshot,
    watchSnapshot,
    markSeen,
  });
}

start().catch((error: unknown) => console.error("[pocket] merchant card not registered", error));
