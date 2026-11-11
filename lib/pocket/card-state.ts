"use client";

/**
 * What the app asks the host about the merchant Pocket card: whether it is in
 * Pocket, and to offer adding it.
 *
 * A product cannot add a card itself. The host owns the Pocket, and adding a
 * card is the user's consent on the host's own sheet, which the product can
 * only ask for, through the host's link (Pocket Modality RFC,
 * trinity-user-agents #1542):
 *
 *   polkadotapp://pocket/add?product=<id>&card=<card>
 *
 * `navigateTo` lets a Pocket link through without the OpenUrl grant other
 * polkadotapp:// links need. Mirrors paritytech/pocket-reciept `app/src/host.ts`.
 */

import { loadHostSdk } from "@/lib/host/sdk";
import { readValue } from "@/lib/storage/host-storage";
import { CARD_ID, SEEN_KEY } from "./merchant-card";

export type CardState = "in-pocket" | "missing" | "unknown";

/** The host's add-card sheet for one of this product's cards. */
export const pocketAddLink = (productId: string, cardId = CARD_ID) =>
  `polkadotapp://pocket/add?product=${encodeURIComponent(productId)}&card=${encodeURIComponent(cardId)}`;

/**
 * Whether the merchant card is in Pocket, as the host reports it.
 *
 * `subscribeCards` is the host's own list. Where it is not served, the
 * worker's seen mark is the evidence: the worker only draws a card that is in
 * Pocket. Neither proves the card is missing, so that reads "unknown".
 */
export function watchMerchantCard(onState: (state: CardState) => void): () => void {
  let stop = () => {};
  let closed = false;

  const fromSeenMark = async () => {
    const seen = await readValue<number | string>(SEEN_KEY).catch(() => null);
    if (!closed) onState(seen ? "in-pocket" : "unknown");
  };

  void (async () => {
    try {
      const pocket = await (await loadHostSdk()).getPocketManager();
      if (!pocket || closed) return fromSeenMark();
      const subscription = pocket.subscribeCards((cards) => {
        if (!closed) onState(cards.some((card) => card.cardId === CARD_ID) ? "in-pocket" : "missing");
      });
      subscription.onInterrupt(() => void fromSeenMark());
      stop = () => subscription.unsubscribe();
    } catch (error) {
      console.info("[pocket] the host cannot list pocket cards", error);
      await fromSeenMark();
    }
  })();

  return () => {
    closed = true;
    stop();
  };
}

/** This build's DotNS name as the host knows it, e.g. `terminal.paseo`. */
async function productId(): Promise<string | null> {
  const truApi = await (await loadHostSdk()).getTruApi();
  if (!truApi) return null;
  return truApi.system.getProductContext().match(
    (context) => context.productId,
    () => null,
  );
}

/**
 * Asks the host to open its add-card sheet. Returns the link for the caller
 * to show when the host did not take it (an older host).
 */
export async function requestAddMerchantCard(): Promise<{ opened: boolean; link: string | null }> {
  const id = await productId().catch(() => null);
  if (!id) return { opened: false, link: null };
  const link = pocketAddLink(id);
  try {
    const result = await (await loadHostSdk()).navigateTo(link);
    if (result.ok) return { opened: true, link };
    console.info(`[pocket] navigateTo ${link} refused:`, JSON.stringify(result.error));
  } catch (error) {
    console.warn(`[pocket] navigateTo ${link} threw`, error);
  }
  return { opened: false, link };
}
