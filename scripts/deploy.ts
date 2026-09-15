/**
 * Interactive, (almost) no-skill deploy for the standalone T3RMINAL app.
 *
 * One command takes an operator from nothing to a live .dot product:
 *   1. generate a fresh wallet or paste an existing 12/24-word mnemonic,
 *   2. pick a chain (paseo-next-v2 default; previewnet for the bleeding edge),
 *   3. fund the printed address (faucet link, then press Enter),
 *   4. compile + deploy the T3rminalBulletinIndex contract (PAPI / pallet-revive)
 *      only when its .sol source changed — otherwise reuse the live deployment,
 *   5. build the static export, and
 *   6. publish it to a .dot domain via bulletin-deploy (incremental upload).
 *
 * The mnemonic only ever lives in memory and is passed to bulletin-deploy via
 * the MNEMONIC env var — it is never written to disk. The contract deploy step
 * writes the resulting address + chain into .env.local (gitignored) so the
 * static build inlines them.
 *
 * Usage:  npm run deploy                  (from the repo root)
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { cryptoWaitReady, mnemonicGenerate } from "@polkadot/util-crypto";

import {
  deployBulletinIndex,
  deriveAccount,
  fetchMainChainBalance,
} from "./deploy-bulletin-index";
import * as ui from "./lib/style";
import { sourceHashOf } from "./lib/contract-build.mjs";

const APP_ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(APP_ROOT, "out");
const MANIFEST_TEMPLATE = resolve(APP_ROOT, "bundle/manifest.toml");
const CONTRACTS_SRC = resolve(APP_ROOT, "contracts/src");
const CONTRACT_BLOB = resolve(APP_ROOT, "contracts/bytecode/T3rminalBulletinIndex.polkavm");
const CONTRACT_BUILD_INFO = resolve(APP_ROOT, "contracts/bytecode/build-info.json");
const DEFAULT_DOMAIN = "t3rminal-app-88.dot";
const GATEWAY_BASE = process.env.DOTNS_GATEWAY_BASE ?? "dot.li";
const MIN_BULLETIN_DEPLOY_VERSION = "0.8.0";
// The deploy spends PAS twice — instantiating the contract and registering the
// .dot — so we gate on a floor before starting. If the funded balance is under
// this, the funding step re-prompts instead of letting a half-deploy fail.
const MIN_FUNDING_PAS = 11;

interface DeployTarget {
  label: string;
  /** scripts/lib/networks.ts key — drives the PAPI contract deploy. */
  networkKey: string;
  /** bulletin-deploy --env id — drives the dapp publish + DotNS register. */
  bulletinEnv: string;
  faucet: string;
}

// Only chains where BOTH legs work are listed: the networks.ts key must resolve
// for the contract deploy, and a bulletin-deploy --env with Bulletin support
// must exist for the dapp. Mainnets (polkadot/kusama) have no Bulletin, and
// plain "paseo" has no matching bulletin env, so neither is offered.
const DEPLOY_TARGETS: DeployTarget[] = [
  {
    label: "Paseo Next V2  — recommended (contract already proven here)",
    networkKey: "paseo-next-v2",
    bulletinEnv: "paseo-next-v2",
    faucet: "https://faucet.polkadot.io/?parachain=1500",
  },
  {
    label: "Previewnet     — substrate.dev, rebuilt often (advanced)",
    networkKey: "previewnet",
    bulletinEnv: "preview",
    faucet: "no public faucet — fund via your team's previewnet tooling",
  },
];

