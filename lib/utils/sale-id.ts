/**
 * Reading the ULID sale ids older sales carry.
 *
 * Sales recorded before checkout moved to coins through the host carry a ULID
 * (26 chars, Crockford Base32) whose first 10 characters encode the creation
 * time in milliseconds. Coins sales use the cheque's payment id instead, which
 * holds no time, so for those this returns null.
 */

/**
 * Validate ULID-based SaleId format
 * ULID is 26 characters using Crockford Base32 (excludes I, L, O, U to avoid confusion)
 */
export function isValidSaleId(saleId: string): boolean {
  // ULID uses Crockford Base32: 0-9 and A-Z excluding I, L, O, U
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(saleId);
}

/**
 * Extract timestamp from ULID
 * First 10 characters of ULID encode the timestamp in milliseconds
 */
export function getTimestampFromSaleId(saleId: string): Date | null {
  if (!isValidSaleId(saleId)) {
    return null;
  }

  // Crockford Base32 decoding table
  const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

  // Decode first 10 characters (timestamp portion)
  let timestamp = 0;
  for (let i = 0; i < 10; i++) {
    const charIndex = ENCODING.indexOf(saleId[i]);
    if (charIndex === -1) return null;
    timestamp = timestamp * 32 + charIndex;
  }

  return new Date(timestamp);
}
