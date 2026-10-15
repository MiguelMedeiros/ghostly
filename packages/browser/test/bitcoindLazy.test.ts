import { expect, it, vi } from "vitest";

// The Bitcoin Core source (Desktop only) and btc-signer's transaction code sit in the app's first load through the
// wallet provider list: the engine reaches them once a Bitcoin Core wallet connects, not when it is loaded.
const evaluated = vi.hoisted(() => [] as string[]);
vi.mock("../src/engine/paymentAdapters/providers/bitcoind", (original) => { evaluated.push("bitcoind"); return original(); });
vi.mock("@scure/btc-signer", (original) => { evaluated.push("@scure/btc-signer"); return original(); });

it("loads the engine without the Bitcoin Core source's client", async () => {
  await import("../src/engine/node");
  expect(evaluated).toEqual([]);
});
