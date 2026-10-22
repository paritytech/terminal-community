"use client"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState, useEffect } from "react"
import { useWeb3Store } from "@/lib/web3/store/use-web3-store"
import { awaitHostRuntime, isInHost } from "@/lib/host/detect"
import { connectToHost } from "@/lib/host/connection"
import { getHostAccounts, subscribeHostAccounts } from "@/lib/host/accounts"
import type { HostConnectionState } from "@/lib/host/connection-status"
import { WalletProviderType, WalletProviderStatus } from "@/lib/web3/types/web3"

/**
 * Auto-connects to host wallet when running inside Polkadot Desktop / dot.li /
 * the Polkadot phone app. T3rminal has no other connection path — outside a
 * host container the app stays unauthenticated.
 *
 * Every outcome is written to `hostConnection` in the web3 store so the
 * splash (app/page.tsx) and the shell screens can show *why* there is no
 * merchant account (components/host-connection-status.tsx) instead of a
 * "Connecting to host…" hint that never resolves.
 */
function HostAutoConnect() {
  const { setAccount, setStatus, account } = useWeb3Store()

  useEffect(() => {
    const setHostConnection = (state: HostConnectionState) =>
      useWeb3Store.getState().setHostConnection(state)

    if (account?.provider === WalletProviderType.HostAPI) {
      setHostConnection({ status: "connected" })
      return
    }

    let unsubscribe = () => {}

    const autoConnect = async () => {
      setHostConnection({ status: "connecting" })

      // Not `isInHost()` on its own: the host's bootstrap can land after the
      // page's own scripts (Android registers it once the TrUAPI execution
      // opens), so a launch that asked too early would call a real host a
      // plain browser tab. Waiting for the runtime to identify itself settles
      // both questions at once — and resolves immediately when either
      // container is already there.
      const runtime = await awaitHostRuntime()
      if (!isInHost()) {
        console.log("[HostAutoConnect] No host container — staying unauthenticated")
        setHostConnection({ status: "failed", reason: "not-in-host" })
        return
      }
      console.log(`[HostAutoConnect] Host detected, runtime: ${runtime} — connecting…`)

      try {
        const connected = await connectToHost()
        if (!connected) {
          console.log("[HostAutoConnect] Failed to connect to host")
          setHostConnection({ status: "failed", reason: "environment" })
          return
        }

        const accounts = await getHostAccounts()
        if (accounts.length === 0) {
          console.log("[HostAutoConnect] No accounts from host")
          setHostConnection({ status: "failed", reason: "no-accounts" })
          return
        }

        const first = accounts[0]
        console.log("[HostAutoConnect] Connected:", first.name, first.address)

        setAccount({
          name: first.name,
          address: first.address,
          provider: WalletProviderType.HostAPI,
        })
        setStatus(WalletProviderType.HostAPI, WalletProviderStatus.Connected)
        setHostConnection({ status: "connected" })

        unsubscribe = subscribeHostAccounts((updated) => {
          if (updated.length > 0) {
            const acc = updated[0]
            setAccount({
              name: acc.name,
              address: acc.address,
              provider: WalletProviderType.HostAPI,
            })
          }
        })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        console.warn("[HostAutoConnect] Connection failed:", detail)
        setHostConnection({ status: "failed", reason: "error", detail })
      }
    }

    autoConnect()

    return () => unsubscribe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}

export function Web3Provider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 60 * 1000, refetchOnWindowFocus: false },
        },
      })
  )

  return (
    <QueryClientProvider client={queryClient}>
      <HostAutoConnect />
      {children}
    </QueryClientProvider>
  )
}
