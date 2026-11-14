import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import type { EngineState, GroupView, StoredLink, WakeSubscription } from "../src/shared/types";

// covers: push.wake.group

const nodes: GhostlyNode[] = [];
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); });

function live(row: StoredLink) {
  return { stored: row, myPubKeyZ32: "me", link: null as never, status: "online", dataLink: "closed",
    presence: { online: false, lastPacketAt: 0, services: null }, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
    poll: { polling: false, nextAt: 0, interval: 0 }, files: { receivedBytes: 0, wireIds: new Set(), incoming: new Map() } };
}

/** An engine with `groups` private groups of two members, each edge holding the member's wake-up token. */
function engineWith(groups: number) {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
  nodes.push(node);
  const seed = createIdentity().seedB64, base = { profile: "paired-chat/1", createdAt: 1, seedB64: seed, encKeyB64: seed, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: seed } as const;
  const views: GroupView[] = [];
  for (let g = 0; g < groups; g++) {
    const id = `group-${g}`;
    for (const key of ["b", "c"]) {
      const row = { ...base, id: `edge-${g}-${key}`, label: "", group: id, groupPeer: `${key}${g}`, wakeToken: `token-${g}-${key}` } as StoredLink;
      node["links"].set(row.id, live(row) as never);
    }
    views.push({ id, profile: "mesh", name: id, createdAt: 1, lastMessageAt: 0, isAdmin: true, canSend: true, invited: [], memberLinks: {}, members: [] } as unknown as GroupView);
  }
  node["groups"].views = () => views;
  node["groups"].isCommunityGroup = () => false;
  node["settings"] = { ...node["settings"], wake: { endpoint: "https://push.invalid/x", keys: { p256dh: "a", auth: "b" } } as unknown as WakeSubscription };
  return node;
}

/** How many times one pushed state walks the engine's links, and the state. */
function walks(node: GhostlyNode): { walks: number; state: EngineState } {
  const links = node["links"], values = links.values.bind(links);
  let walks = 0;
  const spy = vi.spyOn(links, "values").mockImplementation(() => { walks++; return values(); });
  try {
    const state = node["pushedState"]();
    return { walks, state };
  } finally { spy.mockRestore(); }
}

describe("a pushed state with wake-up push on", () => {
  it("walks the links as often with 20 private groups as with 2, and gives each group its edges' tokens", () => {
    const few = walks(engineWith(2)), many = walks(engineWith(20));
    expect(many.walks).toBe(few.walks);
    const groups = many.state.groups;
    expect(groups).toHaveLength(20);
    for (const [g, group] of groups.entries()) expect(group.wakeTokens).toEqual([`token-${g}-b`, `token-${g}-c`]);
  });
});
