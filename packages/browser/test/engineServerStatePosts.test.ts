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
});
