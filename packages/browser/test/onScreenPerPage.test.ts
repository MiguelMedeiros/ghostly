import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_DHT_POLL_MS, createIdentity, type PkarrTransport } from "@ghostly/core";
import { EngineServer, type EngineClientSink } from "../src/engine/server";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { EngineEvent, RpcResponse } from "../src/shared/rpc";
import type { StoredLink } from "../src/shared/types";
// covers: extension.engine

/*
 * The extension's peer serves every Ghostly tab through one engine. Each tab says which chat it shows
 * (`setActiveLink`); a tab that is closed says nothing (its port just goes, `detach`). The chats on screen are the
 * ones the open tabs show: a closed tab's goes with it, and two tabs on two chats both count. Before, the engine had
 * the last chat any tab named, until the last tab closed: a closed tab's chat stayed "on screen" for hours, read 3x as
 * often while its contact was away, and every state to every other tab carried its whole connection story.
 */

const quiet: PkarrTransport = {
  publish: async () => {},
  resolve: async () => null,
  describe: () => ({ protocol: "quiet", relays: [] }),
};

const chat = (id: string, story = false): StoredLink => ({
  id, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64, encKeyB64: createIdentity().seedB64,
  peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64,
  // A chat used for a while: its connection story, as long as the engine keeps it.
  ...(story && {
    transportLog: Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, at: 1_700_000_000_000 + i * 60_000, kind: "switched" as const, transport: "iroh/1" as const, from: "hyperdht/1" as const, cause: "automatic" as const, rttMs: 40 + i })),
    transportHistory: Array.from({ length: 200 }, (_, i) => ({ at: 1_700_000_000_000 + i * 30_000, kind: (i % 2 ? "live" : "down") as "live" | "down", transport: "iroh/1" as const, target: "iroh/1" as const, text: "dht" as const, rttMs: 40 + i })),
  }),
});

/** A tab: what its port is sent, the states' sizes among it. */
function tab() {
  const states: number[] = [];
  const sink: EngineClientSink = { post: (message: EngineEvent | RpcResponse) => { if (message.kind === "state") states.push(JSON.stringify(message.state).length); } };
  return { sink, states };
}

type Live = { link: { dht: { active: boolean; pollMs: number } } | null };

let server: EngineServer | undefined;
beforeEach(async () => {
  const stores = [STORES.settings, STORES.links, STORES.messages];
  await transact(stores, (s) => { for (const name of stores) s[name].clear(); });
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
});
afterEach(async () => { await server?.stop(); server = undefined; vi.unstubAllGlobals(); });

async function engine() {
  await db.putLink(chat("chatX", true));
  await db.putLink(chat("chatY"));
  for (let i = 0; i < 8; i++) await db.putLink(chat(`other${i}`));
  server = new EngineServer({ transport: quiet, automaticWallets: false, nativeTransports: {} });
  await server.ready;
  const node = server.node;
  const links = (node as unknown as { links: Map<string, Live> }).links;
  const dht = (id: string) => links.get(id)!.link!.dht;
  let n = 0;
  const show = (client: EngineClientSink, linkId: string | null) => server!.handle(client, { kind: "request", id: ++n, method: "setActiveLink", params: { linkId } } as never);
  /** One state to every tab (something unrelated changes), and the size each one got. */
  const nextState = async (...tabs: ReturnType<typeof tab>[]) => {
    // What was asked before goes out first (the engine sends one state 50 ms after a change).
    await new Promise(resolve => setTimeout(resolve, 80));
    const before = tabs.map(t => t.states.length);
    await server!.handle(tabs[0].sink, { kind: "request", id: ++n, method: "renameLink", params: { linkId: "other0", label: `x${n}` } } as never);
    await vi.waitFor(() => expect(tabs.every((t, i) => t.states.length > before[i])).toBe(true));
    return tabs.map(t => t.states.at(-1)!);
  };
  const story = () => node.getState().links.filter(l => l.transportHistory !== undefined).map(l => l.id).sort();
  return { node, dht, show, nextState, story };
}

describe("the chats on screen, per tab", () => {
  it("two tabs on two chats both count; a closed tab's chat goes back to the background pace and leaves the states", async () => {
    const { dht, show, nextState, story } = await engine();
    const [a, b, list] = [tab(), tab(), tab()];
    for (const t of [a, b, list]) server!.attach(t.sink);
    const quietState = (await nextState(a, b, list))[2];

    await show(a.sink, "chatX");
    await show(b.sink, "chatY");
    // Tab A still shows chat X after tab B opened chat Y.
    expect([dht("chatX").active, dht("chatY").active]).toEqual([true, true]);
    expect(story()).toEqual(["chatX", "chatY"]);
    const shownBoth = (await nextState(a, b, list))[2];

    // Tab A is closed: its port goes, nothing is said first.
    server!.detach(a.sink);
    expect([dht("chatX").active, dht("chatY").active]).toEqual([false, true]);
    expect(story()).toEqual(["chatY"]);
    // Chat X's contact (away) is read at the background pace again, not the open chat's 10 s: past the first reads'
    // quick minutes after the start.
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
    const paces = [dht("chatX").pollMs, dht("chatY").pollMs, dht("other1").pollMs];
    later.mockRestore();
    console.log(`mailbox read every: chat X ${paces[0]} ms, chat Y (on screen in tab B) ${paces[1]} ms, a chat never opened ${paces[2]} ms`);
    // As a chat no tab shows: at least the background pace (30 s; an invite nobody used, slower still).
    expect(paces[1]).toBe(ACTIVE_DHT_POLL_MS);
    expect(paces[0]).toBeGreaterThanOrEqual(30_000);
    expect(paces[2]).toBeGreaterThanOrEqual(30_000);
    // And the tabs left are sent states without chat X's story.
    const [toB, toList] = await nextState(b, list);
    console.log(`state per tab: no chat on screen ${quietState} B, chats X and Y on screen ${shownBoth} B, after tab A (chat X) closed ${toList} B`);
    expect(toList).toBeLessThan(quietState + 2_000);
    expect(toB).toBe(toList);

    // Tab B closes too, the list tab stays: nothing is on screen.
    server!.detach(b.sink);
    expect(dht("chatY").active).toBe(false);
    expect(story()).toEqual([]);
  });

  it("a chat two tabs show stays on screen until both let it go; a tab that moves on lets its chat go", async () => {
    const { dht, show } = await engine();
    const [a, b] = [tab(), tab()];
    server!.attach(a.sink);
    server!.attach(b.sink);
    await show(a.sink, "chatX");
    await show(b.sink, "chatX");
    server!.detach(a.sink);
    expect(dht("chatX").active).toBe(true);
    await show(b.sink, "chatY");
    expect([dht("chatX").active, dht("chatY").active]).toEqual([false, true]);
    await show(b.sink, null);
    expect(dht("chatY").active).toBe(false);
  });

  it("a tab whose chat arrives after its port went claims nothing", async () => {
    const { dht, show } = await engine();
    const [a, b] = [tab(), tab()];
    server!.attach(a.sink);
    server!.attach(b.sink);
    server!.detach(a.sink);
    await show(a.sink, "chatX");
    expect(dht("chatX").active).toBe(false);
  });
});
