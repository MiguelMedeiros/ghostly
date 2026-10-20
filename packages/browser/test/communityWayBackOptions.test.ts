import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { createIdentity, type PkarrRequestOptions } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import type { GroupsHost } from "../src/engine/groups";
// covers: groups.protocol.community-topology, core.relay-client

/**
 * A community member's way back (`Communities.wayBack`: its beacon reading and its request in a hub's lobby while it has
 * no edge up) reaches the relays as a way back (`back`), within its own allowance. Asked as a group edge's signaling, the
 * edges of a web app's 15 groups, all offering at once after it opened, spent that allowance in its first second, and
 * its 5 communities read their beacon a minute later or not at all (bug hunt, 2026-10-14).
 */
it("asks the relays for a community member's way back as one, not as an edge's signaling", async () => {
  const asked: PkarrRequestOptions[] = [];
  const transport = {
    publish: vi.fn(async (_identity: unknown, _records: unknown, options?: PkarrRequestOptions) => { asked.push(options ?? {}); }),
    resolve: vi.fn(async (_key: string, options?: PkarrRequestOptions) => { asked.push(options ?? {}); return null; }),
    describe: () => ({ protocol: "local fixture", relays: [] }),
  };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false });
  const host = (node as unknown as { groups: { host: GroupsHost } }).groups.host;
  const lobby = createIdentity();
  await host.resolve(createIdentity().pubKeyZ32, false, false, true);
  await host.publish(lobby, [], false, false, true);
  for (const options of asked) {
    expect(options).toMatchObject({ group: true, back: true });
    expect(options.signal).toBeFalsy();
  }
  expect(asked).toHaveLength(2);
});
