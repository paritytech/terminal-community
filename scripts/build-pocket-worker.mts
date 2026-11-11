// Builds the terminal's Pocket worker archive into out-pocket/, which
// bulletin-deploy.config.ts publishes as the product's `worker` executable:
//
//   out-pocket/worker.js            the worker the host boots to draw the card
//   out-pocket/faces/merchant.json  the static face the host's add sheet draws
//                                   before the worker has run (sample figures)
//   out-pocket/faces/empty.json     the card before the first sale
//
// Runs after `next build` (npm `postbuild`), or on its own:
//
//   npm run build:pocket
//
// Load-bearing, per pocket-reciept's worker build:
//  - one entry, one file: the manifest names `worker.js` and the host fetches
//    exactly that path, so nothing may be split into a sibling chunk.
//  - minified with NODE_ENV replaced: `process` is undefined in the host's
//    worker WebView, so a dependency's NODE_ENV check would kill the boot.
//  - ASCII output: the host reads worker JS as Latin-1. Checked below.
//
// Every face the worker can stream is held to the Android host's limits
// first, so a face the host would refuse fails the build, not the phone.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { androidLimits, assertFaceValid } from "@parity/product-sdk-renderer";
import { emptyFace, merchantFace, sampleStats, type CardStats } from "../lib/pocket/merchant-card";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "out-pocket");

rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, "faces"), { recursive: true });

const faces = { "merchant.json": merchantFace(sampleStats()), "empty.json": emptyFace() };
for (const [name, face] of Object.entries(faces)) {
  // Measured as the file will be written: indentation counts toward the cap.
  const json = JSON.stringify(face, null, 2) + "\n";
  assertFaceValid(json, { host: androidLimits });
  writeFileSync(resolve(out, "faces", name), json);
}

// What the worker can stream, at its extremes.
const sample = sampleStats();
const huge = BigInt("999999999999999999");
const edge: CardStats[] = [
  { ...sample, today: { planck: BigInt(0), count: 0 } },
  { ...sample, recent: [], today: { planck: BigInt(1), count: 1 }, week: { planck: BigInt(1), count: 1 }, total: 1 },
  { ...sample, today: { planck: huge, count: 99999 }, week: { planck: huge, count: 99999 }, total: 99999 },
  { ...sample, symbol: "AVERYLONGASSETSYMBOL" },
];
for (const stats of edge) assertFaceValid(merchantFace(stats), { host: androidLimits });

await build({
  entryPoints: [resolve(root, "pocket/worker.ts")],
  outfile: resolve(out, "worker.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  charset: "ascii",
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  logLevel: "warning",
});

const bundle = readFileSync(resolve(out, "worker.js"));
const offending = bundle.findIndex((byte) => byte > 0x7f);
if (offending !== -1) {
  throw new Error(`out-pocket/worker.js is not ASCII (byte ${bundle[offending]} at ${offending}); the host reads it as Latin-1`);
}

process.stdout.write(
  `out-pocket: worker.js (${(bundle.length / 1024).toFixed(1)} KiB), ${Object.keys(faces).length} faces written, ${edge.length} live faces validated\n`,
);
