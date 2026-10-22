/**
 * One inline script, injected in `<head>` before any bundle module runs, that
 * decides which of the terminal's two host clients is allowed to own the
 * connection.
 *
 * The problem it solves. The Polkadot hosts publish a single
 * `window.__HOST_API_PORT__`, and whichever client evaluates first claims
 * `port.onmessage`. The terminal carries two, because the wire has two
 * incompatible envelopes with no negotiation between them (see
 * lib/host/sdk.ts):
 *
 *   codec 1  `@novasamatech/host-api-wrapper` — the native container.
 *   codec 2  `@parity/product-sdk-host` over the TrUAPI Rust core.
 *
 * The codec-1 wrapper builds its transport at *import* time, and a dozen
 * modules across the app import it at module scope. On a TrUAPI launch any one
 * of them would claim the port, and the codec-2 client would then wait for
 * replies the wrong listener already swallowed — a host that looks dead for no
 * visible reason.
 *
 * The fix, and why it is shaped like this. The two clients disagree about what
 * proves a webview:
 *
 *   wrapper  `isIframe() || __HOST_WEBVIEW_MARK__ === true`
 *   truapi   `isIframe() || __HOST_WEBVIEW_MARK__ === true || __HOST_API_PORT__ != null`
 *
 * So on a TrUAPI launch we hand the mark to nobody and leave the port in
 * place: the wrapper's `isCorrectEnvironment()` goes false and it registers no
 * listeners at all, while the codec-2 client still recognises the environment
 * through the port. The mark is stashed on `__T3R_HOST_WEBVIEW_MARK__` so
 * nothing is lost and the decision stays auditable from the console.
 *
 * **The bootstrap can land late.** Android registers it with
 * `addDocumentStartJavaScript` only once the TrUAPI execution is open, so on a
 * cold start it can arrive *after* this script has already run — observed on
 * device 2026-09-29, where the page then picked codec 1 and died on the
 * codec-1 handshake timeout. Checking once is therefore not enough: this
 * script also listens for the bootstrap's own `truapi-native-ready` event and
 * for the globals appearing, and strips the mark whenever that happens. The
 * matching wait on the reading side is `awaitHostRuntime()` in ./detect.ts.
 *
 * This is a seam, not the destination. The clean version is for every module
 * to import its client lazily behind `getAccountsPort()`, at which point this
 * script does nothing and can go. It is here because the guard has to be in
 * effect before the first `import`, and only an inline script is.
 */

export const HOST_RUNTIME_INIT_SCRIPT = [
  "(function(){",
  "var w=window;",
  // Park the mark where our own detection can still read it, and take it away
  // from the codec-1 wrapper's only test.
  "function hide(){",
  "if(w.__T3R_HOST_WEBVIEW_MARK__===undefined){w.__T3R_HOST_WEBVIEW_MARK__=w.__HOST_WEBVIEW_MARK__;}",
  "try{delete w.__HOST_WEBVIEW_MARK__}catch(e){try{w.__HOST_WEBVIEW_MARK__=undefined}catch(e2){}}",
  "w.__T3R_HOST_RUNTIME__='truapi';",
  "}",
  "try{",
  // Newer cores hand the product a ready-made client here and let their
  // lockdown container consume `__truapi_localhost`, so this is the signal
  // that survives; the older marker is kept for cores that predate it.
  "if(w.__HOST_API_CLIENT__!=null||w.__truapi_localhost!=null){hide();return;}",
  // The native container announces itself by installing its reply callback.
  // When that is already there the runtime is settled and nothing is pending.
  "if(typeof w.__container_callback__==='function'){w.__T3R_HOST_RUNTIME__='native';return;}",
  // Neither has landed yet: watch for the bootstrap instead of guessing.
  "w.addEventListener('truapi-native-ready',hide);",
  "var n=0,t=setInterval(function(){",
  "if(w.__HOST_API_CLIENT__!=null||w.__truapi_localhost!=null){clearInterval(t);hide();return;}",
  "if(typeof w.__container_callback__==='function'){clearInterval(t);w.__T3R_HOST_RUNTIME__='native';return;}",
  // ~3s at 50ms. Past that, whatever is there is what we get.
  "if(++n>60){clearInterval(t);w.__T3R_HOST_RUNTIME__=w.__T3R_HOST_RUNTIME__||'native';}",
  "},50);",
  "}catch(e){}",
  "})()",
].join("");
