# Polkadot design system — gap register

Screens are being moved onto the Polkadot semantic tokens (`theme/`, see
`README.md` → Design system) one at a time. Wherever the token set had nothing
for a role this app needs, the closest *semantic* token stands in (never a raw
value, never a `--palette-*` reference) and the gap is recorded here so design
can add the token upstream. When a token lands, swap the stand-in and delete
the row.

## Migrated

| Screen / component | Status |
| --- | --- |
| Check out — `app/(shell)/terminal/page.tsx` (keypad, items mode, QR, completed, share, receipt) | done |
| App shell — `app/(shell)/layout.tsx`, `components/bottom-nav.tsx` | done |
| Shared — `components/screen-header.tsx`, `components/amount-hero.tsx` | done (also used by Home / History) |
| Splash — `app/page.tsx` | done |
| Root — `app/layout.tsx`, `app/globals.css` | done |
| Settings — `app/(shell)/settings/page.tsx` (menu + Appearance) | done |
| Home — `app/(shell)/home/page.tsx` (tiles) | done |
| History — `app/(shell)/history/page.tsx` (list, detail, receipt, share QR) | done |
| Home → Sales — `app/(shell)/home/sales/page.tsx` (stat cards, chart, tabs) | done |
| Home → Export CSV — `app/(shell)/home/export/page.tsx` (chips, calendar sheet, preview) | done |
| Settings → Details, Payment Method, Help us fix an issue | done |
| Global error boundary — `app/global-error.tsx` (own `<html>`, same fonts/theme bootstrap) | done |
| Report job toast — `lib/components/report-job-provider.tsx` | done |
| Shared — `components/subpage-header.tsx` (back/close + title + 40px action slot, `iconButtonClass`) | done |

