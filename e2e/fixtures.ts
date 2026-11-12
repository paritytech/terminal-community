import { test as base } from '@playwright/test';
import {
  createTestHostFixture,
  PASEO_ASSET_HUB,
  type TestHost,
} from '@parity/host-api-test-sdk/playwright';

// ── Target selection via E2E_TARGET env var ──────────────────────────
// Default: Paseo Asset Hub testnet

const PRODUCT_URL = 'http://localhost:5199';

// ── Fixtures ────────────────────────────────────────────────────────

/** Bob fixture — merchant account (generates QR, receives payments) */
const bobFixture = createTestHostFixture({
  productUrl: PRODUCT_URL,
  accounts: ['bob'],
  networks: [PASEO_ASSET_HUB],
});

/** Charlie fixture — customer account (pays via /pay page) */
const charlieFixture = createTestHostFixture({
  productUrl: PRODUCT_URL,
  accounts: ['charlie'],
  networks: [PASEO_ASSET_HUB],
});

/** Multi-account fixture — Bob (merchant, default) + Charlie (customer, switchable) */
const bobCharlieFixture = createTestHostFixture({
  productUrl: PRODUCT_URL,
  accounts: ['bob', 'charlie'],
  networks: [PASEO_ASSET_HUB],
});

/** Merchant test — Bob */
export const merchantTest = base.extend<{ testHost: TestHost }>(bobFixture);

/** Customer test — Charlie */
export const customerTest = base.extend<{ testHost: TestHost }>(charlieFixture);

/** Merchant+Customer test — starts as Bob, can switchAccount('charlie') */
export const merchantCustomerTest = base.extend<{ testHost: TestHost }>(bobCharlieFixture);

export { expect } from '@playwright/test';
