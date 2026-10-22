/**
 * Deploy T3rminalBulletinIndex via pallet-revive instantiate_with_code.
 *
 * Mirrors apps/w3spay-admin/contracts/scripts/deploy-registry.ts, but:
 *  - loads the checked-in PolkaVM blob directly (no Hardhat compile needed),
 *  - the contract has no constructor, so the deploy data is "0x", and
 *  - derives the deployer H160 with @noble/hashes (no viem dependency).
 *
 * The network is selected via NETWORK env / --env flag through the shared
 * registry in scripts/lib/networks.ts (default: paseo-next-v2). The
 * deployer is a local sr25519 key derived from DEPLOYER_SEED, so signing
 * happens here over PAPI — there's no host signing UI in the loop.
 *
 * On success it writes the app's .env.local so the next `next build` inlines
 * the freshly-deployed address + chain, and records the deployment under
 * deployments/<network>/.
 *
 * Usage:
 *   DEPLOYER_SEED="twelve or twenty-four words ..." npx tsx scripts/deploy-bulletin-index.ts
 *   DEPLOYER_SEED="..." npx tsx scripts/deploy-bulletin-index.ts --env previewnet
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { createClient, Binary } from "polkadot-api";
import { getWsProvider } from "@polkadot-api/ws-provider";
import { getTxCreator, type SignerTxCreator } from "polkadot-api/tx-creator";
import { AccountId } from "@polkadot-api/substrate-bindings";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
  entropyToMiniSecret,
  mnemonicToEntropy,
} from "@polkadot-labs/hdkd-helpers";
import { keccak_256 } from "@noble/hashes/sha3.js";

import {
  resolveNetwork,
  type NetworkConfig,
} from "./lib/networks";
import * as ui from "./lib/style";

const APP_ROOT = resolve(__dirname, "..");
// Prebuilt PolkaVM bytecode for T3rminalBulletinIndex, checked in so a deploy
// doesn't depend on a working Hardhat/resolc toolchain. To rebuild after the
// contract source changes: `cd contracts && npm install && npm run compile`,
// then copy the emitted PolkaVM blob to this path.
const POLKAVM_PATH = resolve(
  APP_ROOT,
  "contracts/bytecode/T3rminalBulletinIndex.polkavm",
);
const GAS_MULTIPLIER = 4n;
const CONTRACT_LABEL = "T3rminalBulletinIndex";

export interface DeployResult {
  network: NetworkConfig;
  contractAddress: `0x${string}`;
  txHash: string;
  ss58: string;
  h160: `0x${string}`;
  /** false when an unchanged contract was reused (no on-chain deploy). */
  redeployed: boolean;
}

