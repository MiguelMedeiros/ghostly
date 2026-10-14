import { expect, it, vi } from "vitest";

// The Ark SDK, the USDT wallet's Ethereum libraries and Cashu's library are a megabyte of the app's first load: the
// engine reaches them once an Ark or USDT wallet starts, or the Cashu wallet first uses a mint or a token, not when it
// is loaded.
const evaluated = vi.hoisted(() => [] as string[]);
vi.mock("@arkade-os/sdk", (original) => { evaluated.push("@arkade-os/sdk"); return original(); });
vi.mock("ethers", (original) => { evaluated.push("ethers"); return original(); });
vi.mock("@tetherto/wdk-wallet-evm", (original) => { evaluated.push("@tetherto/wdk-wallet-evm"); return original(); });
vi.mock("@cashu/cashu-ts", (original) => { evaluated.push("@cashu/cashu-ts"); return original(); });

it("loads the engine without the Ark, USDT and Cashu wallets' libraries", async () => {
  await import("../src/engine/node");
  expect(evaluated).toEqual([]);
});
