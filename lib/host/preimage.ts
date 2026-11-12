"use client";

/**
 * Bulletin preimages through the host: `submit` stores bytes on Paseo
 * Bulletin (the host signs and submits `TransactionStorage.store`), `lookup`
 * reads them back from the host's own Bulletin node. Both clients expose the
 * same pair; this module picks the one this launch is on and loads it lazily.
 */

import { isTruApiRuntime } from "./detect";
import { loadHostSdk } from "./sdk";
import { deferredSubscription, type HostSub } from "./subscription";

/** Submit `data` as a preimage. Resolves with the host's key (the Blake2b-256 hash). */
export async function submitPreimage(data: Uint8Array): Promise<string> {
  if (isTruApiRuntime()) {
    const manager = await (await loadHostSdk()).getPreimageManager();
    if (!manager) throw new Error("preimage submit unavailable: no host client");
    return manager.submit(data);
  }
  const { preimageManager } = await import("@novasamatech/host-api-wrapper");
  return preimageManager.submit(data);
}

/**
 * Follow the preimage stored under `key`. `onPreimage` receives the bytes, or
 * `null` while the host does not have them.
 */
export function lookupPreimage(key: `0x${string}`, onPreimage: (bytes: Uint8Array | null) => void): HostSub {
  return deferredSubscription(async () => {
    if (isTruApiRuntime()) {
      const manager = await (await loadHostSdk()).getPreimageManager();
      if (!manager) throw new Error("preimage lookup unavailable: no host client");
      return manager.lookup(key, onPreimage);
    }
    const { preimageManager } = await import("@novasamatech/host-api-wrapper");
    return preimageManager.lookup(key, onPreimage);
  });
}
