import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineConnection } from "../src/host";
import type { PostedEvent } from "../src/shared/rpc";
import type { EngineState, GroupView, LinkView } from "../src/shared/types";
// covers: extension.engine

/**
 * The extension's port copies every message (JSON), once per open tab. The engine builds every chat's and group's view
 * again for each state, so a state about one contact typing carried all of them, a community's whole member list too:
 * with 50 chats and a community of 300, about 120 KB per tab for a change of a few bytes. A chat or group this tab was
 * sent last as it is now is left out, and the page keeps it.
 */
const fake = vi.hoisted(() => ({ nodes: [] as { events: { onState(state: unknown): void }; state: unknown }[] }));

vi.mock("../src/engine/node", () => ({
  GhostlyNode: class {
    state: unknown;
    constructor(public events: { onState(state: unknown): void }) { fake.nodes.push(this); }
    start() { return Promise.resolve(); }
    getState() { return this.state; }
    async getMessages() { return []; }
    deletedIdsOf() { return []; }
    setActiveLink() {}
    appsCloseAll() {}
  },
}));

const { EngineServer } = await import("../src/engine/server");
const { copyingSink } = await import("../src/engine/copyingSink");
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const key = (seed: string) => `${seed}${"y".repeat(52 - seed.length)}`;
const picture = (seed: string) => `data:image/jpeg;base64,/9j/${seed.repeat(6_000 / seed.length)}`;
// Shaped on the engine's views (`viewOf`): the fields a running chat has, with a transport log.
const chat = (i: number, typing = false): LinkView => ({
  id: `chat-${i}-${"c".repeat(24)}`, myPubKeyZ32: key("me"), peerPubKeyZ32: key(`peer${i}`), peerNick: `Contact ${i}`,
  ...(i % 5 < 2 ? { peerAvatar: picture(`a${i}`) } : {}),
  createdAt: 1_700_000_000_000 + i, status: "active" as never, dataLink: "open" as never, peerOnline: i % 2 === 0, peerLastSeenAt: 1_700_000_100_000 + i,
  peerServices: null, lastMessageAt: 1_700_000_200_000 + i, peerAck: 1_700_000_200_000 + i, lastSyncAt: 1_700_000_300_000 + i,
  poll: { polling: false, nextAt: 1_700_000_400_000, interval: 60_000 }, peerTyping: typing, profile: "paired-chat/1",
  capabilities: { files: true, payments: true, calls: true, services: true, largeFiles: true, methods: { lightning: true, cashu: true } as never },
  availableTransports: ["iroh", "hyperdht", "relay"] as never, runnableTransports: ["iroh", "relay"] as never, deliveryMode: "live" as never,
  canSendText: true, textDelivery: "stream", transportRttMs: 40 + i, transportLive: { since: 1_700_000_500_000 },
  transportLog: Array.from({ length: 6 }, (_, j) => ({ at: 1_700_000_600_000 + j, transport: "iroh", event: "connected", detail: `attempt ${j} ok` })) as never,
  sessionOffers: { mine: ["text/1", "files/2", "calls/1", "pay/1"], peer: ["text/1", "files/2", "calls/1"] },
});
const member = (g: number, j: number) => ({ key: key(`g${g}m${j}`), role: j === 0 ? "admin" : "member", me: j === 1, nick: `Member ${j}`, online: j % 3 === 0, missing: 0 });
const group = (g: number, members: number, more: Partial<GroupView> = {}): GroupView => ({
  id: `group-${g}-${"g".repeat(24)}`, name: `Group ${g}`, createdAt: 1_700_000_000_000, profile: members > 32 ? "community" : "mesh", status: "active" as never,
  epoch: 3, myKey: key(`g${g}m1`), isAdmin: false, members: Array.from({ length: members }, (_, j) => member(g, j)) as never, invited: [], memberLinks: {},
  lastMessageAt: 1_700_000_200_000, canSend: true, ...(g === 0 ? { picture: picture("grp") } : {}), ...more,
});

// A private group's edge to a member: a whole chat view, one per other member (`node.ts`, `edges`).
const edge = (g: number, j: number, more: Partial<LinkView> = {}): LinkView => ({
  ...chat(g * 32 + j), id: `edge-${g}-${j}-${"e".repeat(24)}`, peerPubKeyZ32: key(`g${g}m${j}`), group: `group-${g}`, groupPeer: key(`g${g}m${j}`), ...more,
} as LinkView);
// 3 private groups of 32 members: 31 edges each.
const edgesOf = () => [0, 1, 2].flatMap((g) => Array.from({ length: 32 }, (_, j) => j).filter((j) => j !== 1).map((j) => edge(g, j)));

