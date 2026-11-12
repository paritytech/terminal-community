/**
 * Host environment detection.
 *
 * The check is deliberately local: it must not load either host client, since
 * its answer is what decides which one loads.
 *
 * The signals are the three every Polkadot host publishes, and the same three
 * the SDK tested: an iframe parent, the webview mark, or the injected port.
 *
 * The `HostEnvironment` split (desktop-webview vs web-iframe vs standalone)
 * is ours; the hosts expose only the raw signals.
 */

type HostGlobals = {
  __HOST_WEBVIEW_MARK__?: boolean
  __HOST_API_PORT__?: unknown
  __truapi_localhost?: unknown
  /** Newer cores build the TrUAPI client in the page and hand it over here. */
  __HOST_API_CLIENT__?: { client?: unknown } | null
  /** The native container installs this when it loads. */
  __container_callback__?: unknown
}

function webviewMark(win: HostGlobals): boolean {
  return win.__HOST_WEBVIEW_MARK__ === true
}

function hostGlobals(): HostGlobals | null {
  return typeof window === "undefined" ? null : (window as HostGlobals)
}

function isIframe(): boolean {
  try {
    return typeof window !== "undefined" && window !== window.top
  } catch {
    // A cross-origin parent throws on access, which is itself the answer.
    return true
  }
}

export type HostEnvironment = "desktop-webview" | "web-iframe" | "standalone"

export function detectHostEnvironment(): HostEnvironment {
  if (!isInHost()) return "standalone"
  const win = hostGlobals()
  return win && webviewMark(win) ? "desktop-webview" : "web-iframe"
}

export function isInHost(): boolean {
  const win = hostGlobals()
  if (!win) return false
  return isIframe() || webviewMark(win) || win.__HOST_API_PORT__ != null
}

/**
 * True when the TrUAPI (Rust) product runtime has already identified itself.
 * That bootstrap mimics the native container's globals
 * (`__HOST_WEBVIEW_MARK__`, `__HOST_API_PORT__`), so every other detector says
 * "in host" — only these two markers tell the runtimes apart. A synchronous
 * sample: on Android the bootstrap can land after the page's own scripts, so
 * code that picks a host client awaits `onTruApi()` instead.
 */
export function isTruApiRuntime(): boolean {
  const win = hostGlobals()
  if (!win) return false
  // `__HOST_API_CLIENT__` first: the lockdown container consumes
  // `__truapi_localhost`, so on newer cores that one reads as `undefined`
  // even though the runtime is very much TrUAPI.
  return win.__HOST_API_CLIENT__ != null || win.__truapi_localhost != null
}

export type HostRuntime = "truapi" | "native"

let runtimePromise: Promise<HostRuntime> | null = null

/**
 * Which runtime this launch is on, once that is actually known.
 *
 * `isTruApiRuntime()` reads a global, and on Android that global can arrive
 * late: the bootstrap is registered only after the TrUAPI execution opens, so
 * on a cold start it can land after the page's own scripts. A launch that
 * asked too early answered "native", connected with the codec-1 client, and
 * died ten seconds later on a handshake the Rust core never answers — which is
 * exactly what the device showed on 2026-09-29.
 *
 * So the connection waits for the answer instead of sampling it. It resolves
 * the moment either runtime identifies itself, and falls back to the native
 * container if neither does — that is the one that works on every host that
 * predates TrUAPI.
 *
 * Decided once and shared: every module that picks a host client asks this,
 * so they all pick the same one.
 */
export function awaitHostRuntime(): Promise<HostRuntime> {
  runtimePromise ??= detectHostRuntime(3000)
  return runtimePromise
}

/** True when this launch is inside a host that speaks TrUAPI. */
export async function onTruApi(): Promise<boolean> {
  return isInHost() && (await awaitHostRuntime()) === "truapi"
}

/** For tests: forget the decided runtime. */
export function resetHostRuntime(): void {
  runtimePromise = null
}

async function detectHostRuntime(timeoutMs: number): Promise<HostRuntime> {
  const win = hostGlobals()
  if (!win) return "native"

  const settled = (): HostRuntime | null => {
    if (win.__HOST_API_CLIENT__ != null || win.__truapi_localhost != null) return "truapi"
    if (typeof win.__container_callback__ === "function") return "native"
    return null
  }

  const now = settled()
  if (now) return now
  // In an iframe the parent cannot publish anything into this window, so no
  // marker is coming: the frame host speaks codec 1 (Desktop, dot.li, the e2e
  // test host). Waiting would only delay every host call by the timeout.
  if (isIframe()) return "native"

  return new Promise((resolve) => {
    const finish = (value: HostRuntime) => {
      clearInterval(timer)
      clearTimeout(deadline)
      window.removeEventListener("truapi-native-ready", onReady)
      resolve(value)
    }
    const onReady = () => finish("truapi")
    window.addEventListener("truapi-native-ready", onReady)
    const timer = setInterval(() => {
      const value = settled()
      if (value) finish(value)
    }, 50)
    const deadline = setTimeout(() => finish("native"), timeoutMs)
  })
}