function normalizeMnemonic(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function assertWordCount(mnemonic: string): void {
  const words = mnemonic.split(" ").filter(Boolean).length;
  if (words !== 12 && words !== 24) {
    throw new Error(
      `Mnemonic has ${words} words; expected 12 or 24. Re-check the phrase.`,
    );
  }
}

function parseSemver(value: string): [number, number, number] | null {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionGte(current: string, minimum: string): boolean {
  const a = parseSemver(current);
  const b = parseSemver(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

/**
 * Decide how to run bulletin-deploy without making the operator install
 * anything by hand. If a recent-enough CLI is already on PATH we use it
 * directly (fast path); otherwise — missing or too old — we fall back to
 * `npx -y bulletin-deploy@latest`, which fetches it on demand. npx needs no
 * global install and no sudo, and leaves nothing permanent on the machine.
 * Returns the argv prefix to spawn (e.g. ["bulletin-deploy"] or
 * ["npx", "-y", "bulletin-deploy@latest"]).
 */
function resolveBulletinDeployCommand(): string[] {
  const probe = spawnSync("bulletin-deploy", ["--version"], { encoding: "utf8" });
  if (!probe.error && probe.status === 0) {
    const version = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
    if (parseSemver(version) && versionGte(version, MIN_BULLETIN_DEPLOY_VERSION)) {
      ui.success(`bulletin-deploy ${version} (installed)`);
      return ["bulletin-deploy"];
    }
    ui.warn(
      `bulletin-deploy ${version || "(unknown version)"} is older than ` +
        `${MIN_BULLETIN_DEPLOY_VERSION} — fetching latest via npx instead.`,
    );
  } else {
    ui.info("bulletin-deploy not found — fetching latest via npx (no global install).");
  }
  return ["npx", "-y", "bulletin-deploy@latest"];
}

async function resolveWallet(rl: Interface): Promise<string> {
  ui.section("Wallet");
  ui.choice(1, "Generate a new wallet");
  ui.choice(2, "Paste an existing mnemonic");
  const choice = (await rl.question(ui.ask("Choose [1]: "))).trim() || "1";

  if (choice === "2") {
    const pasted = normalizeMnemonic(
      await rl.question(ui.ask("Paste your 12/24-word mnemonic: ")),
    );
    assertWordCount(pasted);
    return pasted;
  }

  const seed = mnemonicGenerate(12);
  ui.notice(
    "NEW WALLET MNEMONIC — write this down now",
    [
      ui.bold(ui.cyan(seed)),
      "",
      ui.dim("Anyone with these words controls the wallet. Never commit it."),
    ],
    "yellow",
  );
  await rl.question(ui.ask("Press Enter once you've saved it… "));
  return seed;
}

async function chooseTarget(rl: Interface): Promise<DeployTarget> {
  ui.section("Chain");
  DEPLOY_TARGETS.forEach((target, index) => {
    ui.choice(index + 1, target.label);
  });
  const answer = (await rl.question(ui.ask("Choose [1]: "))).trim() || "1";
  const target = DEPLOY_TARGETS[Number(answer) - 1];
  if (!target) throw new Error(`Invalid choice: ${answer}`);
  ui.success(
    `Selected ${target.networkKey} (bulletin env: ${target.bulletinEnv})`,
  );
  return target;
}

/**
 * Optional backend the SPA POSTs debug logs to (Settings → Debug logs → Send logs).
 * Baked into the build as NEXT_PUBLIC_LOG_INGEST_URL so the deployed SPA targets it.
 * Defaults to the NEXT_PUBLIC_LOG_INGEST_URL / LOG_INGEST_URL env var if set.
 */
async function resolveLogIngestUrl(rl: Interface): Promise<string | undefined> {
  ui.section("Log backend (optional)");
  const fallback =
    process.env.NEXT_PUBLIC_LOG_INGEST_URL ?? process.env.LOG_INGEST_URL ?? "";
  const prompt = fallback
    ? `Log-ingest URL [${fallback}] (Enter to keep, "-" to disable): `
    : "Log-ingest URL (Enter to skip): ";
  const answer = (await rl.question(ui.ask(prompt))).trim();
  if (answer === "-") {
    ui.info("Log backend disabled for this build.");
    return undefined;
  }
  const url = answer || fallback;
  if (!url) {
    ui.info('No log backend — "Send logs" stays unconfigured.');
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid log-ingest URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    ui.warn("Not https — the host WebView blocks cleartext, so the SPA send will fail in production.");
  }
  ui.success(`Send logs → ${url}`);
  return url;
}

/** Format planck (smallest unit) as a trimmed human balance string, max 4 dp. */
function formatPas(planck: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = planck / base;
  const frac = (planck % base)
    .toString()
    .padStart(decimals, "0")
    .slice(0, 4)
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function normalizeDomain(raw: string): string {
  let domain = raw.trim().toLowerCase() || DEFAULT_DOMAIN;
  if (!domain.endsWith(".dot")) domain += ".dot";
  return domain;
}

/**
 * Compile the contract only when its source changed since the committed
 * bytecode was built. `build:contracts` records the source hash in
 * contracts/bytecode/build-info.json; if it still matches, the checked-in
 * .polkavm is current and we skip the toolchain (and the recompile) entirely.
 */
function ensureContractBuilt(): void {
  ui.section("Contract build");
  const srcHash = sourceHashOf(CONTRACTS_SRC);
  let recordedHash: string | undefined;
  if (existsSync(CONTRACT_BUILD_INFO)) {
    try {
      recordedHash = JSON.parse(readFileSync(CONTRACT_BUILD_INFO, "utf8")).sourceHash;
    } catch {
      recordedHash = undefined;
    }
  }
  if (existsSync(CONTRACT_BLOB) && recordedHash === srcHash) {
    ui.success("Contract source unchanged — using committed bytecode (skipped compile).");
    return;
  }
  ui.step(
    existsSync(CONTRACT_BLOB)
      ? "Contract source changed — recompiling (npm run build:contracts)…"
      : "No prebuilt bytecode — compiling (npm run build:contracts)…",
  );
  const result = spawnSync("npm", ["run", "build:contracts"], {
    cwd: APP_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("build:contracts failed.");
}

function runBuild(logIngestUrl?: string): void {
  ui.section("Build");
  if (logIngestUrl) ui.step(`Targeting log backend: ${logIngestUrl}`);
  ui.step("Running next build…");
  const result = spawnSync("npm", ["run", "build"], {
    cwd: APP_ROOT,
    stdio: "inherit",
    env: logIngestUrl
      ? { ...process.env, NEXT_PUBLIC_LOG_INGEST_URL: logIngestUrl }
      : process.env,
  });
  if (result.status !== 0) throw new Error("next build failed.");
  if (!existsSync(resolve(OUT_DIR, "index.html"))) {
    throw new Error(
      `Build did not produce ${OUT_DIR}/index.html. ` +
        "Is output: 'export' set in next.config.ts?",
    );
  }
  ui.success("Static export ready (out/).");
}

/** Copy the manifest into the build output, rewriting its id to the domain. */
function writeManifest(domain: string): void {
  if (!existsSync(MANIFEST_TEMPLATE)) {
    throw new Error(`Missing manifest template at ${MANIFEST_TEMPLATE}`);
  }
  const template = readFileSync(MANIFEST_TEMPLATE, "utf8");
  if (!/^id = ".*"$/m.test(template)) {
    throw new Error("manifest.toml has no [app] id line to template.");
  }
  const manifest = template.replace(/^id = ".*"$/m, `id = "${domain}"`);
  writeFileSync(resolve(OUT_DIR, "manifest.toml"), manifest);
  ui.success(`Wrote manifest (id = ${domain})`);
}

function publishDapp(
  command: string[],
  target: DeployTarget,
  domain: string,
  seed: string,
): void {
  ui.section("Publish");
  ui.step(`bulletin-deploy --env ${target.bulletinEnv} → ${domain}…`);
  const [bin, ...prefixArgs] = command;
  const result = spawnSync(
    bin,
    [...prefixArgs, "--env", target.bulletinEnv, OUT_DIR, domain],
    {
      cwd: APP_ROOT,
      stdio: "inherit",
      // BULLETIN_DEPLOY_DOMAIN feeds bulletin-deploy.config.ts so its product
      // manifest `domain` matches this CLI domain (publishManifest aborts on a
      // mismatch). MNEMONIC stays in-memory only — never written to disk.
      env: { ...process.env, MNEMONIC: seed, BULLETIN_DEPLOY_DOMAIN: domain },
    },
  );
  if (result.status !== 0) throw new Error("bulletin-deploy failed.");
}

async function main(): Promise<void> {
  await cryptoWaitReady();
  ui.banner("T3RMINAL", "one-shot deploy · contract + dapp → .dot");
  const bulletinDeploy = resolveBulletinDeployCommand();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const seed = await resolveWallet(rl);
    const { ss58, h160 } = deriveAccount(seed);

    const target = await chooseTarget(rl);

    ensureContractBuilt();

    ui.section("Funding");
    ui.info("Send testnet PAS to this address before continuing:");
    ui.kvBlock([
      ["SS58", ss58],
      ["H160", h160],
      ["Faucet", target.faucet],
    ]);
    ui.info(
      `(needs at least ${MIN_FUNDING_PAS} PAS for the contract deploy and the .dot registration)`,
    );

    // Re-check on-chain balance after each "funded" confirmation. Under the
    // floor → warn and loop back to the same prompt; a read error → warn and
    // retry, never silently proceed on an under-funded wallet.
    for (;;) {
      await rl.question(ui.ask("Press Enter once the address is funded… "));
      ui.step("Checking on-chain balance…");
      try {
        const { planck, decimals, symbol } = await fetchMainChainBalance(
          ss58,
          target.networkKey,
        );
        const needed = BigInt(MIN_FUNDING_PAS) * 10n ** BigInt(decimals);
        const human = `${formatPas(planck, decimals)} ${symbol}`;
        if (planck >= needed) {
          ui.success(`Balance ${human} — enough to continue.`);
          break;
        }
        ui.warn(
          `Balance ${human} is below the ${MIN_FUNDING_PAS} ${symbol} needed — ` +
            "top up at the faucet, then press Enter to re-check.",
        );
      } catch (error) {
        ui.warn(
          `Couldn't read the balance (${error instanceof Error ? error.message : error}). ` +
            "Check the connection, then press Enter to retry.",
        );
      }
    }

    const { contractAddress, redeployed } = await deployBulletinIndex(
      seed,
      target.networkKey,
    );

    ui.section("Domain");
    const domain = normalizeDomain(
      await rl.question(ui.ask(`Domain to publish to [${DEFAULT_DOMAIN}]: `)),
    );

    const logIngestUrl = await resolveLogIngestUrl(rl);

    runBuild(logIngestUrl);
    writeManifest(domain);
    publishDapp(bulletinDeploy, target, domain, seed);

    const name = domain.replace(/\.dot$/, "");
    ui.notice(
      "Deployment complete",
      [
        `${ui.dim("Contract")}  ${contractAddress} ${ui.dim(`(${target.networkKey}, ${redeployed ? "newly deployed" : "reused"})`)}`,
        `${ui.dim("Live at ")}  ${ui.bold(ui.cyan(`https://${name}.${GATEWAY_BASE}`))}`,
      ],
      "green",
    );
  } finally {
    rl.close();
  }
}

// Only run when invoked directly, so tooling can import the helpers without
// kicking off the interactive flow.
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  main().catch((error) => {
    ui.fail(`Deploy failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
