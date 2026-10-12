import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GROUP_LIMITS, type GroupMessageFrame } from "@ghostly/core";
import { EngineServer } from "../src/engine/server";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { EngineEvent, RpcResponse } from "../src/shared/rpc";
import type { StoredMessage } from "../src/shared/types";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.catch-up

/**
 * A private group's message from another member is stored with the frame it came in (`StoredMessage.frame`): the
 * group's newest rows hold what is handed on to a member who was away, one small write per message. The frame is the
 * engine's: no page gets it.
 */

async function meshOf(names: string[]): Promise<{ world: CommunityWorld; peers: Peer[]; id: string }> {
  const world = new CommunityWorld();
  const [admin, ...rest] = names.map(name => world.add(name));
  const id = await admin.groups.create("Frames", "mesh");
  const link = await admin.groups.enableLink(id);
  for (const p of rest) await p.groups.joinByLink(link);
  const peers = [admin, ...rest];
  await world.until(() => peers.every(p => world.view(p, id)?.members.length === peers.length && world.view(p, id)!.members.every(m => m.online)), 20 * 60_000, 1000);
  return { world, peers, id };
}
const said = (peer: Peer, id: string) => peer.messages.filter(m => m.linkId === `group:${id}` && !m.event);

describe("a private group's message keeps the frame it came in", { timeout: 120_000 }, () => {
  it("on the row of whoever received it, not on its author's", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob"]);
    const [alice, bob] = peers;
    await alice.groups.send(id, "hello");
    await world.settle();
    const row = said(bob, id).find(m => m.text === "hello")!;
    expect(row.frame).toMatchObject({ t: "group-msg", g: id, s: world.view(alice, id)!.myKey, n: 0 });
    // Sealed and signed by its author: what another member takes as the message itself.
    expect(row.id).toBe(`${row.frame!.s}:${row.frame!.e}:${row.frame!.n}`);
    expect(row.frame!.c).not.toContain("hello");
    expect(said(alice, id).find(m => m.text === "hello")!.frame).toBeUndefined();
  });

  it("only on the newest rows: past the frames a member keeps to hand on, the oldest row gives its own up", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob"]);
    const [alice, bob] = peers;
    const extra = 5;
    for (let i = 0; i < GROUP_LIMITS.relay + extra; i++) await alice.groups.send(id, `line ${i}`);
    await world.settle();
    const rows = said(bob, id).filter(m => m.text.startsWith("line "));
    expect(rows).toHaveLength(GROUP_LIMITS.relay + extra);
    expect(rows.filter(m => m.frame).map(m => m.text)).toEqual(rows.slice(extra).map(m => m.text));
    // After the app starts again the line is the same one: the next message takes the next oldest row's place.
    await world.restart(bob);
    await world.run(3_000);
    await alice.groups.send(id, "one more");
    await world.settle();
    const after = said(bob, id).filter(m => m.frame);
    expect(after).toHaveLength(GROUP_LIMITS.relay);
    expect(after[0].text).toBe(`line ${extra + 1}`);
    expect(after[after.length - 1].text).toBe("one more");
  });

  it("and long ones give way by their bytes, before their count", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob"]);
    const [alice, bob] = peers;
    // Sixteen messages of 12 KiB sealed are more than the bytes kept.
    for (let i = 0; i < 16; i++) await alice.groups.send(id, `${i} ${"x".repeat(12 * 1024)}`);
    await world.settle();
    const held = said(bob, id).filter(m => m.frame);
    expect(held.length).toBeLessThan(16);
    expect(held.length).toBeGreaterThan(8);
    expect(held.reduce((sum, m) => sum + m.frame!.c.length, 0)).toBeLessThanOrEqual(GROUP_LIMITS.relayBytes);
    expect(held[held.length - 1].text.startsWith("15 ")).toBe(true);
  });
});

describe("a page never gets a row's frame", () => {
  const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
  const servers: EngineServer[] = [];
  beforeEach(async () => {
    await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
    await transact([STORES.links, STORES.messages, STORES.groups], (s) => { for (const n of [STORES.links, STORES.messages, STORES.groups]) s[n].clear(); });
  });
  afterEach(async () => { for (const server of servers.splice(0)) await server.node.shutdown(); });

  it("in a history, a page of it, one message, or what changed", async () => {
    const server = new EngineServer({ automaticWallets: false, transport: fixture });
    servers.push(server);
    await server.ready;
    const got: StoredMessage[] = [];
    server.attach({ post(event: EngineEvent | RpcResponse) { if (event.kind === "messages" || event.kind === "message-changes") got.push(...event.messages); } });
    const node = server.node;
    const { groupId } = await node.createGroup({ name: "Frames", profile: "mesh" });
    const linkId = `group:${groupId}`;
    const frame = { t: "group-msg", g: groupId, e: 0, s: "m", n: 0, ts: 1, nn: "nn", c: "sealed", sig: "sig" } as GroupMessageFrame;
    await node["storeMessage"]({ linkId, id: "m:0:0", text: "hello", sender: "peer", member: "m", timestamp: Date.now(), via: "datalink", frame });
    // The engine's store has it.
    expect((await db.getMessage(linkId, "m:0:0"))!.frame).toEqual(frame);
    await expect.poll(() => got.some(m => m.id === "m:0:0")).toBe(true);
    const seen = [...got, ...(await node.getMessages(linkId)), ...(await node.groupMessages({ groupId })), ...(await node.messagePage({ linkId })).messages, (await node.getMessage(linkId, "m:0:0"))!];
    expect(seen.filter(m => m.id === "m:0:0").length).toBeGreaterThanOrEqual(5);
    for (const m of seen) expect("frame" in m).toBe(false);
  });
});
