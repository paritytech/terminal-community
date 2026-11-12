/**
 * Host connection status — what the auto-connect flow found out, so screens
 * can say *why* the terminal has no merchant account instead of showing
 * "Connecting to host…" forever.
 *
 * Pure data + copy; no React, no SDK imports. Written by `HostAutoConnect`
 * (lib/web3/components/providers/web3-provider.tsx), read through the web3
 * store (`useWeb3Store().hostConnection`) and rendered by
 * components/host-connection-status.tsx.
 */

export type HostConnectionFailure =
  /** Not inside a Polkadot host container (plain browser tab). */
  | "not-in-host"
  /** Inside a host, but the SDK transport refused the environment. */
  | "environment"
  /** Host answered but returned no product or legacy account. */
  | "no-accounts"
  /** Anything thrown along the way; `detail` carries the message. */
  | "error"

export type HostConnectionState =
  | { status: "idle" | "connecting" | "connected" }
  | { status: "failed"; reason: HostConnectionFailure; detail?: string }

export interface HostConnectionFailureCopy {
  title: string
  body: string
  /** What the person in front of the device can do about it. */
  hint?: string
}

export function describeHostConnectionFailure(
  reason: HostConnectionFailure,
  detail?: string,
): HostConnectionFailureCopy {
  switch (reason) {
    case "not-in-host":
      return {
        title: "Not inside the Polkadot app",
        body: "Open the terminal from the Polkadot app to connect a merchant account.",
      }
    case "environment":
      return {
        title: "Host bridge not available",
        body: "The app did not expose its product bridge. Restart the Polkadot app and open the terminal again.",
      }
    case "no-accounts":
      return {
        title: "No merchant account",
        body: "The host returned no account for this terminal. Finish setting up your identity in the Polkadot app, then retry.",
      }
    case "error":
      return {
        title: "Could not connect to host",
        body: detail?.trim() || "Unexpected error while connecting to the host.",
      }
  }
}