interface SignerBundle {
  signer: SignerTxCreator;
  publicKey: Uint8Array;
  ss58: string;
  h160: `0x${string}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 of the raw bytecode bytes — the contract's content identity. */
function codeHashOf(code: `0x${string}`): string {
  return createHash("sha256").update(Buffer.from(code.slice(2), "hex")).digest("hex");
}

/** pallet-revive maps a native AccountId32 -> H160 as keccak256(pubkey)[12..32]. */
function deriveH160(publicKey: Uint8Array): `0x${string}` {
  return `0x${bytesToHex(keccak_256(publicKey).slice(12, 32))}` as `0x${string}`;
}

function parseEnvFlag(argv: string[]): string | undefined {
  const index = argv.indexOf("--env");
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value) {
    throw new Error("--env requires a value (e.g. paseo-next-v2 | previewnet)");
  }
  return value;
}

function createSigner(seed: string): SignerBundle {
  const miniSecret = entropyToMiniSecret(mnemonicToEntropy(seed));
  const derive = sr25519CreateDerive(miniSecret);
  const keyPair = derive("");
  const publicKey = keyPair.publicKey;
  return {
    signer: getTxCreator(publicKey, "Sr25519", keyPair.sign),
    publicKey,
    ss58: AccountId(42).dec(publicKey),
    h160: deriveH160(publicKey),
  };
}

/** Derive the deployer's SS58 + H160 addresses from a seed (for display). */
export function deriveAccount(seed: string): {
  ss58: string;
  h160: `0x${string}`;
} {
  const { ss58, h160 } = createSigner(seed);
  return { ss58, h160 };
}

/**
 * Read an account's free balance on the network's main chain — the chain where
 * the deployer holds PAS and where the contract instantiates. Opens a
 * short-lived PAPI client (same connect/destroy shape as deployBulletinIndex)
 * so the interactive deploy can gate on funding before it starts spending.
 * System.Account is a ValueQuery, so an unfunded account reads back a zeroed
 * AccountInfo rather than undefined. Returns raw planck plus the token's
 * decimals + symbol; the caller owns the threshold and human formatting.
 */
export async function fetchMainChainBalance(
  ss58: string,
  networkKey: string,
): Promise<{ planck: bigint; decimals: number; symbol: string }> {
  const network = resolveNetwork(networkKey, {
    mainGenesisHash: process.env.VITE_CHAIN_GENESIS_HASH,
    bulletinGenesisHash: process.env.VITE_BULLETIN_GENESIS_HASH,
  });
  const client = createClient(getWsProvider(network.mainChain.wsUrl));
  try {
    const api = client.getUnsafeApi();
    const account = (await api.query.System.Account.getValue(ss58)) as any;
    const free = (account?.data?.free ?? 0n) as bigint;
    return {
      planck: free,
      decimals: network.nativeToken.decimals,
      symbol: network.nativeToken.symbol,
    };
  } finally {
    client.destroy();
  }
}

function loadBytecode(): `0x${string}` {
  if (!existsSync(POLKAVM_PATH)) {
    throw new Error(
      `Missing PolkaVM blob at ${POLKAVM_PATH}.\n` +
        "Build the contract first: cd contracts && npm install && npm run compile",
    );
  }
  const buf = readFileSync(POLKAVM_PATH);
  if (buf.length === 0) throw new Error("PolkaVM blob is empty.");
  return `0x${buf.toString("hex")}` as `0x${string}`;
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}

function extractHex(value: unknown): `0x${string}` | undefined {
  if (typeof value === "string" && value.startsWith("0x")) {
    return value as `0x${string}`;
  }
  if (value instanceof Uint8Array) {
    return `0x${bytesToHex(value)}` as `0x${string}`;
  }
  return undefined;
}

function isAccountAlreadyMapped(err: unknown): boolean {
  const message = err instanceof Error ? err.message : stringify(err);
  return /AccountAlreadyMapped/i.test(message);
}

/**
 * Register the deployer's AccountId32 -> H160 mapping in pallet-revive.
 *
 * We do NOT pre-check via ReviveApi.address(): that runtime call only *derives*
 * the H160 from the account id and returns it whether or not map_account has
 * ever run, so it can't distinguish mapped from unmapped (a fresh wallet would
 * look "mapped" and we'd skip the real tx, then instantiate fails with
 * AccountUnmapped). Instead we submit map_account unconditionally and treat
 * AccountAlreadyMapped as success — it's idempotent and cheap. map_account is
 * dispatched from the Substrate signed origin, so an unmapped account can run
 * it.
 */
async function ensureMapped(api: any, signer: SignerTxCreator): Promise<void> {
  ui.step("Mapping deployer account (pallet-revive)…");
  const result = await api.tx.Revive.map_account().createAndSubmit(signer);
  if (result.ok) {
    ui.success(`Account mapped — ${result.txHash}`);
    return;
  }
  if (isAccountAlreadyMapped(result.dispatchError)) {
    ui.success("Account already mapped");
    return;
  }
  throw new Error(`Revive.map_account failed: ${stringify(result.dispatchError)}`);
}

async function deployContract(
  api: any,
  signer: SignerTxCreator,
  origin: string,
  dryRunDeposit: bigint,
): Promise<{ contractAddress: `0x${string}`; txHash: string }> {
  const code = loadBytecode();

  ui.step("Deploying via Revive.instantiate_with_code…");

  const dryRun = await api.apis.ReviveApi.instantiate(
    origin,
    0n,
    undefined,
    dryRunDeposit,
    { type: "Upload", value: Binary.fromHex(code) },
    Binary.fromHex("0x"),
    undefined,
  );

  if (!dryRun.result.success) {
    throw new Error(`${CONTRACT_LABEL} dry-run failed: ${stringify(dryRun.result.value)}`);
  }
  if (dryRun.result.value.result?.flags & 1) {
    throw new Error(`${CONTRACT_LABEL} constructor reverted during dry-run.`);
  }

  const weightLimit = {
    ref_time: dryRun.weight_required.ref_time * GAS_MULTIPLIER,
    proof_size: dryRun.weight_required.proof_size * GAS_MULTIPLIER,
  };
  const storageDepositLimit =
    dryRun.storage_deposit.type === "Charge" && dryRun.storage_deposit.value > 0n
      ? dryRun.storage_deposit.value * GAS_MULTIPLIER
      : dryRunDeposit;

  ui.info(`gas ref_time=${weightLimit.ref_time} proof_size=${weightLimit.proof_size}`);
  ui.info(`storage deposit limit ${storageDepositLimit}`);

  const tx = api.tx.Revive.instantiate_with_code({
    value: 0n,
    weight_limit: weightLimit,
    storage_deposit_limit: storageDepositLimit,
    code: Binary.fromHex(code),
    data: Binary.fromHex("0x"),
    salt: undefined,
  });

  const result = await tx.createAndSubmit(signer);
  if (!result.ok) {
    throw new Error(`${CONTRACT_LABEL} deployment failed: ${stringify(result.dispatchError)}`);
  }

  let contractAddress: `0x${string}` | undefined;
  for (const event of result.events) {
    if (event.type !== "Revive") continue;
    const value = event.value as any;
    if (value?.type !== "Instantiated") continue;
    contractAddress = extractHex(value.value?.contract);
    if (contractAddress) break;
  }
  if (!contractAddress) {
    contractAddress = extractHex(dryRun.result.value.account_id);
  }
  if (!contractAddress) {
    throw new Error("Could not determine deployed contract address from events or dry-run.");
  }

  return { contractAddress, txHash: result.txHash as string };
}

/**
 * Idempotently merge `values` into the dotenv file at `path`, preserving
 * comments, blanks, and unrelated keys.
 */
function upsertEnvFile(path: string, values: Record<string, string>): void {
  let content = existsSync(path) ? readFileSync(path, "utf8") : "";
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=.*$`, "m");
    if (re.test(content)) content = content.replace(re, line);
    else {
      if (content.length && !content.endsWith("\n")) content += "\n";
      content += `${line}\n`;
    }
  }
  writeFileSync(path, content);
}

