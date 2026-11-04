import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { createIdentity, type GroupSession } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import type { StoredLink } from "../src/shared/types";

/**
 * Every engine state shows each group member's edge (`members[].edge`). A member's edge is found by its key, not by
 * walking every link of the engine once per member: with ten groups of 32 that was 310 walks of 315 links per state,
 * and the communities' members (who have no edge) walked them too.
 */

interface Inner { links: Map<string, { stored: StoredLink }>; groups: { sessions: Map<string, GroupSession> } }

let node: GhostlyNode | undefined;
afterEach(async () => { await node?.shutdown(); node = undefined; });

it("a state finds the members' edges with the same passes over the links however many members there are", async () => {
  await db.putSettings({ online: false, nick: "Admin", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() } as never, { transport, automaticWallets: false, nativeTransports: {} });
  await node.start();
  const inner = node as unknown as Inner;
  const { groupId } = await node.createGroup({ name: "Ghosts", profile: "mesh" });
  const session = inner.groups.sessions.get(groupId)!;
  const edgeOf = (key: string) => [...inner.links.values()].find(live => live.stored.group === groupId && live.stored.groupPeer === key && !live.stored.groupEntry);
  const admit = async (count: number) => {
    for (let i = 0; i < count; i++) {
      const key = createIdentity().pubKeyZ32;
      await session.admit(key);
      await vi.waitFor(() => expect(edgeOf(key)).toBeDefined(), { timeout: 10_000 });
    }
  };

  // How many times one state walks the engine's links.
  const values = inner.links.values.bind(inner.links);
  let walks = 0;
  inner.links.values = () => { walks++; return values(); };
  const walksPerState = () => { walks = 0; node!.getState(); return walks; };

  await admit(2);
  const few = walksPerState();
  await admit(6);
  const many = walksPerState();

  // Each member still shows its own edge.
  const group = node.getState().groups.find(g => g.id === groupId)!;
  const others = group.members.filter(m => !m.me);
  expect(others).toHaveLength(8);
  for (const member of others) expect(member.edge?.linkId).toBe(edgeOf(member.key)!.stored.id);
  expect(many).toBe(few);
}, 60_000);
