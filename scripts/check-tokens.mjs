#!/usr/bin/env node
/**
 * check:tokens — the design-system lint for app code.
 *
 * Outside components/ui/ only Polkadot semantic tokens are allowed: fg-*,
 * surface-, action-, status-, selection- (bg group), stroke-*, focus-*, shadow-1/2/3,
 * rounded-container/nested/medium/small/full and the fourteen named type
 * styles. This script flags everything else that still compiles (or silently
 * no longer does) so a migrated screen can be proven clean and the rest of
 * the app can be ranked by how much is left:
 *
 *   - raw hex colours and --palette-* references
 *   - the `dark:` variant (the token already re-themes)
 *   - stock Tailwind colour utilities (bg-white, text-neutral-400, …)
 *   - stock radius / shadow / type steps (rounded-xl, shadow-md, text-sm, …)
 *   - font-bold, leading-*, tracking-* (weight is a closed set; line-height
 *     and tracking belong to the named style)
 *   - shadcn role names (bg-card, text-muted-foreground, bare text-primary …)
 *
 * Usage:
 *   node scripts/check-tokens.mjs                 # scan app/, components/, lib/ — summary per file
 *   node scripts/check-tokens.mjs <file> [...]    # list every hit in these files; exit 1 on any
 *   node scripts/check-tokens.mjs --all           # list every hit everywhere; exit 1 on any
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["app", "components", "lib"];
const SKIP_DIRS = new Set(["node_modules", "ui"]); // components/ui is shadcn's vocabulary
const EXT = /\.(tsx|ts|jsx|js|css)$/;

const COLOURS =
  "white|black|neutral|gray|zinc|slate|stone|red|green|blue|amber|yellow|orange|indigo|violet|fuchsia|purple|pink|rose|emerald|teal|cyan|sky|lime";
const COLOUR_PREFIX =
  "bg|text|border|ring|outline|placeholder|from|to|via|fill|stroke|divide|shadow|accent|caret|decoration";

const RULES = [
  { name: "hex colour", re: /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g },
  { name: "--palette-* reference", re: /--palette-[a-z0-9-]+/g },
  { name: "dark: variant", re: /(?<![\w-])dark:/g },
  {
    name: "stock colour utility",
    re: new RegExp(
      `(?<![\\w-])(?:[a-z-]+:)*(?:${COLOUR_PREFIX})-(?:${COLOURS})(?:-\\d{2,3})?(?:/\\d{1,3})?(?![\\w-])`,
      "g",
    ),
  },
  { name: "stock radius", re: /(?<![\w-])rounded(?:-[trbl]|-[tb][lr]|-[se]|-[se][se])?(?:-(?:none|xs|sm|md|lg|xl|2xl|3xl|4xl))?(?![\w-])/g },
  { name: "stock shadow", re: /(?<![\w-])shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl|inner|none))?(?![\w-])/g },
  { name: "stock type step", re: /(?<![\w-])text-(?:xs|sm|base|lg|xl|[2-9]xl|\[\d+px\])(?![\w-])/g },
  { name: "font-bold", re: /(?<![\w-])font-(?:bold|extrabold|black|light|thin|extralight)(?![\w-])/g },
  { name: "leading-*", re: /(?<![\w-])leading-[\w[\]-]+/g },
  { name: "tracking-*", re: /(?<![\w-])tracking-[\w[\]-]+/g },
  {
    name: "shadcn role outside components/ui",
    re: /(?<![\w-])(?:bg|text|border)-(?:card|popover|muted|accent|primary|secondary|destructive|input|ring|background|foreground)(?:-foreground)?(?![\w-])/g,
  },
];

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, out);
    } else if (EXT.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function scan(file) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  const hits = [];
  // Comments explain migrations and often quote the old class names — skip
  // them. Tracks /* … */ across lines (JSX {/* … */} included).
  let inBlock = false;
  lines.forEach((line, i) => {
    let code = "";
    let rest = line;
    while (rest.length) {
      if (inBlock) {
        const end = rest.indexOf("*/");
        if (end === -1) { rest = ""; break; }
        rest = rest.slice(end + 2);
        inBlock = false;
      } else {
        const start = rest.indexOf("/*");
        const lineComment = rest.indexOf("//");
        if (lineComment !== -1 && (start === -1 || lineComment < start)) {
          code += rest.slice(0, lineComment);
          rest = "";
        } else if (start !== -1) {
          code += rest.slice(0, start);
          rest = rest.slice(start + 2);
          inBlock = true;
        } else {
          code += rest;
          rest = "";
        }
      }
    }
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(code)) !== null) {
        hits.push({ line: i + 1, rule: rule.name, match: m[0] });
      }
    }
  });
  return hits;
}

const args = process.argv.slice(2);
const listAll = args.includes("--all");
const explicit = args.filter((a) => !a.startsWith("--"));

const files = explicit.length
  ? explicit.map((f) => join(ROOT, f))
  : SCAN_DIRS.flatMap((d) => walk(join(ROOT, d), []));

let total = 0;
const perFile = [];
for (const file of files) {
  const hits = scan(file);
  total += hits.length;
  perFile.push({ file: relative(ROOT, file), hits });
}

if (explicit.length || listAll) {
  for (const { file, hits } of perFile) {
    for (const h of hits) console.log(`${file}:${h.line}  ${h.rule}: ${h.match}`);
  }
  console.log(`\n${total} literal${total === 1 ? "" : "s"} in ${perFile.length} file${perFile.length === 1 ? "" : "s"}`);
  process.exit(total > 0 ? 1 : 0);
} else {
  perFile
    .filter((f) => f.hits.length > 0)
    .sort((a, b) => b.hits.length - a.hits.length)
    .forEach((f) => console.log(`${String(f.hits.length).padStart(4)}  ${f.file}`));
  console.log(`\n${total} literals across ${perFile.filter((f) => f.hits.length).length} files (of ${perFile.length} scanned)`);
}