interface DeploymentRecord {
  network: string;
  bulletinIndex: `0x${string}`;
  txHash: string;
  codeHash: string;
  deployedAt: string;
}

function writeDeploymentRecord(
  networkKey: string,
  address: `0x${string}`,
  txHash: string,
  codeHash: string,
): void {
  const dir = resolve(APP_ROOT, "deployments", networkKey);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, "deployed_addresses.json"),
    `${JSON.stringify({ "T3rminalBulletinIndex#bulletinIndex": address }, null, 2)}\n`,
  );
  const record: DeploymentRecord = {
    network: networkKey,
    bulletinIndex: address,
    txHash,
    codeHash,
    deployedAt: new Date().toISOString(),
  };
  writeFileSync(resolve(dir, "deployment.json"), `${JSON.stringify(record, null, 2)}\n`);
}

/** Read a prior deployment record for `networkKey`, or null if none/unreadable. */
function readDeploymentRecord(networkKey: string): DeploymentRecord | null {
  const path = resolve(APP_ROOT, "deployments", networkKey, "deployment.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DeploymentRecord;
  } catch {
    return null;
  }
}

/**
 * Best-effort on-chain check: does `address` still host code matching
 * `expectedCodeHash`? Guards the "reuse" path against testnet resets or a fresh
 * clone whose local record points at a contract that's no longer there.
 *
 * ReviveApi is reached via the untyped `getUnsafeApi()`, so any shape/RPC
 * surprise resolves to "unknown" and the caller falls back to the local record
 * rather than forcing a needless redeploy.
 */
async function verifyContractOnChain(
  api: any,
  address: `0x${string}`,
  expectedCodeHash: string,
): Promise<"match" | "mismatch" | "absent" | "unknown"> {
  try {
    const onChain = await api.apis.ReviveApi.code(address);
    const codeHex = extractHex(onChain);
    if (codeHex === undefined) return "unknown";
    if (codeHex === "0x") return "absent";
    return codeHashOf(codeHex) === expectedCodeHash ? "match" : "mismatch";
  } catch {
    return "unknown";
  }
}

