/**
 * Secret redaction for anything that leaves the device as text — the log
 * export behind Settings → Logs and Settings → Report a problem
 * (lib/debug/log-capture.ts). Any string registered via `registerSecret`
 * (e.g. the merchant's report password) is replaced with `[redacted]`
 * wherever it appears.
 */

const REDACTED = "[redacted]";

// Only register non-trivial secrets — redacting a 2-char string would corrupt
// unrelated text. Module-level; the admin payload registers the report
// password when it loads.
const secrets = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (typeof value === "string" && value.length >= 8) secrets.add(value);
}

/** Test-only: reset the registry between cases. */
export function _clearSecretsForTest(): void {
  secrets.clear();
}

/** `text` with every registered secret replaced by `[redacted]`. */
export function scrubText(text: string): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}
