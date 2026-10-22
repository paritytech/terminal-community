/**
 * Host environment detection.
 *
 * The check is deliberately local rather than delegated to
 * `@parity/product-sdk/host`: that package carries its own copy of
 * `@parity/truapi`, and a second copy of the transport is not inert — the
 * first thing either client does on a webview is claim
 * `window.__HOST_API_PORT__.onmessage`, so two copies silently take each
 * other's replies. Dropping the import keeps exactly one transport in the
 * bundle, the one ./sdk.ts chooses.
 *
 * The signals are the three every Polkadot host publishes, and the same three
 * the SDK tested: an iframe parent, the webview mark, or the injected port.
 *
 * The `HostEnvironment` split (desktop-webview vs web-iframe vs standalone)
 * is ours; the hosts expose only the raw signals.
 */

type HostGlobals = {
  __HOST_WEBVIEW_MARK__?: boolean
  /** Where lib/host/runtime-init.ts parks the mark on a TrUAPI launch. */
  __T3R_HOST_WEBVIEW_MARK__?: boolean
  /** What that script concluded: "truapi" | "native", or absent while it waits. */
  __T3R_HOST_RUNTIME__?: "truapi" | "native"
  __HOST_API_PORT__?: unknown
  __truapi_localhost?: unknown
  /** Newer cores build the TrUAPI client in the page and hand it over here. */
  __HOST_API_CLIENT__?: { client?: unknown } | null
  /** The native container installs this when it loads. */
  __container_callback__?: unknown
}

/** The webview mark, wherever the boot guard left it. */
function webviewMark(win: HostGlobals): boolean {
  return win.__HOST_WEBVIEW_MARK__ === true || win.__T3R_HOST_WEBVIEW_MARK__ === true
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
 * True when the page was bootstrapped by the Polkadot app's TrUAPI (Rust)
 * product runtime. That bootstrap publishes the ws-bridge endpoint on
 * `window.__truapi_localhost` and mimics the native container's globals
 * (`__HOST_WEBVIEW_MARK__`, a WebSocket-backed `__HOST_API_PORT__`), so every
 * other detector says "in host" — but the core only speaks TrUAPI wire codec
 * 2, and the terminal's host-api 0.12 transport (codec 1) never gets a reply.
 * Checked before connecting so the merchant sees a reason instead of a spinner.
 */
export function isTruApiRuntime(): boolean {
  const win = hostGlobals()
  if (!win) return false
  // `__HOST_API_CLIENT__` first: the lockdown container consumes
  // `__truapi_localhost`, so on newer cores that one reads as `undefined`
  // even though the runtime is very much TrUAPI.
  return win.__HOST_API_CLIENT__ != null || win.__truapi_localhost != null
}

/**
 * True when the host sandbox refuses product-side WebSockets. The Polkadot
 * iOS app's native container replaces `window.WebSocket` with a Proxy whose
 * constructor throws `TypeError("Network access is not allowed")`; Android's
 * container leaves it alone. Probed with an invalid URL so no connection is
 * ever attempted: a real WebSocket rejects `ws://` with a SyntaxError before
 * touching the network, the blocking proxy throws its TypeError first.
 * Used to skip the direct-WS chain fallback where it can only fail.
 */
export function isProductWebSocketBlocked(): boolean {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") return false
  try {
    new WebSocket("ws://")
    return false
  } catch (error) {
    return error instanceof TypeError && /not allowed/i.test((error as Error).message)
  }
}

/** Async variant, kept for call sites that await detection during boot. */
export async function isInHostAsync(): Promise<boolean> {
  return isInHost()
}

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
 */
export async function awaitHostRuntime(timeoutMs = 3000): Promise<"truapi" | "native"> {
  const win = hostGlobals()
  if (!win) return "native"

  const settled = (): "truapi" | "native" | null => {
    if (win.__HOST_API_CLIENT__ != null || win.__truapi_localhost != null) return "truapi"
    if (typeof win.__container_callback__ === "function") return "native"
    return win.__T3R_HOST_RUNTIME__ ?? null
  }

  const now = settled()
  if (now) return now

  return new Promise((resolve) => {
    const finish = (value: "truapi" | "native") => {
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