/**
 * Deploy a fresh T3rminalBulletinIndex to `networkKey` and persist the
 * resulting address into the app's .env.local + deployments record. Exported
 * so the interactive orchestrator (scripts/deploy.ts) can drive it in-process.
 */
export async function deployBulletinIndex(
  seed: string,
  networkKey: string,
): Promise<DeployResult> {
  const network = resolveNetwork(networkKey, {
    mainGenesisHash: process.env.VITE_CHAIN_GENESIS_HASH,
    bulletinGenesisHash: process.env.VITE_BULLETIN_GENESIS_HASH,
  });
  if (!network.mainChain.genesisHash) {
    throw new Error(`Network ${network.key} is missing mainChain.genesisHash.`);
  }

  const dryRunDeposit = 50n * 10n ** BigInt(network.nativeToken.decimals);
  const { signer, ss58, h160 } = createSigner(seed);

  ui.section("Contract");
  ui.kvBlock([
    ["Network", `${network.displayName} (${network.key})`],
    ["WS URL", network.mainChain.wsUrl],
    ["Genesis", network.mainChain.genesisHash],
    ["Deployer SS58", ss58],
    ["Deployer H160", h160],
  ]);

  const code = loadBytecode();
  const codeHash = codeHashOf(code);
  const record = readDeploymentRecord(network.key);

  const client = createClient(getWsProvider(network.mainChain.wsUrl));
  try {
    const api = client.getUnsafeApi();

    // Reuse path: the committed bytecode matches what the local record says is
    // already deployed here — confirm it's still on-chain, then skip the deploy
    // entirely (no map_account, no instantiate, no fees, same address).
    if (record?.codeHash === codeHash && record.bulletinIndex) {
      const verdict = await verifyContractOnChain(api, record.bulletinIndex, codeHash);
      if (verdict === "match" || verdict === "unknown") {
        const note =
          verdict === "unknown"
            ? " (on-chain check unavailable — trusting local record)"
            : "";
        ui.success(`Contract unchanged — reusing ${record.bulletinIndex}${note}`);
        upsertEnvFile(resolve(APP_ROOT, ".env.local"), {
          NEXT_PUBLIC_NETWORK: network.key,
          NEXT_PUBLIC_BULLETIN_INDEX_ADDRESS: record.bulletinIndex,
          NEXT_PUBLIC_ASSET_HUB_WS: network.mainChain.wsUrl,
        });
        return {
          network,
          contractAddress: record.bulletinIndex,
          txHash: record.txHash,
          ss58,
          h160,
          redeployed: false,
        };
      }
      ui.warn(
        `Local record points at ${record.bulletinIndex} but on-chain code is ${verdict} — redeploying.`,
      );
    }

    await ensureMapped(api, signer);
    const { contractAddress, txHash } = await deployContract(
      api,
      signer,
      ss58,
      dryRunDeposit,
    );

    writeDeploymentRecord(network.key, contractAddress, txHash, codeHash);
    upsertEnvFile(resolve(APP_ROOT, ".env.local"), {
      NEXT_PUBLIC_NETWORK: network.key,
      NEXT_PUBLIC_BULLETIN_INDEX_ADDRESS: contractAddress,
      NEXT_PUBLIC_ASSET_HUB_WS: network.mainChain.wsUrl,
    });

    ui.success(`Contract deployed — ${contractAddress}`);
    ui.info(`tx ${txHash}`);
    ui.info(`recorded deployments/${network.key}/deployed_addresses.json`);
    ui.info("updated .env.local");

    return { network, contractAddress, txHash, ss58, h160, redeployed: true };
  } finally {
    client.destroy();
  }
}

async function main(): Promise<void> {
  const seed = process.env.DEPLOYER_SEED;
  if (!seed) {
    throw new Error(
      "DEPLOYER_SEED is not set. Export your 12/24-word mnemonic, e.g.\n" +
        '  DEPLOYER_SEED="word1 word2 ... word12" npx tsx scripts/deploy-bulletin-index.ts',
    );
  }
  const networkKey = parseEnvFlag(process.argv) ?? process.env.NETWORK ?? "paseo-next-v2";
  await deployBulletinIndex(seed, networkKey);
}

// Only run when invoked directly (not when imported by the orchestrator).
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  main().catch((error) => {
    ui.fail(`Deployment failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