let chats: LinkView[], groups: GroupView[], edges: LinkView[] | undefined;
const state = () => ({ settings: { nick: "me" }, links: chats, groups, ...(edges && { edges }), payments: {}, wallet: { balance: 0 } }) as unknown as EngineState;
const fresh = () => {
  chats = Array.from({ length: 50 }, (_, i) => chat(i));
  groups = [group(0, 8), group(1, 8), group(2, 8), group(3, 300)];
  edges = undefined;
};

let engine: typeof import("../src/platform/engine").engine;
let server: InstanceType<typeof EngineServer>;
let page: (message: PostedEvent) => void;
let tab: ReturnType<typeof copyingSink>;
const posted: { bytes: number; state: Record<string, unknown> }[] = [];
// A port to the page (a tab, or the same tab connected again): its own copying sink, each state's bytes counted.
const port = () => copyingSink((message) => {
  const copy = JSON.stringify(message);
  if (message.kind === "state") posted.push({ bytes: copy.length, state: JSON.parse(copy).state });
  page(JSON.parse(copy));
});

beforeEach(async () => {
  vi.resetModules();
  fake.nodes.length = 0;
  posted.length = 0;
  fresh();
  const host = await import("../src/host");
  ({ engine } = await import("../src/platform/engine"));
  host.setBrowserHost({
    version: "test", features: { shareLocalServices: false, openServices: false }, requestLocalAccess: async () => false, openService: async () => {},
    connect: async (onMessage: (message: PostedEvent) => void): Promise<EngineConnection> => {
      page = onMessage;
      server = new EngineServer();
      fake.nodes[0].state = state();
      server.attach(tab = port());
      return { send: () => {} };
    },
  });
  await engine.connect();
  await flush();
}, 60_000);

const update = () => fake.nodes[0].events.onState(fake.nodes[0].state = state());
const shown = () => JSON.parse(JSON.stringify({ links: engine.state!.links, edges: engine.state!.edges, groups: engine.state!.groups }));
const truth = () => JSON.parse(JSON.stringify({ links: chats, edges, groups }));
// The port lost and a new one: a new sink, which has sent this page nothing yet.
const reconnect = async () => {
  server.detach(tab);
  fake.nodes[0].state = state();
  server.attach(tab = port());
  await flush();
};

describe("a chat's or group's view over the extension's port", () => {
  it("goes only when it changed: a contact typing costs that chat, not every chat and member", async () => {
    const whole = posted[0].bytes;
    expect(whole).toBeGreaterThan(150_000);
    // The first state after the pictures went: the chats that had one go once more without it.
    update();
    const typing: number[] = [];
    for (let i = 0; i < 20; i++) {
      chats = chats.map((view, n) => (n === 0 ? chat(0, i % 2 === 0) : { ...view }));
      groups = groups.map((view) => ({ ...view, members: view.members.map((m) => ({ ...m })) }));
      update();
      typing.push(posted.at(-1)!.bytes);
      expect(shown()).toEqual(truth());
    }
    for (const bytes of typing) expect(bytes).toBeLessThan(5_000);
    expect(posted.at(-1)!.state.links).toHaveLength(1);
    expect(posted.at(-1)!.state.groups).toEqual([]);
    expect(engine.state!.links[0].peerTyping).toBe(false);
    expect(engine.state!.links[1].peerAvatar).toBe(picture("a1"));
    expect(engine.state!.groups[0].picture).toBe(picture("grp"));
    expect(engine.state!.groups[3].members).toHaveLength(300);
    expect("keptViews" in engine.state!).toBe(false);
  });

  it("sends a group whose members changed, and the page drops a chat or group that is gone, in the list's order", async () => {
    update();
    groups = [groups[0], groups[1], group(3, 300, { members: [...groups[3].members.slice(1)] }), groups[2]];
    update();
    expect(posted.at(-1)!.state.groups).toHaveLength(1);
    expect(shown()).toEqual(truth());
    expect(engine.state!.groups.map((g) => g.id)).toEqual(groups.map((g) => g.id));
    expect(engine.state!.groups[2].members).toHaveLength(299);

    const gone = chats[0].id;
    chats = [chats[3], ...chats.slice(5)];
    groups = groups.slice(1);
    update();
    expect(posted.at(-1)!.state.links).toEqual([]);
    expect(posted.at(-1)!.bytes).toBeLessThan(5_000);
    expect(shown()).toEqual(truth());
    expect(engine.state!.links).toHaveLength(46);
    expect(engine.state!.links.some((view) => view.id === gone)).toBe(false);

    // A picture taken away from a chat left as it was: that chat goes, without it.
    expect(engine.state!.links[1].peerAvatar).toBe(picture("a5"));
    chats = [chats[0], { ...chats[1], peerAvatar: undefined }, ...chats.slice(2)];
    update();
    expect(posted.at(-1)!.state.links).toHaveLength(1);
    expect(shown()).toEqual(truth());
    expect(engine.state!.links[1].peerAvatar).toBeUndefined();
  });

  it("gives a page connected again every chat and group whole, and that page keeps them after", async () => {
    update();
    update();
    expect(posted.at(-1)!.bytes).toBeLessThan(5_000);
    chats = chats.slice(0, 49);
    await reconnect();
    const again = posted.at(-1)!;
    expect(again.bytes).toBeGreaterThan(150_000);
    expect(again.state.links).toHaveLength(49);
    expect(again.state.groups).toHaveLength(4);
    expect("keptViews" in again.state).toBe(false);
    expect(shown()).toEqual(truth());
    update();
    update();
    expect(posted.at(-1)!.bytes).toBeLessThan(5_000);
    expect(shown()).toEqual(truth());
  });
});

