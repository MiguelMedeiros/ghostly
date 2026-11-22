import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { inCall, waitForState, type ApiContext } from "../src/apiKit";
import { serve, type Host } from "../src/host";
import { waitForConfirmed, waitForEdit, waitForGroupFrame, waitForMessage, waitForRemoval } from "../src/waits";
// covers: headless.daemon

const root = mkdtempSync(join(tmpdir(), "gh-waits-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const turn = () => new Promise((resolve) => setImmediate(resolve));

/** A daemon whose one chat never goes live: every `chat.wait` on it waits on the hub's state. */
async function served(name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { mode: 0o700 });
  const listeners = new Set<() => void>();
  const state = { links: [{ id: "c49", name: "Bia" }], groups: [] };
  const hub = {
    lastSeq: 0,
    replay: () => [],
    onEvent: () => () => {},
    onState: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const host = { ctx: { mode: "daemon", runtime: { paths: { dir, socket: join(dir, "daemon.sock") }, server: { node: { getState: () => state, chatView: (id: string) => state.links.find((l) => l.id === id) } } }, hub } } as unknown as Host;
  const s = await serve(host);
  return { ...s, listeners, path: join(dir, "daemon.sock") };
}

/** A client that writes `count` chat.wait calls at once. */
function waiter(path: string, count: number) {
  const client = connect(path);
  const lines = Array.from({ length: count }, (_, i) => JSON.stringify({ id: i + 1, method: "chat.wait", params: { chat: "c49", until: "live", timeout: 86_400 } }) + "\n");
  client.write(lines.join(""));
  return client;
}

describe.skipIf(process.platform === "win32")("a wait on the socket", () => {
  it("ends when its client's connection closes", async () => {
    const s = await served("closed");
    try {
      const client = waiter(s.path, 20);
      while (s.listeners.size < 20) await turn();
      // A bot killed in the middle of `ghostly chat wait --timeout 86400`.
      client.destroy();
      for (let i = 0; i < 50 && s.listeners.size; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(s.listeners.size).toBe(0);
    } finally { await s.close(); }
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A daemon where nothing is ever confirmed: every wait kind waits, by its hub listener or its 250 ms reads. */
function nothingConfirmed() {
  const states = new Set<unknown>(), events = new Set<unknown>();
  let reads = 0;
  const message = { id: "m1", delivery: "sending", edit: { pending: true, seq: 1 } };
  const hub = {
    onState: (l: unknown) => { states.add(l); return () => states.delete(l); },
    onEvent: (l: unknown) => { events.add(l); return () => events.delete(l); },
  };
  const engine = {
    getState: () => ({ links: [{ id: "c1", peerParticipationKey: "k" }], groups: [], transfers: {} }),
    chatView: () => ({ id: "c1", peerParticipationKey: "k" }),
    getMessage: async () => { reads++; return message; },
    removalPending: () => { reads++; return true; },
    groupTaken: () => { reads++; return 0; },
    groupView: () => ({ id: "g1", profile: "community", members: [], status: "active" }),
    chatUnconfirmed: () => { reads++; return { reactions: [1], pin: null }; },
  };
  const ctx = { mode: "daemon", hub, runtime: { server: { node: engine } } } as unknown as ApiContext;
  return { ctx, reads: () => reads, held: () => states.size + events.size };
}

const DAY = 86_400_000;
const kinds: [string, (ctx: ApiContext) => Promise<unknown>][] = [
  ["chat wait", (ctx) => waitForState(ctx, () => undefined, DAY, "x")],
  ["send --wait delivered", (ctx) => waitForMessage(ctx, "c1", "m1", "delivered", DAY)],
  ["send --wait sent", (ctx) => waitForMessage(ctx, "c1", "m1", "sent", DAY)],
  ["edit --wait confirmed", (ctx) => waitForEdit(ctx, "c1", "m1", DAY)],
  ["delete --everyone --wait confirmed", (ctx) => waitForRemoval(ctx, "c1", "m1", DAY)],
  ["group pin --wait sent", (ctx) => waitForGroupFrame(ctx, "g1", "m1", { pin: 1 }, DAY)],
  ["react --wait confirmed", (ctx) => waitForConfirmed(ctx, "c1", "reaction", (l) => l.reactions.length > 0, DAY)],
];

describe("a wait whose client's connection closed", () => {
  for (const [name, start] of kinds) it(`${name} ends, and reads nothing more`, async () => {
    const f = nothingConfirmed();
    const gone = new AbortController();
    // As `callApi` runs a call that came on a connection: `gone` aborts when the connection closes.
    const waits = Array.from({ length: 5 }, () => inCall({ gone: gone.signal }, () => start(f.ctx)).then(() => "resolved", (e: { code?: string }) => e.code));
    await sleep(300);
    gone.abort();
    expect(await Promise.race([Promise.all(waits), sleep(1500).then(() => ["still waiting"])])).toEqual(Array(5).fill("interrupted"));
    const reads = f.reads();
    await sleep(600);
    expect(f.reads()).toBe(reads);
    expect(f.held()).toBe(0);
  });
});
