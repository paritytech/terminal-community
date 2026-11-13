# E2E tests

```bash
npm run test:e2e                         # whole suite (starts next dev on :5199 if none is running)
npx playwright test e2e/payments         # one folder
npx playwright test e2e/payments/coins-happy.spec.ts --headed
```

## The test host

The Terminal runs inside a Polkadot host app, so every spec runs it inside our own
test host (`e2e/host/`), built on `@novasamatech/host-container` 0.12.0 — the same
container the phones' release builds run. It plays both the phone and the customer:

- **phone:** account, theme, host storage, entropy, permissions, preimages, the
  statement store, balance, `paymentTopUp` and its status subscription;
- **customer:** `e2e/host/payer.ts` reads the cheque request from the QR
  (`data-qr-value`, or decoded from the image with zxing) and sends an encrypted
  cheque, exactly as the customer's app does. `tests/e2e-payer.test.ts` keeps it in
  lock-step with the app's decrypt side.

No chain is served and the app opens no connection of its own, so the run is
hermetic and tests run in parallel. The TrUAPI runtime is not covered here (its
test host has no payments); it is covered by `tests/host-payments.test.ts` and on
devices.

## Writing a spec

```ts
import { test, expect } from "../host/fixture";
import { bootTerminal, chargeAndPay, waitForSale } from "../host/flows";

test.use({ hostOptions: { topUpScript: "manual" } }); // modes apply before the app loads

test("a coins sale", async ({ host }) => {
  const frame = await bootTerminal(host);
  const { req, topUp } = await chargeAndPay(host, frame, "12.50");
  await host.emitTopUpStatus(topUp.idHex, { tag: "Claimed", finalized: false });
  await expect(frame.locator('[data-testid="payment-completed"]')).toBeVisible();
  await waitForSale(host, req.id);
});
```

- `hostOptions` (see `HostConfig` in `e2e/host/protocol.ts`): `balanceMode`,
  `accountGetMode`, `entropyMode`, `storageMode`, `storage` seeds, `topUpScript`,
  `theme`, `initialPath`, `legacyAccounts`.
- `host` (`T3Host` in `e2e/host/fixture.ts`) drives the host at run time and records
  every host call as an event: `host.next(type, where, { since })`, `host.all(type)`,
  `host.mark()`. Assert both the screen and what the app asked of the host.
- `host.restartProduct(path)` reloads the app while the host keeps its state, like an
  app restart on a phone.
- Known app bugs are pinned with `test.fail()` and a comment naming the bug: the test
  asserts the correct behaviour and starts failing the day the bug is fixed.
