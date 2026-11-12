// Contract addresses and network configuration.
//
// The live contract path (lib/contracts/revive-bulletin-index.ts via PAPI)
// only consumes getContractAddresses().bulletinIndex; the chain RPC endpoint
// for that path comes from lib/host/provider.ts, not the `rpcUrl` here. The
// chainId/rpcUrl fields are only written into daily reports as metadata;
// nothing connects to `rpcUrl`.
//
// Both the active network and the contract address are overridable at build
// time via NEXT_PUBLIC_NETWORK and NEXT_PUBLIC_BULLETIN_INDEX_ADDRESS, which
// scripts/deploy-bulletin-index.ts writes into .env.local after a deploy.

export type NetworkConfig = {
  chainId: number;
  name: string;
  rpcUrl: string;
  bulletinIndex: string;
};

// Local Hardhat network (deterministic addresses from deployment)
export const localNetwork: NetworkConfig = {
  chainId: 31337,
  name: "Hardhat Local",
  rpcUrl: "http://127.0.0.1:8545",
  bulletinIndex: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
};

// Paseo Asset Hub Next (v2) testnet — packages/host network key "paseo-next-v2".
// NOTE: Paseo Next v2 is reset periodically (last genesis refresh 2026-08 —
// the 0x3467… deployment below died with it and must be redeployed via
// `npm run deploy:contract`), which wipes deployed contracts. This default must track the current live
// T3rminalBulletinIndex deployment, because the CI build (.github/workflows/
// deploy-frontend.yml) has no .env.local and bakes this fallback unless the
// NEXT_PUBLIC_BULLETIN_INDEX_ADDRESS repo variable is set. A stale value here
// makes every on-chain read return empty `0x` (see revive-bulletin-index.ts).
export const paseoNetwork: NetworkConfig = {
  chainId: 420420417,
  name: "Paseo Asset Hub Next",
  rpcUrl: "https://testnet-passet-hub-eth-rpc.polkadot.io",
  bulletinIndex: "0x3467596e99D24E62Ae5525DEAd280de2cAA735e4",
};

// Previewnet (substrate.dev) testnet — packages/host network key "previewnet".
// Rebuilt frequently, so the contract address is always supplied per-deploy
// via the env override (no stable default). No EVM JSON-RPC is exposed, so
// chainId/rpcUrl are placeholders; only the live PAPI path runs here and it
// ignores them.
export const previewnetNetwork: NetworkConfig = {
  chainId: 0,
  name: "Previewnet Asset Hub",
  rpcUrl: "",
  bulletinIndex: "",
};

// Build-time network selection. Keys match the packages/host network registry
// keys that scripts/deploy-bulletin-index.ts writes into NEXT_PUBLIC_NETWORK.
const NETWORKS_BY_KEY: Record<string, NetworkConfig> = {
  "paseo-next-v2": paseoNetwork,
  previewnet: previewnetNetwork,
  local: localNetwork,
};

const selectedKey = process.env.NEXT_PUBLIC_NETWORK;
const baseNetwork = (selectedKey && NETWORKS_BY_KEY[selectedKey]) || paseoNetwork;

// Current active network. The contract address can be overridden independently
// (a fresh deploy writes NEXT_PUBLIC_BULLETIN_INDEX_ADDRESS), so the selected
// network's default address is only a fallback.
export const activeNetwork: NetworkConfig = {
  ...baseNetwork,
  bulletinIndex:
    process.env.NEXT_PUBLIC_BULLETIN_INDEX_ADDRESS || baseNetwork.bulletinIndex,
};

// Helper to get contract addresses for current network
export function getContractAddresses() {
  return {
    bulletinIndex: activeNetwork.bulletinIndex,
  };
}
