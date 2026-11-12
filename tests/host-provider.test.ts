import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * lib/host/provider.ts picks the chain provider per runtime. On TrUAPI it
 * takes the SDK's host provider. A chain the host does not serve is
 * unavailable — the terminal never connects anywhere itself — and any other
 * failure means "ask again later", not a decision for the session.
 */

const sdk = vi.hoisted(() => {
  class ChainNotSupportedError extends Error {}
  return { getHostProvider: vi.fn(), ChainNotSupportedError };
});

vi.mock("@/lib/host/detect", () => ({
  isInHost: () => true,
  awaitHostRuntime: async () => "truapi",
}));
vi.mock("@/lib/host/sdk", () => ({ loadHostSdk: async () => sdk }));
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
  });

  it("reports a chain the host does not serve as unavailable, and opens nothing itself", async () => {
    const WebSocketSpy = vi.fn();
    vi.stubGlobal("WebSocket", WebSocketSpy);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    sdk.getHostProvider.mockRejectedValue(new sdk.ChainNotSupportedError("no"));
    const client = getPaseoAssetHubClient() as unknown as { connection: { send(m: unknown): void } };
    await vi.advanceTimersByTimeAsync(10);
    client.connection.send({ jsonrpc: "2.0", id: 1, method: "chainHead_v1_follow", params: [true] });
    await vi.advanceTimersByTimeAsync(10);
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/not served by the host/));
    expect(WebSocketSpy).not.toHaveBeenCalled();
    expect(sdk.getHostProvider).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("asks the host again after a failure that is not an answer", async () => {
    const host = fakeProvider();
    sdk.getHostProvider
      .mockRejectedValueOnce(new Error("Host rejected the chain-support check: timed out"))
      .mockResolvedValue(host.provider);
    getPaseoAssetHubClient();
    await vi.advanceTimersByTimeAsync(10);
    expect(host.provider).not.toHaveBeenCalled();

    // Paced retry, then the host answers.
    await vi.advanceTimersByTimeAsync(600);
    expect(sdk.getHostProvider).toHaveBeenCalledTimes(2);
    expect(host.provider).toHaveBeenCalledTimes(1);
  });
});
