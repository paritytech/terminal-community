"use client";

/**
 * Local terminal identity (Settings → Details).
 *
 * With the back-office binding retired, the terminal names itself: a
 * merchant-editable display name plus a stable generated Terminal ID. The ID
 * is minted once per device (first read) and then never changes — it tags
 * receipts and payment deeplinks the way the admin-QR terminalId used to.
 */

import { useEffect, useState } from "react";
import { getSetting, setSetting } from "@/lib/storage";
import { onStorageChange } from "@/lib/storage/host-storage";

export const TERMINAL_NAME_KEY = "terminal/name";
export const TERMINAL_ID_KEY = "terminal/id";

// No lookalike characters (0/O, 1/I/L) — the ID is read aloud and typed.
const ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const ID_LENGTH = 4;

function generateTerminalId(): string {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}

/** The device's stable terminal id, minting it on first use. */
export async function getOrCreateTerminalId(): Promise<string> {
  const existing = await getSetting(TERMINAL_ID_KEY);
  if (existing) return existing;
  const id = generateTerminalId();
  await setSetting(TERMINAL_ID_KEY, id);
  return id;
}

export async function setTerminalName(name: string): Promise<void> {
  await setSetting(TERMINAL_NAME_KEY, name.trim());
}

/** Live view of the terminal identity; mints the ID on first mount. */
export function useTerminalIdentity() {
  const [name, setName] = useState("");
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const [storedName, id] = await Promise.all([
          getSetting(TERMINAL_NAME_KEY),
          getOrCreateTerminalId(),
        ]);
        if (!mounted) return;
        setName(storedName ?? "");
        setTerminalId(id);
      } catch (err) {
        // The storage banner says why; a recovery reloads this.
        console.warn("[Terminal] identity unavailable:", err);
      } finally {
        if (mounted) setIsLoading(false);
      }
    };
    void load();
    const unsubscribe = onStorageChange("settings", () => void load());
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return { name, terminalId, isLoading };
}
