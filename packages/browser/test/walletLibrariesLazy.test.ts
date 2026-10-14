import { expect, it, vi } from "vitest";

// The Ark SDK and the USDT wallet's Ethereum libraries are a megabyte of the app's first load: the engine reaches them
// once an Ark or USDT wallet starts, not when it is loaded.
const evaluated = vi.hoisted(() => [] as string[]);
vi.mock("@arkade-os/sdk", (original) => { evaluated.push("@arkade-os/sdk"); return original(); });
vi.mock("ethers", (original) => { evaluated.push("ethers"); return original(); });
vi.mock("@tetherto/wdk-wallet-evm", (original) => { evaluated.push("@tetherto/wdk-wallet-evm"); return original(); });

it("loads the engine without the Ark and USDT wallets' libraries", async () => {
  await import("../src/engine/node");
  expect(evaluated).toEqual([]);
});
