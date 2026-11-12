/**
 * In-app log capture for on-device debugging.
 *
 * Phones in the host webview have no dev console, so we mirror every
 * `console.*` call (plus uncaught errors and unhandled promise rejections)
 * into a bounded in-memory ring buffer. Settings → Debug logs can then share,
 * copy, or download the buffer as a text file.
 *
 * The capture is install-once and sits *beneath* any other console wrappers
 * (e.g. the Next.js Set-warning filter in instrumentation-client.ts): we wrap
 * the native methods first, callers wrap on top of us, and every call still
 * reaches the buffer before hitting the real console.
 */

import { saveTextFile } from "@/lib/utils/save-file";
import { scrubText } from "@/lib/telemetry/scrub";

export type LogLevel = "log" | "info" | "warn" | "error" | "debug" | "event";

export interface LogEntry {
  /** Epoch millis when the line was captured. */
  t: number;
  level: LogLevel;
  text: string;
}

// Bounded so a long-running session can't grow memory without limit. Oldest
// entries are dropped first (ring buffer).
const MAX_ENTRIES = 2000;
const MAX_TEXT_LEN = 4000;

const buffer: LogEntry[] = [];
const INSTALL_FLAG = "__t3rminalLogCapture" as const;

function push(level: LogLevel, text: string): void {
  buffer.push({ t: Date.now(), level, text: text.slice(0, MAX_TEXT_LEN) });
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
}

/** Best-effort serialization of a single console argument. */
function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ""}`;
  }
  if (arg === undefined) return "undefined";
  if (arg === null) return "null";
  if (typeof arg === "object") {
    try {
      const seen = new WeakSet();
      return JSON.stringify(
        arg,
        (_k, v) => {
          if (typeof v === "bigint") return `${v}n`;
          if (typeof v === "object" && v !== null) {
            if (seen.has(v)) return "[Circular]";
            seen.add(v);
          }
          return v;
        },
        2,
      );
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

function serializeArgs(args: unknown[]): string {
  return args.map(stringifyArg).join(" ");
}

/**
 * Install the capture once. Safe to call repeatedly and on the server (no-op
 * when there's no `window`).
 */
export function installLogCapture(): void {
  if (typeof window === "undefined") return;
  const w = window as typeof window & { [INSTALL_FLAG]?: true };
  if (w[INSTALL_FLAG]) return;
  w[INSTALL_FLAG] = true;

  const levels: LogLevel[] = ["log", "info", "warn", "error", "debug"];
  for (const level of levels) {
    const method = level as "log" | "info" | "warn" | "error" | "debug";
    const upstream = window.console[method].bind(window.console);
    window.console[method] = (...args: unknown[]) => {
      try {
        push(level, serializeArgs(args));
      } catch {
        // Never let capture break logging.
      }
      return upstream(...args);
    };
  }

  window.addEventListener("error", (e) => {
    const msg = e.error instanceof Error
      ? stringifyArg(e.error)
      : `${e.message} (${e.filename}:${e.lineno}:${e.colno})`;
    push("error", `[window.onerror] ${msg}`);
  });

  window.addEventListener("unhandledrejection", (e) => {
    push("error", `[unhandledrejection] ${stringifyArg(e.reason)}`);
  });
}

export function getCapturedLogs(): readonly LogEntry[] {
  return buffer;
}

export function clearCapturedLogs(): void {
  buffer.length = 0;
}

/** Render the buffer (with a small diagnostic header) as plain text. */
export function formatLogsAsText(): string {
  const header = [
    `T3RMINAL logs`,
    `exported: ${new Date().toISOString()}`,
    `entries:  ${buffer.length}`,
    typeof navigator !== "undefined" ? `ua:       ${navigator.userAgent}` : "",
    process.env.NEXT_PUBLIC_COMMIT_SHA ? `commit:   ${process.env.NEXT_PUBLIC_COMMIT_SHA}` : "",
    process.env.NEXT_PUBLIC_NETWORK ? `network:  ${process.env.NEXT_PUBLIC_NETWORK}` : "",
    "─".repeat(40),
  ]
    .filter(Boolean)
    .join("\n");

  const lines = buffer
    .map((e) => `${new Date(e.t).toISOString()} ${e.level.toUpperCase().padEnd(5)} ${e.text}`)
    .join("\n");

  return scrubText(`${header}\n${lines}\n`);
}

async function downloadText(text: string, filename: string): Promise<void> {
  await saveTextFile(filename, text, "text/plain");
}

function logsFilename(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `t3rminal-logs-${stamp}.txt`;
}

/** Download the captured logs as a .txt file. */
export async function downloadLogsTxt(): Promise<void> {
  await downloadText(formatLogsAsText(), logsFilename());
}

export type ShareLogsResult = "shared" | "copied" | "downloaded" | "cancelled";

/**
 * Export the captured logs, preferring the most useful channel available:
 * Web Share (file attachment, best inside the mobile host) → clipboard →
 * file download. Returns which channel was used so the UI can confirm.
 */
export async function shareLogs(): Promise<ShareLogsResult> {
  const text = formatLogsAsText();
  const filename = logsFilename();

  // 1. Web Share API — file attachment when supported, else plain text.
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      const file = typeof File !== "undefined"
        ? new File([text], filename, { type: "text/plain" })
        : null;
      if (file && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: "T3RMINAL logs" });
      } else {
        await navigator.share({ title: "T3RMINAL logs", text });
      }
      return "shared";
    } catch (err) {
      // User dismissed the share sheet — don't fall through to a download.
      if (err instanceof Error && err.name === "AbortError") return "cancelled";
      // Any other failure: fall through to the next channel.
    }
  }

  // 2. Clipboard.
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return "copied";
    }
  } catch {
    // fall through to download
  }

  // 3. File download.
  await downloadText(text, filename);
  return "downloaded";
}
