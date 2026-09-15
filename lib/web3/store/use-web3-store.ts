import { create } from "zustand"
import { persist } from "zustand/middleware"
import {
  Account,
  WalletProviderType,
  WalletProviderStatus,
  WalletProviderEntry,
  Web3State,
} from "@/lib/web3/types/web3"
import type { HostConnectionState } from "@/lib/host/connection-status"

interface Web3Store extends Web3State {
  /**
   * Outcome of the host auto-connect (lib/web3/components/providers/
   * web3-provider.tsx). Not persisted — it describes this page load only.
   */
  hostConnection: HostConnectionState
  setHostConnection: (state: HostConnectionState) => void
  setAccount: (account: Account | null) => void
  setStatus: (
    provider: WalletProviderType | null,
    status: WalletProviderStatus
  ) => void
  getStatus: (provider: WalletProviderType | null) => WalletProviderStatus
  setError: (error: string) => void
  disconnect: () => void
}

const initialState: Web3State = {
  providers: [],
  account: null,
  error: "",
}

export const useWeb3Store = create<Web3Store>()(
  persist(
    (set, get) => ({
      ...initialState,
      hostConnection: { status: "idle" },
      setHostConnection: (hostConnection) => set((state) => ({ ...state, hostConnection })),
      setAccount: (account) => set((state) => ({ ...state, account })),
      setStatus: (provider, status) => {
        const isError = status === WalletProviderStatus.Error
        return set((state) => ({
          ...state,
          providers: provider
            ? [
                ...state.providers.filter((p) => p.type !== provider),
                { type: provider, status },
              ]
            : state.providers,
          account: isError ? null : state.account,
          error: isError ? state.error : "",
        }))
      },
      getStatus: (provider) => {
        const found = get().providers.find((p) => p.type === provider)
        return found?.status ?? WalletProviderStatus.Disconnected
      },
      setError: (error) => set((state) => ({ ...state, error })),
      disconnect: () => set({ ...initialState }),
    }),
    {
      name: "web3-connect",
      partialize: (state) => ({
        providers: state.providers,
        account: state.account,
      }),
    }
  )
)
