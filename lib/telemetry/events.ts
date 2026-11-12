/**
 * Local diagnostics: errors, warnings, breadcrumbs and timed operations go to
 * the console, which lib/debug/log-capture.ts mirrors into the buffer that
 * Settings → Logs and Settings → Report a problem export. Nothing here talks
 * to the network — the terminal's only channel is the host.
 */

type Fields = Record<string, unknown>;

function line(kind: string, message: string, fields?: Fields): unknown[] {
  return fields && Object.keys(fields).length > 0 ? [`[${kind}] ${message}`, fields] : [`[${kind}] ${message}`];
}

/** A notable user action, kept in the log for context when something later fails. */
export function breadcrumb(category: string, message: string, data?: Fields): void {
  console.info(...line(`breadcrumb:${category}`, message, data));
}

/** An unexpected failure. */
export function captureError(error: unknown, tags?: Fields, extra?: Fields): void {
  console.error(...line("error", error instanceof Error ? `${error.name}: ${error.message}` : String(error), { ...tags, ...extra }));
}

/** Transient, non-fatal friction: a retry, a reconnect, a timeout that recovered. */
export function captureWarning(message: string, context?: Fields): void {
  console.warn(...line("warning", message, context));
}

/**
 * Run `fn` and log how long it took and whether it failed. Rethrows, so
 * callers handle errors as before.
 */
export function withSpan<T>(name: string, fn: () => T, attributes?: Fields): T {
  const startedAt = performance.now();
  const done = (outcome: string) =>
    console.info(...line("span", `${name} ${outcome} in ${Math.round(performance.now() - startedAt)}ms`, attributes));
  let result: T;
  try {
    result = fn();
  } catch (error) {
    done("failed");
    throw error;
  }
  if (result instanceof Promise) {
    return result.then(
      (value) => {
        done("ok");
        return value;
      },
      (error) => {
        done("failed");
        throw error;
      },
    ) as T;
  }
  done("ok");
  return result;
}

/**
 * Expected = user mistake or external constraint (not a bug). Callers use it
 * to log these as warnings rather than errors.
 */
const EXPECTED_ERROR_RE =
  /insufficient funds|cancel(?:led|ed)? by user|user cancel|declined|offline|no (?:internet|connection|network)|not bound|no admin config|unbound|finalization_timeout|timed? ?out/i;

export function isExpectedError(reason: string | undefined | null): boolean {
  if (!reason) return false;
  return EXPECTED_ERROR_RE.test(reason);
}
