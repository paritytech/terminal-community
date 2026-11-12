import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * lib/host/provider.ts picks the chain provider per runtime. On TrUAPI it
 * takes the SDK's host provider, falls back to a direct WebSocket only when
 * the host says it does not serve the chain, and treats any other failure as
 * "ask again later" rather than a decision for the session.
 */

const sdk = vi.hoisted(() => {
  class ChainNotSupportedError extends Error {}
  return { getHostProvider: vi.fn(), ChainNotSupportedError };
});
const ws = vi.hoisted(() => ({ getWsProvider: vi.fn() }));

vi.mock("@/lib/host/detect", () => ({
  isInHost: () => true,
  awaitHostRuntime: async () => "truapi",
  isProductWebSocketBlocked: () => false,
}));
vi.mock("@/lib/host/sdk", () => ({ loadHostSdk: async () => sdk }));
vi.mock("@polkadot-api/ws-provider", () => ws);
vi.mock("polkadot-api", () => ({
  // Connect straight away so the provider's resolution runs.
  createClient: (provider: (onMessage: (m: unknown) => void) => unknown) => ({
    connection: provider(() => {}),
    destroy: () => {},
  }),
}));

const { getPaseoAssetHubClient, resetClients, PASEO_ASSET_HUB_GENESIS } = await import("@/lib/host/provider");

/** A provider that records the connections made through it. */
function fakeProvider() {
  const connections: unknown[] = [];
  const provider = vi.fn(() => {
    const connection = { send: vi.fn(), disconnect: vi.fn() };
    connections.push(connection);
    return connection;
  });
  return { provider, connections };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  sdk.getHostProvider.mockReset();
  ws.getWsProvider.mockReset();
  resetClients();
});

afterEach(() => {
  resetClients();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the TrUAPI chain provider", () => {
  it("uses the host's provider when it serves the chain", async () => {
    const host = fakeProvider();
    sdk.getHostProvider.mockResolvedValue(host.provider);
    getPaseoAssetHubClient();
    await vi.advanceTimersByTimeAsync(10);
    expect(sdk.getHostProvider).toHaveBeenCalledWith(PASEO_ASSET_HUB_GENESIS);
    expect(host.provider).toHaveBeenCalledTimes(1);
    expect(ws.getWsProvider).not.toHaveBeenCalled();
  });

  it("goes direct only when the host says it does not serve the chain", async () => {
    const direct = fakeProvider();
    ws.getWsProvider.mockReturnValue(direct.provider);
    sdk.getHostProvider.mockRejectedValue(new sdk.ChainNotSupportedError("no"));
    getPaseoAssetHubClient();
    await vi.advanceTimersByTimeAsync(10);
    expect(direct.provider).toHaveBeenCalledTimes(1);
  });

  it("asks the host again after a failure that is not an answer", async () => {
    const host = fakeProvider();
    sdk.getHostProvider
      .mockRejectedValueOnce(new Error("Host rejected the chain-support check: timed out"))
      .mockResolvedValue(host.provider);
    getPaseoAssetHubClient();
    await vi.advanceTimersByTimeAsync(10);
    expect(host.provider).not.toHaveBeenCalled();
    expect(ws.getWsProvider).not.toHaveBeenCalled();

    // Paced retry, then the host answers.
    await vi.advanceTimersByTimeAsync(600);
    expect(sdk.getHostProvider).toHaveBeenCalledTimes(2);
    expect(host.provider).toHaveBeenCalledTimes(1);
    expect(ws.getWsProvider).not.toHaveBeenCalled();
  });
});
