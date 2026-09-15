#!/usr/bin/env node
/**
 * Point a dotNS name's registry resolver at the environment's content resolver.
 *
 * Why this exists: bulletin-deploy (≤ 0.15.2) writes a name's contenthash to
 * DOTNS_CONTENT_RESOLVER but only calls `registry.setResolver` for manifest
 * subnodes (`app.<name>`), never for the base name. The registrar controller
 * leaves the base name pointing at the reverse resolver, which holds no
 * content. The Polkadot **Android** app honours the registry pointer, so it
 * reads the empty resolver and reports "Domain … is not registered or has no
 * content"; iOS and the web gateway read the content resolver directly and
 * find the site. One `setResolver` per name fixes Android for good — later
 * redeploys keep the pointer.
 *
 * Usage (from the repo root):
 *   node scripts/dotns-set-resolver.mjs <name.paseo>             # read-only report
 *   MNEMONIC="…" node scripts/dotns-set-resolver.mjs <name.paseo> --apply
 *
 * The mnemonic must be the name owner's (the one the deploy ran with); it is
 * read from the environment only and never written anywhere. Env id defaults
 * to paseo-next-v2 (override with --env <id>). Reuses the globally installed
 * bulletin-deploy for signing so the tx path is identical to a deploy.
 */

import { execSync } from "node:child_process";
import { keccak_256 } from "@noble/hashes/sha3.js";

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--"));
const apply = args.includes("--apply");
const envId = args.includes("--env") ? args[args.indexOf("--env") + 1] : "paseo-next-v2";
if (!name || !name.includes(".")) {
  console.error("usage: node scripts/dotns-set-resolver.mjs <label.tld> [--apply] [--env paseo-next-v2]");
  process.exit(2);
}

const bulletinDeployDir =
  process.env.BULLETIN_DEPLOY_DIR ??
  `${execSync("npm root -g", { encoding: "utf8" }).trim()}/bulletin-deploy`;
const { DotNS } = await import(`${bulletinDeployDir}/dist/dotns.js`);
const { loadEnvironments, resolveEndpoints, getPopSelfServeConfig } = await import(
  `${bulletinDeployDir}/dist/environments.js`
);

const REGISTRY_ABI = [
  { type: "function", stateMutability: "view", name: "owner", inputs: [{ name: "node", type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", stateMutability: "view", name: "resolver", inputs: [{ name: "node", type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", stateMutability: "nonpayable", name: "setResolver", inputs: [{ name: "node", type: "bytes32" }, { name: "newResolver", type: "address" }], outputs: [] },
];
const CONTENT_RESOLVER_ABI = [
  { type: "function", stateMutability: "view", name: "contenthash", inputs: [{ name: "node", type: "bytes32" }], outputs: [{ type: "bytes" }] },
];

const toHex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
/** ENS-style namehash, labels hashed right to left from the zero root. */
function namehash(fqdn) {
  let node = new Uint8Array(32);
  for (const label of fqdn.toLowerCase().split(".").reverse()) {
    node = keccak_256(concat(node, keccak_256(new TextEncoder().encode(label))));
  }
  return toHex(node);
}

const loaded = await loadEnvironments();
const doc = loaded.doc ?? loaded;
const env = resolveEndpoints(doc, envId);
const { DOTNS_REGISTRY, DOTNS_CONTENT_RESOLVER } = env.contracts;
if (!DOTNS_REGISTRY || !DOTNS_CONTENT_RESOLVER) {
  throw new Error(`env ${envId} lacks DOTNS_REGISTRY / DOTNS_CONTENT_RESOLVER`);
}
if (env.tld && !name.endsWith(`.${env.tld}`)) {
  console.warn(`! ${name} does not end with the ${envId} TLD ".${env.tld}" — continuing anyway`);
}

const node = namehash(name);
const dotns = new DotNS();
try {
  await dotns.connect({
    mnemonic: process.env.MNEMONIC || process.env.DOTNS_MNEMONIC,
    assetHubEndpoints: env.assetHub,
    autoAccountMapping: env.autoAccountMapping,
    contracts: env.contracts,
    nativeToEthRatio: env.nativeToEthRatio,
    environmentId: envId,
    popSelfServe: getPopSelfServeConfig(doc, envId),
    registerStorageDeposit: env.registerStorageDeposit,
    tld: env.tld,
  });

  const [owner, resolver, contenthash] = await Promise.all([
    dotns.contractCall(DOTNS_REGISTRY, REGISTRY_ABI, "owner", [node]),
    dotns.contractCall(DOTNS_REGISTRY, REGISTRY_ABI, "resolver", [node]),
    dotns.contractCall(DOTNS_CONTENT_RESOLVER, CONTENT_RESOLVER_ABI, "contenthash", [node]),
  ]);
  const lc = (a) => String(a ?? "").toLowerCase();
  const label = (addr) =>
    Object.entries(env.contracts).find(([, v]) => lc(v) === lc(addr))?.[0] ??
    (lc(addr) === "0x" + "0".repeat(40) ? "unset" : "unknown");

  console.log(`\n${name}  (${envId})`);
  console.log(`  node              ${node}`);
  console.log(`  registry.owner    ${owner}${lc(owner) === lc(dotns.evmAddress) ? "  ← this signer" : ""}`);
  console.log(`  registry.resolver ${resolver}  [${label(resolver)}]`);
  console.log(`  content resolver  ${DOTNS_CONTENT_RESOLVER}  contenthash=${contenthash && contenthash !== "0x" ? contenthash : "(none)"}`);
  console.log(`  signer (H160)     ${dotns.evmAddress}`);

  const alreadyRight = lc(resolver) === lc(DOTNS_CONTENT_RESOLVER);
  if (alreadyRight) {
    console.log("\n✓ resolver already points at the content resolver — nothing to do.");
  } else if (!apply) {
    console.log(`\n→ dry run. Android needs registry.resolver = ${DOTNS_CONTENT_RESOLVER}. Re-run with --apply and MNEMONIC set (owner's mnemonic).`);
  } else if (lc(owner) !== lc(dotns.evmAddress)) {
    throw new Error(`refusing: signer ${dotns.evmAddress} is not the owner ${owner}`);
  } else {
    console.log("\n→ sending registry.setResolver(node, content resolver)…");
    await dotns.contractTransaction(
      DOTNS_REGISTRY, 0n, REGISTRY_ABI, "setResolver", [node, DOTNS_CONTENT_RESOLVER],
      (status) => console.log(`   ${status}`),
    );
    const after = await dotns.contractCall(DOTNS_REGISTRY, REGISTRY_ABI, "resolver", [node]);
    console.log(lc(after) === lc(DOTNS_CONTENT_RESOLVER) ? `✓ resolver now ${after}` : `! resolver still ${after} — check the tx above`);
  }
} finally {
  try { dotns.disconnect(); } catch { /* already torn down */ }
}
