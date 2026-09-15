> [!WARNING]
> The following is a prototype, reference implementation, and proof-of-concept.
> This open source code is provided for research, experimentation, and developer
> education only. This code has not been audited, is actively experimental, and
> may contain bugs, vulnerabilities, or incomplete features. Use at your own risk.

# T3RMINAL

_Experimental proof-of-concept code developed and published by Parity Technologies._

A static Next.js app published to a `.dot` domain, backed by a pallet-revive
contract on an Asset Hub-style chain, with metadata stored on the Polkadot
Bulletin chain.

## Develop

```sh
npm install
npm run dev          # next dev
npm run build        # static export to out/
npm test             # vitest
npm run test:e2e     # playwright
```

Copy [.env.example](.env.example) to `.env.local` and fill in the values before
running against a live chain.

## Design system

Screens use the Polkadot design system: the theme bundle lives in `theme/`
(copied from the `polkadot-design-system` skill; only `theme/base.css` and
`theme/theme.ts` are meant to be edited by hand) and is imported once from
`app/globals.css`. App code writes semantic tokens only — `text-fg-*`,
`bg-surface-*` / `bg-action-*` / `bg-status-*`, `border-stroke-*`,
`rounded-container|nested|medium|small`, `shadow-1|2|3` and the fourteen named
type styles (`text-display-l`, `text-label-m`, `text-body-m`, …). Stock
Tailwind colours, radii and weights are removed by the bundle. shadcn
components in `components/ui` are installed with `npx shadcn add`, never
hand-edited.

```sh
npm run check:tokens                      # rank screens by remaining literals
npm run check:tokens -- app/page.tsx      # list every literal in a file; exits 1 if any
```

Screens are migrated one at a time; what the token set cannot express is
recorded in `docs-internal/design-system-gaps.md` rather than faked.

Theme selection follows the Polkadot app by default: `lib/components/host-theme-sync.tsx`
subscribes to the host's theme (`host_theme_subscribe`) and maps Light/Dark to
Berlin Day/Night at runtime — one `data-theme` attribute, no reload. Settings →
Appearance lets the merchant pick any of the five themes instead; that choice
wins over the host until they switch back to "Follow Polkadot app"
(`lib/config/appearance.ts`). Outside a host the default applies (Berlin Day,
following the OS to Berlin Night).

## Feature flags

UI features that are built but parked for the current release are gated by
build-time constants in `lib/config/features.ts`. Flip the default there, or
set the matching `NEXT_PUBLIC_FEATURE_*` variable for a single build:

```sh
NEXT_PUBLIC_FEATURE_BECOME_MERCHANT=1 npm run build
```

| Flag | Env var | Default | Gates |
| --- | --- | --- | --- |
| `becomeMerchant` | `NEXT_PUBLIC_FEATURE_BECOME_MERCHANT` | off | "Become a Merchant" entry points (Home tile, Settings card) |
| `nfcTapToPay` | `NEXT_PUBLIC_FEATURE_NFC_TAP_TO_PAY` | off | NFC tap-to-pay on the payment QR screen (HCE emit + banner text) |
| `receipts` | `NEXT_PUBLIC_FEATURE_RECEIPTS` | off | Review / Print / Share-via-QR receipt actions after a sale and in History |
| `refunds` | `NEXT_PUBLIC_FEATURE_REFUNDS` | off | Refund entry points after a sale and in History |

The values are inlined by the static export, so a flag can't change at
runtime — rebuild to toggle.

## Deploy

`npm run deploy` is an interactive command that generates or imports a wallet,
deploys a fresh `T3rminalBulletinIndex` contract (PAPI / pallet-revive), builds
the static export, and publishes it to a `.dot` domain.

```sh
npm run deploy
```

Contract-only (non-interactive), useful for CI or re-deploys:

```sh
DEPLOYER_SEED="<deployer mnemonic>" npm run deploy:contract -- --env <env-name>
```

Anyone may fork this repository and run these steps to deploy their own
independent instance. Parity does not operate, host, or endorse any downstream
deployment.

## License

Licensed under [GPL-3.0](LICENSE). Solidity contracts under `contracts/` are
licensed under MIT (see their SPDX headers).

## Security

This is a reference proof-of-concept, **not a hardened production build**. Before
deploying it for any real use case, you are responsible for:

- Reviewing the code yourself.
- Checking that dependencies are up to date and free of known vulnerabilities.
- Securing your own fork or deployment environment (keys, secrets, network
  configuration).
- Tracking the latest tagged release / commits for security fixes — older
  releases are not backported (exceptions might apply).

For Parity's security disclosure process and Bug Bounty program, see
[parity.io/bug-bounty](https://parity.io/bug-bounty).
