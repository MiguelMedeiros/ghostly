import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineServer } from "../src/engine/server";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { EngineEvent, RpcResponse } from "../src/shared/rpc";
import type { StoredMessage } from "../src/shared/types";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: app.attention.sounds, groups.community.send

/**
 * A community member whose device clock runs over a minute behind is heard: its live line and its mention of me ring,
 * as a private group's member's do (#2678 covered those only). A member's messages in a community come
 * through a hub, and nothing said whether the hub passed one on as it came: the app never told that member's clock,
 * and read 90 s behind as a late catch-up, quiet. A hub now marks what it passes on at once as it came (WISP 903
 * § Relaying, revision 2026-11-03). On headless engines (`CommunityWorld`), Dave's rows stored by a real engine, which
 * says what rings; Bob and Dave never share an edge, so Bob's lines reach Dave through a hub.
 */
const MINUTE = 60_000;
const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
const servers: EngineServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.node.shutdown();
  vi.restoreAllMocks();
});

/** Admin and Carol (the hubs), Dave (whose app says what rings), Bob (his clock `bobClock` from everyone's). */
async function community(bobClock: number) {
  const world = new CommunityWorld();
  vi.spyOn(Date, "now").mockImplementation(() => world.now);
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await transact([STORES.links, STORES.messages, STORES.groups], (s) => { for (const n of [STORES.links, STORES.messages, STORES.groups]) s[n].clear(); });
  const server = new EngineServer({ automaticWallets: false, transport: fixture });
  servers.push(server);
  await server.ready;
  const heard: { id: string; mention: boolean }[] = [];
  server.attach({ post(event: EngineEvent | RpcResponse) { if (event.kind === "attention" && event.event.type === "message") heard.push({ id: event.event.id, mention: !!event.event.mention }); } });
  const node = server.node as unknown as { storeNewMessage(m: StoredMessage, live?: boolean): Promise<boolean> };
  // Dave's rows go through the engine, as the app stores them: it decides what rings.
  const daveRows = (peer: Peer) => ({
    storeMessage: async (message: StoredMessage, live?: boolean) => {
      if (peer.messages.some(m => m.id === message.id)) return false;
      peer.messages.push(message);
      return message.sender === "peer" && !message.event ? node.storeNewMessage({ ...message }, live) : true;
    },
  });
  const admin = world.add("admin", undefined, { staysOnline: true });
  const id = await admin.groups.create("Clocks");
  const link = await admin.groups.enableLink(id);
  await world.run(MINUTE);
  const carol = world.add("carol", undefined, { staysOnline: true });
  const dave = world.add("dave", daveRows);
  const bob = world.add("bob", undefined, { clock: bobClock });
  // Bob and Dave never share an edge: what one says reaches the other through a hub.
  world.cut = (a, b) => (a === bob && b === dave) || (a === dave && b === bob);
  for (const p of [carol, dave, bob]) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 5 * MINUTE, 500); }
  const all = [admin, carol, dave, bob];
  await world.until(() => all.every(p => (world.view(p, id)?.community?.connected ?? 0) > 0), 5 * MINUTE, 1000);
  await world.run(MINUTE);
  const daveKey = world.view(dave, id)!.members.find(m => m.me)!.key;
  const say = async (p: Peer, text: string, mention = false) => {
    const sent = await p.groups.send(id, text, mention ? [{ k: daveKey, o: 0, l: 5 }] : []);
    expect(sent.error).toBeNull();
    await world.until(() => world.texts(dave, id).includes(text), MINUTE, 100);
    return `message:group:${id}:${sent.messageId}`;
  };
  return { world, id, admin, carol, dave, bob, heard, say };
}

describe("a community member whose clock is behind", { timeout: 120_000 }, () => {
  it.each([["90 seconds", -90_000], ["two minutes", -2 * MINUTE]])("%s, through a hub: its mention of me, and its next line, are heard", async (_, skew) => {
    const { world, carol, bob, heard, say } = await community(skew);
    const morning = await say(carol, "morning");
    await world.run(10_000);
    const mention = await say(bob, "@Dave are you there?", true);
    await world.run(10_000);
    const next = await say(bob, "hello?");
    expect(heard).toEqual([{ id: morning, mention: false }, { id: mention, mention: true }, { id: next, mention: false }]);
  });

  it("through hubs from before (no live mark): quiet as before", async () => {
    const { world, carol, bob, heard, say } = await community(-90_000);
    // Every hand-off goes without the mark, as an app from before this revision hands a frame on.
    world.drop = (_from, _to, frame) => { if (frame.t === "group-msg") delete frame.lv; return false; };
    const morning = await say(carol, "morning");
    await world.run(10_000);
    await say(bob, "@Dave are you there?", true);
    await world.run(10_000);
    await say(bob, "hello?");
    expect(heard).toEqual([{ id: morning, mention: false }]);
  });
});
