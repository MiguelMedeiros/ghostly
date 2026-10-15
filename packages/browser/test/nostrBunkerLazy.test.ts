import { expect, it, vi } from "vitest";

// nostr-tools' NIP-46 signer and relay pool sit in the app's first load through the identity proof providers: the
// engine reaches them once a proof or a post is signed with a bunker, not when it is loaded.
const evaluated = vi.hoisted(() => [] as string[]);
vi.mock("nostr-tools/nip46", (original) => { evaluated.push("nostr-tools/nip46"); return original(); });
vi.mock("nostr-tools/pool", (original) => { evaluated.push("nostr-tools/pool"); return original(); });

it("loads the engine without the Nostr bunker's libraries", async () => {
  await import("../src/engine/node");
  expect(evaluated).toEqual([]);
});
