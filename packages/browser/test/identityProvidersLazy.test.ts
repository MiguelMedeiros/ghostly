import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import type { IdentityLinkHost } from "../src/engine/identities";

// The identity proof providers (Nostr, Pubky, a domain, OpenPGP, Bitcoin, SSH, OpenID Connect, DID, AT Protocol) and
// their libraries sat in the app's first load through the engine: it loads them with the profile's proofs instead.
const evaluated = vi.hoisted(() => [] as string[]);
vi.mock("../src/proofs/registry", (original) => { evaluated.push("registry"); return original(); });
vi.mock("../src/proofs/providers/did", (original) => { evaluated.push("providers/did"); return original(); });

it("loads the engine without the identity proof providers", async () => {
  await import("../src/engine/node");
  expect(evaluated).toEqual([]);
});

it("loads them with the profile's proofs", async () => {
  const { IdentityProofs } = await import("../src/engine/identities");
  const proofs = new IdentityProofs({ online: () => true } as IdentityLinkHost);
  expect(evaluated).toEqual([]);
  await proofs.load();
  expect(evaluated).toContain("registry");
  expect(() => proofs.begin({ provider: "nostr", subject: "not a key" })).toThrow();
  expect(() => proofs.begin({ provider: "nostr", subject: "not a key" })).not.toThrow(/Unknown kind/);
});
