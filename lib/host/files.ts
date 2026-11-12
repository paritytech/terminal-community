"use client";

/**
 * Host file-save bridge — hands a generated file (receipt PDF, sales-report CSV,
 * SVG, log dump) to the native host, which writes it to the device Downloads
 * folder via MediaStore.
 *
 * Why this exists: inside the Polkadot host the terminal runs in an Android
 * WebView, which silently drops the usual `blob:` / `<a download>` download — so
 * nothing ever landed on the device. Routing the bytes through the host makes
 * downloads work in the WebView and inside kiosk Lock Task.
 *
 * Lives on the same frozen `window.host.ext` object as `printer` / `nfc`. `save`
 * only exists on hosts built with this bridge (this Sunmi/nightly+); on Desktop /
 * dot.li / older builds it is absent, so callers feature-detect and fall back to a
 * browser download. There is no isAvailable() — availability is whether the
 * binding exists.
 */

interface HostFiles {
  save(name: string, base64: string, mime: string): Promise<{ savedAs: string }>;
}

// `window.host.ext` is also declared by lib/host/printing.ts; re-declaring it here
// would clash, so reach for the bridge through a local cast (mirrors lib/host/nfc.ts).
function getHostFiles(): HostFiles | null {
  if (typeof window === "undefined") return null;
  const files = (window as unknown as {
    host?: { ext?: { files?: Partial<HostFiles> } };
  }).host?.ext?.files;
  // Feature-detect: save() only exists on hosts built with the file bridge.
  return typeof files?.save === "function" ? (files as HostFiles) : null;
}

/** Standard-base64-encode bytes without overflowing the call stack on large files. */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Save a file through the host. Returns true if the host handled it, false when no
 * host bridge is present (caller should fall back to a browser download). Rejects
 * only if the host accepted the call but failed to write.
 */
export async function saveFileViaHost(filename: string, blob: Blob): Promise<boolean> {
  const files = getHostFiles();
  if (!files) return false;
  const base64 = await blobToBase64(blob);
  await files.save(filename, base64, blob.type || "application/octet-stream");
  return true;
}
