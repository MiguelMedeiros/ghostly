import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineConnection } from "../src/host";
import type { PostedEvent } from "../src/shared/rpc";
import type { EngineState, PaymentView } from "../src/shared/types";
// covers: extension.engine

/**
 * The extension's port copies every message (JSON). A state used to carry every payment this device kept and the
 * whole wallet each time, up to 20 times a second: with 1,000 payments, a state about a contact typing posted them all.
 * The payments and the wallet are the same objects until one changes; a state that has the ones sent last leaves them
 * out, and the page keeps those.
 */
const fake = vi.hoisted(() => ({ nodes: [] as { events: { onState(state: unknown): void }; state: unknown }[] }));

vi.mock("../src/engine/node", () => ({
  GhostlyNode: class {
    state: unknown;
    constructor(public events: { onState(state: unknown): void }) { fake.nodes.push(this); }
    start() { return Promise.resolve(); }
    getState() { return this.state; }
    async getMessages() { return []; }
    // The server sends each chat's history with its deleted ids (`historyEvent`): a fake without them drops the client.
    deletedIdsOf() { return []; }
    setActiveLink() {}
    appsCloseAll() {}
  },
}));

const { EngineServer } = await import("../src/engine/server");
const { copyingSink } = await import("../src/engine/copyingSink");
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const payment = (i: number) => ({
  id: `p${i}`, linkId: "c1", direction: i % 3 ? "out" : "in", amount: 100 + i, state: "paid", createdAt: i, method: "lightning",
  ...(i % 3 ? {} : { request: true, invoice: `lntbs1${"q".repeat(394)}` }),
}) as unknown as PaymentView;
const payments = Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => [`p${i}`, payment(i)]));
const wallet = { mints: [], balance: 5, history: Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, amount: i, fee: 0, timestamp: i, kind: "ecash-in" })), feesPaid: 0 } as unknown as EngineState["wallet"];
const link = (typing: boolean) => ({ id: "c1", peerPubKeyZ32: "peer", peerTyping: typing });
const state = (typing: boolean, more: Partial<EngineState> = {}) => ({ links: [link(typing)], groups: [], payments, wallet, ...more }) as unknown as EngineState;

let engine: typeof import("../src/platform/engine").engine;

beforeEach(async () => {
  vi.resetModules();
  fake.nodes.length = 0;
  const host = await import("../src/host");
  ({ engine } = await import("../src/platform/engine"));
  host.setBrowserHost({
    version: "test", features: { shareLocalServices: false, openServices: false }, requestLocalAccess: async () => false, openService: async () => {},
    connect: async (onMessage: (message: PostedEvent) => void): Promise<EngineConnection> => {
      const server = new EngineServer();
      fake.nodes[0].state = state(false);
      // As the extension's port: what the engine posts is copied (JSON), and handed to the page. The bytes of each state.
      server.attach(copyingSink((message) => {
        const copy = JSON.stringify(message);
        if (message.kind === "state") posted.push(copy.length);
        onMessage(JSON.parse(copy));
      }));
      return { send: () => {} };
    },
  });
}, 60_000);
const posted: number[] = [];

