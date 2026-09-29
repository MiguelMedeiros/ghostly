import { describe, expect, it } from "vitest";
import { networkReason } from "../src/engine/paymentAdapters/networkReason";
import { createFailure } from "../src/engine/paymentAdapters/walletInstances";
// covers: wallet.instances.first-run, wallet.instances.create

const named = (name: string, message: string) => Object.assign(new Error(message), { name });

describe("a wallet that could not be made says why in a person's words", () => {
  it("a request given up or timed out did not answer in time, whatever the browser calls it", () => {
    for (const error of [named("AbortError", "Fetch is aborted"), named("TimeoutError", "signal timed out"), new Error("This operation was aborted")])
      expect(networkReason(error, "rpc.example")).toBe("rpc.example did not answer in time");
    expect(networkReason(named("AbortError", "Fetch is aborted"))).toBe("The network did not answer in time");
  });

  it("a request that never left could not reach it", () => {
    for (const error of [new TypeError("Failed to fetch"), new TypeError("Load failed"), new TypeError("NetworkError when attempting to fetch resource.")])
      expect(networkReason(error, "rpc.example")).toBe("Could not reach rpc.example");
  });

  it("anything else keeps its own words", () => {
    expect(networkReason(new Error("Could not reach testnut.cashu.space."))).toBeNull();
    expect(networkReason(new Error("RPC chain does not match this wallet"))).toBeNull();
  });

  it("a first setup's failure reads as a sentence, not as the browser's words", () => {
    expect(createFailure("Testnet USDT", named("AbortError", "Fetch is aborted")))
      .toBe("Could not create the Testnet USDT wallet: The network did not answer in time. Nothing was saved; try again.");
    expect(createFailure("Testnet USDT", new Error("ethereum-sepolia-rpc.publicnode.com did not answer in time")))
      .toBe("Could not create the Testnet USDT wallet: ethereum-sepolia-rpc.publicnode.com did not answer in time. Nothing was saved; try again.");
  });
});
