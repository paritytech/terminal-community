/**
 * pUSD (shown as CASH) on Paseo Individuality (Next v2) testnet.
 *
 * Asset ID 50_000_413. Genesis metadata sets decimals=6, matching the runtime's
 * `UnderlyingAssetUnit = 10^4` (so $0.01 = 10^4 units, $1 = 10^6). The terminal
 * never reads the asset itself — the host settles coins — so these are the
 * amount scale and the id stamped on sale records and receipts.
 */

export const PUSD_ASSET_ID = BigInt(50_000_413);
export const PUSD_DECIMALS = 6;
export const PUSD_SYMBOL = "CASH";

/** pUSD-only display name. */
export function getAssetName(_assetId: string): string {
  return PUSD_SYMBOL;
}

/** pUSD has 6 decimals. */
export function getDecimalsForAsset(_assetId?: string): number {
  return PUSD_DECIMALS;
}