describe("a state over the extension's port", () => {
  it("carries the payments and the wallet only when they changed, and the page keeps them", async () => {
    posted.length = 0;
    await engine.connect();
    await flush();
    const whole = posted[0];
    expect(whole).toBeGreaterThan(200_000);
    expect(Object.keys(engine.state!.payments)).toHaveLength(1_000);

    // A contact typing, 20 times: the payments and the wallet are the same objects.
    const node = fake.nodes[0];
    for (let i = 0; i < 20; i++) node.events.onState(state(i % 2 === 0));
    const typing = posted.slice(1);
    expect(typing).toHaveLength(20);
    for (const bytes of typing) expect(bytes).toBeLessThan(500);
    expect(engine.state!.links[0].peerTyping).toBe(false);
    expect(engine.state!.payments).toEqual(payments);
    expect(engine.state!.wallet).toEqual(wallet);

    // One payment changed: a new object, sent; the wallet still is not.
    const paid = { ...payments, p0: { ...payments.p0, state: "closed" } } as EngineState["payments"];
    node.events.onState(state(false, { payments: paid }));
    expect(posted.at(-1)).toBeGreaterThan(200_000);
    expect(engine.state!.payments.p0.state).toBe("closed");
    expect(engine.state!.wallet).toEqual(wallet);
    const balance = { ...wallet, balance: 9 };
    node.events.onState(state(false, { payments: paid, wallet: balance }));
    expect(posted.at(-1)).toBeLessThan(20_000);
    expect(engine.state!.wallet.balance).toBe(9);
    expect(engine.state!.payments.p0.state).toBe("closed");
  });

  it("carries a picture only when it changed, and the page keeps the ones it has", async () => {
    posted.length = 0;
    // The profile's own picture, each contact's (a chat's and a group edge's) and each group's: the same strings until one changes.
    const picture = (seed: string) => `data:image/jpeg;base64,/9j/${seed.repeat(8_000 / seed.length)}`;
    const own = picture("me"), contacts = ["a", "b", "c"].map(picture), edge = picture("e"), group = picture("g");
    const pictured = (typing: boolean, more: { contacts?: (string | undefined)[]; own?: string } = {}) => state(typing, {
      settings: { nick: "me", avatar: more.own ?? own } as EngineState["settings"],
      links: ["c1", "c2", "c3"].map((id, i) => ({ ...link(typing && i === 0), id, ...(((more.contacts ?? contacts)[i]) ? { peerAvatar: (more.contacts ?? contacts)[i] } : {}) })) as EngineState["links"],
      edges: [{ id: "e1", peerPubKeyZ32: "member", peerAvatar: edge }] as EngineState["edges"],
      groups: [{ id: "g1", name: "Group", members: [], picture: group }] as unknown as EngineState["groups"],
    });
    await engine.connect();
    await flush();
    const node = fake.nodes[0];
    node.events.onState(pictured(false));
    expect(posted.at(-1)).toBeGreaterThan(48_000);

    // A contact typing, 20 times: no picture changed, none goes again.
    const from = posted.length;
    for (let i = 0; i < 20; i++) node.events.onState(pictured(i % 2 === 0));
    for (const bytes of posted.slice(from)) expect(bytes).toBeLessThan(2_000);
    const shown = engine.state!;
    expect(shown.settings.avatar).toBe(own);
    expect(shown.links.map((l) => l.peerAvatar)).toEqual(contacts);
    expect(shown.edges![0].peerAvatar).toBe(edge);
    expect(shown.groups[0].picture).toBe(group);
    expect("keptPictures" in shown).toBe(false);

    // One contact changed theirs and another took it away: the new one goes, the gone one is gone, the rest stay.
    const changed = picture("x");
    node.events.onState(pictured(false, { contacts: [contacts[0], changed, undefined] }));
    expect(posted.at(-1)).toBeGreaterThan(8_000);
    expect(posted.at(-1)).toBeLessThan(10_000);
    expect(engine.state!.links.map((l) => l.peerAvatar)).toEqual([contacts[0], changed, undefined]);
    expect(engine.state!.settings.avatar).toBe(own);
    // Its picture back: sent again, as one the page no longer has.
    node.events.onState(pictured(false, { contacts: [contacts[0], changed, contacts[2]] }));
    expect(engine.state!.links[2].peerAvatar).toBe(contacts[2]);
    expect(engine.state!.groups[0].picture).toBe(group);
  });

  it("carries an identity's or a Nostr profile's picture only when it changed, and the page keeps the ones it has", async () => {
    posted.length = 0;
    // The profile's own verified identities and Nostr key, a contact's verified identities and Nostr key: each public
    // profile's picture a re-encoded JPEG (up to 32 KB), the same strings until one changes.
    const picture = (seed: string) => `data:image/jpeg;base64,/9j/${seed.repeat(8_000 / seed.length)}`;
    const mine = ["p", "q"].map(picture), theirs = ["r", "s", "t"].map(picture), myNostr = picture("n"), theirNostr = picture("o");
    const profile = (avatar: string | undefined) => ({ found: true, name: "x", hosts: ["nexus.pubky.app"], fetchedAt: 1, ...(avatar ? { avatar } : {}) });
    const nostr = (subject: string, avatar: string | undefined) => ({
      subject, npub: `npub-${subject}`, profile: { fetchedAt: 1, relays: [], stale: false, found: true, profile: { name: "x", hasPicture: true, eventAt: 1, eventId: "e", ...(avatar ? { avatar } : {}) } },
    });
    const pictured = (typing: boolean, more: { theirs?: (string | undefined)[]; myNostr?: string } = {}) => state(typing, {
      identityProofs: mine.map((avatar, i) => ({ id: `mine${i}`, provider: "pubky", subject: `s${i}`, publicProfile: profile(avatar) })) as unknown as EngineState["identityProofs"],
      nostr: { own: [nostr("me", more.myNostr ?? myNostr)], settings: { relays: [], autoLoadProfiles: true, publish: false } },
      links: [{
        ...link(typing),
        identities: { support: true, shared: [], received: (more.theirs ?? theirs).map((avatar, i) => ({ id: `theirs${i}`, provider: "bluesky", subject: `t${i}`, publicProfile: profile(avatar) })) },
        nostr: [nostr("them", theirNostr)],
      }] as unknown as EngineState["links"],
    });
    await engine.connect();
    await flush();
    const node = fake.nodes[0];
    node.events.onState(pictured(false));
    expect(posted.at(-1)).toBeGreaterThan(7 * 8_000);

    // A contact typing, 20 times: no picture changed, none goes again.
    const from = posted.length;
    for (let i = 0; i < 20; i++) node.events.onState(pictured(i % 2 === 0));
    for (const bytes of posted.slice(from)) expect(bytes).toBeLessThan(3_000);
    const shown = engine.state!;
    expect(shown.identityProofs.map((p) => p.publicProfile?.avatar)).toEqual(mine);
    expect(shown.nostr.own[0].profile?.profile?.avatar).toBe(myNostr);
    expect(shown.links[0].identities!.received.map((p) => p.publicProfile?.avatar)).toEqual(theirs);
    expect(shown.links[0].nostr![0].profile?.profile?.avatar).toBe(theirNostr);
    expect(shown.links[0].identities!.received[0].publicProfile?.name).toBe("x");

    // One of their identities changed its picture, another lost it, and this profile's Nostr picture changed: those go.
    const changed = picture("x"), mineChanged = picture("y");
    node.events.onState(pictured(false, { theirs: [theirs[0], changed, undefined], myNostr: mineChanged }));
    expect(posted.at(-1)).toBeGreaterThan(2 * 8_000);
    expect(posted.at(-1)).toBeLessThan(3 * 8_000);
    expect(engine.state!.links[0].identities!.received.map((p) => p.publicProfile?.avatar)).toEqual([theirs[0], changed, undefined]);
    expect(engine.state!.nostr.own[0].profile?.profile?.avatar).toBe(mineChanged);
    expect(engine.state!.identityProofs.map((p) => p.publicProfile?.avatar)).toEqual(mine);
    // Its picture back: sent again, as one the page no longer has.
    node.events.onState(pictured(false, { theirs: [theirs[0], changed, theirs[2]], myNostr: mineChanged }));
    expect(engine.state!.links[0].identities!.received[2].publicProfile?.avatar).toBe(theirs[2]);
    expect(engine.state!.links[0].nostr![0].profile?.profile?.avatar).toBe(theirNostr);
  });
});
