import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { createIdentity, type PkarrRequestOptions } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import type { IdentityLinkHost } from "../src/engine/identities";
// covers: proofs.revoke, core.relay-client

/**
 * The lookups of a contact's proofs for a revocation (one per proof it presents, and the engine's check at start and every
 * 12 h) are background reads: they give way to the chats' reads within the relay's minute. Asked in the foreground, about
 * 30 proofs kept from one contact took the minute from every other chat on the device.
 */
it("looks up a contact's proofs for a revocation as background reads", async () => {
  const asked: PkarrRequestOptions[] = [];
  const transport = {
    publish: vi.fn(async () => {}),
    resolve: vi.fn(async (_key: string, options?: PkarrRequestOptions) => { asked.push(options ?? {}); return null; }),
    describe: () => ({ protocol: "local fixture", relays: [] }),
  };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false });
  const host = (node as unknown as { identities: { host: IdentityLinkHost } }).identities.host;
  await host.resolve(createIdentity().pubKeyZ32);
  expect(asked).toEqual([expect.objectContaining({ background: true })]);
});