describe("a private group's edges over the extension's port", () => {
  /**
   * Each edge is a whole chat view: with 3 private groups of 32 members, 93 of them went whole in every state, about
   * 140 KB per tab for a contact typing. Left out, each costs its id in `keptViews` (about 35 bytes).
   */
  it("go only when they changed: a contact typing costs none of them, and the page keeps them all", async () => {
    edges = edgesOf();
    await reconnect();
    const whole = posted.at(-1)!;
    expect(whole.state.edges).toHaveLength(93);
    expect("keptViews" in whole.state).toBe(false);
    expect(shown()).toEqual(truth());
    update();
    const typing: number[] = [];
    for (let i = 0; i < 20; i++) {
      chats = chats.map((view, n) => (n === 0 ? chat(0, i % 2 === 0) : { ...view }));
      edges = edges!.map((view) => ({ ...view, transportLog: [...view.transportLog!] }));
      update();
      typing.push(posted.at(-1)!.bytes);
      expect(posted.at(-1)!.state.edges).toEqual([]);
      expect(shown()).toEqual(truth());
    }
    for (const bytes of typing) expect(bytes).toBeLessThan(8_000);
    expect(engine.state!.edges).toHaveLength(93);
    expect(engine.state!.edges![0].peerAvatar).toBe(picture("a0"));
    expect(engine.state!.edges![0].transportLog).toHaveLength(6);
  });

  it("sends an edge that changed, drops one that is gone, keeps the list's order, and has none when the state has none", async () => {
    edges = edgesOf();
    await reconnect();
    update();
    edges = edges!.map((view, n) => (n === 40 ? { ...view, transportRttMs: 999, peerOnline: !view.peerOnline } : view));
    update();
    expect((posted.at(-1)!.state.edges as LinkView[]).map((view) => view.id)).toEqual([edges[40].id]);
    expect(shown()).toEqual(truth());
    expect(engine.state!.edges![40].transportRttMs).toBe(999);

    // A member gone (its edge with it), and the list in another order.
    const gone = edges[3].id;
    edges = [...edges.slice(31, 62), ...edges.slice(0, 3), ...edges.slice(4, 31), ...edges.slice(62)];
    update();
    expect(posted.at(-1)!.state.edges).toEqual([]);
    expect(posted.at(-1)!.bytes).toBeLessThan(8_000);
    expect(shown()).toEqual(truth());
    expect(engine.state!.edges).toHaveLength(92);
    expect(engine.state!.edges!.some((view) => view.id === gone)).toBe(false);

    // A picture taken away from an edge left as it was: that edge goes, without it.
    expect(engine.state!.edges![2].peerAvatar).toBe(picture("a35"));
    edges = edges.map((view, n) => (n === 2 ? { ...view, peerAvatar: undefined } : view));
    update();
    expect(posted.at(-1)!.state.edges).toHaveLength(1);
    expect(shown()).toEqual(truth());
    expect(engine.state!.edges![2].peerAvatar).toBeUndefined();

    // No edges in a state, then back: they go whole again.
    edges = undefined;
    update();
    expect(engine.state!.edges).toBeUndefined();
    edges = edgesOf();
    update();
    expect(posted.at(-1)!.state.edges).toHaveLength(93);
    expect(shown()).toEqual(truth());
  });

  it("gives a page connected again every edge whole, and that page keeps them after", async () => {
    edges = edgesOf();
    await reconnect();
    update();
    update();
    expect(posted.at(-1)!.bytes).toBeLessThan(8_000);
    edges = edges!.slice(0, 92);
    await reconnect();
    const again = posted.at(-1)!;
    expect(again.state.edges).toHaveLength(92);
    expect("keptViews" in again.state).toBe(false);
    expect(shown()).toEqual(truth());
    update();
    update();
    expect(posted.at(-1)!.bytes).toBeLessThan(8_000);
    expect(shown()).toEqual(truth());
  });
});