That is the whole R1-visible surface (Become a Merchant is off by flag). Still
on stock literals: the merchant-gated screens (merchant onboarding,
home/reports/*, settings/items, receipt, merchant-profile, legacy items+tips,
daily-reports) and the URL-only legacy settings pages (backup, encryption,
export, wallet, onchain, logs), plus `components/report-row.tsx`.

Everything else still carries stock Tailwind literals. Because the theme bundle
deletes the stock colour, radius and weight namespaces, un-migrated screens
render flat until they are migrated (text falls back to `fg-primary`, fills to
the page surface, `rounded-2xl/3xl` and `font-bold` emit nothing). Rank them
with `npm run check:tokens`.

## Theme selection

Inside the Polkadot app the theme follows the host by default: `lib/host/theme.ts`
subscribes to `host_theme_subscribe` and `lib/components/host-theme-sync.tsx`
maps the `variant` (Light / Dark) onto Berlin Day / Berlin Night. Settings →
Appearance (a shadcn `Select`, per the system — never a row of theme buttons)
offers "Follow Polkadot app" plus the five themes; a manual pick overrides the
host until the merchant switches back. The tie-break and persistence live in
`lib/config/appearance.ts`; the applied theme always goes through `setTheme`,
so the anti-flash script replays it on the next launch. The host's `Custom`
theme names have no counterpart yet — Lisbon, Malta and Tokyo are light-only
and no host id maps to them — so a `Custom` theme is honoured by its variant
alone. **Gap for design:** decide which host theme ids (if any) should select
a tonal theme.

## Token gaps (Check out screen)

| # | Role needed | Stand-in used | Where |
| --- | --- | --- | --- |
| 1 | **Informational status fill** — the "awaiting payment" banner was brand blue (`#4353ff`). Only success / warning / error status fills exist. | `bg-surface-container-inverted` + `text-fg-primary-inverted` | QR banner once scannable |
| 2 | **Warning tint** (soft warning surface for a chip) — only the error tint (`bg-action-error`) exists. | `bg-surface-nested` + `text-fg-warning` + a `bg-status-warning` dot | partial-payment chip on the QR screen |
| 3 | **Success tint** — same as above for success. | `bg-surface-nested` + `text-fg-success` | "Sent to printer" feedback line |
| 4 | **24px type step** — keypad digits were 24px; the named styles jump from `heading-l` (20) to `display-l` (32). | `text-display-l font-mono font-medium` (32px) | keypad keys |
| 5 | **Destructive button text** — stock shadcn `destructive` uses `text-white`, which the bundle deletes; the role map's `--fg-primary-inverted` is dark on red on Berlin Night. | `text-fg-static-white` passed at the call site | Cancel / Clear-all buttons |
| 6 | **`theme-color` meta** — a `<meta>` cannot read a token, and the surface now changes per theme. | removed from `app/layout.tsx`; `public/manifest.json` still carries `#0f172a` | PWA chrome colour |
| 7 | **Brand wordmark face** — "T3RMINAL" was set in Unbounded, not one of the three system faces. Unbounded is no longer loaded anywhere (removed from `app/layout.tsx` and `app/globals.css`). If the wordmark must keep a bespoke face, that is a logo asset (SVG), not a type style. | `text-display-xl` (Manrope) | splash |
| 8 | **Focus ring contrast** — known upstream gap (1.55–1.78:1, below WCAG 3:1). | none — do not paper over locally | every focusable control |

## Token gaps (Home, History, Sales, Export CSV, Settings subpages)

| # | Role needed | Stand-in used | Where |
| --- | --- | --- | --- |
| 9 | **Brand accent tile fill** — the Home tiles were brand blue (`#4353ff`). The system has no chromatic accent unless asked for (`bg-accent-blue` is opt-in). | `bg-surface-container` + `shadow-1` on every tile | Home tiles |
| 10 | **Chart palette** — the bar chart had a blue "current" bar and grey rest; the token set has no data-viz colours (upstream gap `no-chart-palette`). | `bg-illustration-dark` (current bucket) / `bg-illustration-dark-muted` (rest) | Sales chart |
| 11 | **Success tint disc** — History rows had a dark-green disc behind the "received" arrow. No success tint exists. | icon only, `text-fg-success`, in a 44px box | History list rows |
| 12 | **Selected-day range fill** in the calendar was a neutral tint; `bg-surface-nested` is used, which on the four light themes only reads because the sheet is a container. | `bg-surface-nested` inside `bg-surface-container` | Export CSV calendar |
| 13 | **Refunds indicator** was orange; only success / warning / error status colours exist. | `bg-status-warning` dot | Sales "Refunds" card |

## Copy flagged (not rewritten)

| Text | Where | Issue | Proposed |
| --- | --- | --- | --- |
| "Thanks! for your feedback we'll look into it" | Report a problem, success | punctuation splits the sentence | "Thanks for your feedback — we'll look into it." |
| "Type Transaction ID" (search placeholder) | History | asks a person for a machine identifier; the list is searched by order number | "Search by order number" |
| "Payment Record #XXXX" / "Record #XXXX" | Check out receipt, History receipt | raw id fragment as a title (see rule table above) | "Receipt · Order NN" once a sequential order number exists |

## Rule violations kept for a product decision (not styling)

| Pattern | Rule | Where | Proposed fix |
| --- | --- | --- | --- |
| "Do you want to cancel this transaction?" modal | Act, then offer undo — no confirmation dialogs | QR screen, Cancel Transaction | cancel immediately, toast with **Undo** that re-arms the same amount for ~8 s |
| "All N items will be removed" sheet | same | items-mode basket, Clear cart | clear immediately, toast with **Undo** restoring the basket |
| `Order #<last 4 of saleId>` | Never show a raw identifier; truncation is not a fix | completed / share / receipt screens, History | a per-day sequential order number stored on the sale |
| Raw addresses (`FROM:` / `TO:`) | same | HTML fallback receipt (only when the SVG receipt is missing) | show the business name; addresses behind a details toggle |
| `coinage.error` shown verbatim | Copy: no technical language in user-facing text | QR screen, coins method | map known errors to plain sentences |

## Seam notes

- `npx shadcn add` writes `import { cn } from "cn"` and installs an unrelated
  `cn` package. The package is removed; the bare specifier is aliased to
  `lib/cn.ts` in `tsconfig.json` (`paths`) and `next.config.ts`
  (`turbopack.resolveAlias`). Re-check after every `shadcn add`.
- Fonts are self-hosted with `next/font`; `app/globals.css` points the theme's
  `--scale-font-family-*` primitives at those variables (the one place app code
  names a `--scale-*`), so the terminal works offline.
- The receipt SVG (`lib/receipts/receipt-generator.ts`) paints its own paper
  and ink in hex — it is the printed document, out of the token system by
  design. The on-screen wrapper only clips its corners.
