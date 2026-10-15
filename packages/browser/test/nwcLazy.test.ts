import { expect, it, vi } from "vitest";

// The Nostr Wallet Connect client and its NIP-04/NIP-44 encryption sit in the app's first load through the wallet
// provider list: the engine reaches them once an NWC wallet connects, not when it is loaded.
const evaluated = vi.hoisted(() => [] as string[]);
vi.mock("../src/engine/paymentAdapters/providers/nwc", (original) => { evaluated.push("nwc"); return original(); });
vi.mock("nostr-tools/nip04", (original) => { evaluated.push("nostr-tools/nip04"); return original(); });
vi.mock("nostr-tools/nip44", (original) => { evaluated.push("nostr-tools/nip44"); return original(); });

it("loads the engine without the NWC wallet's client", async () => {
  await import("../src/engine/node");
  expect(evaluated).toEqual([]);
});
