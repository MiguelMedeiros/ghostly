import { afterEach, expect, it } from "vitest";
import DHT from "hyperdht";
// Loaded for what it patches in dht-rpc and hyperdht, as the relay's node runs them.
import "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: transport.hyperdht-relay

type Request = { tid: number; destroyed: boolean; onresponse: (res: unknown, req: Request) => void; onerror: (error: unknown) => void; destroy(error?: Error): void };
type IO = {
  _tid: number;
  inflight: Request[];
  clientSocket: unknown;
  stats: { requests: { active: number } };
  createRequest(to: { host: string; port: number }, token: null, internal: boolean, command: number, target: null, value: null): Request;
  onmessage(socket: unknown, buffer: Uint8Array, from: { host: string; port: number }): void;
};
type Server = { listen(keyPair: { publicKey: Uint8Array; secretKey: Uint8Array }): Promise<unknown>; close(): Promise<void> };
type Node = { io: IO; listening: Set<unknown>; ready(): Promise<void>; destroy(): Promise<void>; createServer(): Server };

// A port nothing on loopback answers from: the requests here are never sent, their replies are made by the test.
const SILENT = { host: "127.0.0.1", port: 9 };

let node: Node | null = null;
afterEach(async () => {
  await node?.destroy();
  node = null;
});

/** A node on no network at all: no bootstrap node, so nothing it does reaches out. */
async function lone() {
  node = new DHT({ bootstrap: [], host: "127.0.0.1", firewalled: false }) as unknown as Node;
  await node.ready();
  return node;
}

const request = (io: IO) => io.createRequest(SILENT, null, true, 0, null, null);

/** A reply to `tid` as a DHT node writes it: type and version, no flags, the tid, the address it saw (dht-rpc 6.28.0). */
function reply(io: IO, tid: number) {
  io.onmessage(io.clientSocket, Uint8Array.from([0x13, 0, tid & 0xff, tid >> 8, 127, 0, 0, 1, 9, 0]), SILENT);
}

function shuffled<T>(items: T[]) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

it("hands each reply to the request of its tid, after tids wrap and when two share one", async () => {
  const { io } = await lone();
  const before = io.inflight.length;
  const got: string[] = [];
  const named = (name: string) => {
    const req = request(io);
    req.onresponse = () => { got.push(name); };
    return req;
  };
  io._tid = 65535;
  const last = named("last");
  const wrapped = named("wrapped");
  io._tid = 0;
  const again = named("again");
  expect([last.tid, wrapped.tid, again.tid]).toEqual([65535, 0, 0]);

  reply(io, 0);
  reply(io, 65535);
  reply(io, 0);
  // Nothing in flight has that tid any more.
  reply(io, 0);
  expect(got).toEqual(["wrapped", "last", "again"]);
  expect(io.inflight.length).toBe(before);
});

it("keeps every request findable while requests come and go in any order", async () => {
  const { io } = await lone();
  const before = io.inflight.length;
  const requests = Array.from({ length: 4_000 }, () => request(io));
  const answered = new Set<Request>();
  const failed = new Set<Request>();
  for (const req of requests) {
    req.onresponse = (_res, which) => { answered.add(which); };
    req.onerror = () => { failed.add(req); };
  }
  const [destroyed, replied] = [shuffled(requests).slice(0, 2_000), new Set<Request>()];
  for (const req of destroyed) req.destroy();
  for (const req of shuffled(requests)) if (!req.destroyed) { replied.add(req); reply(io, req.tid); }
  expect(failed).toEqual(new Set(destroyed));
  expect(answered).toEqual(replied);
  expect(io.inflight.length).toBe(before);
});

/**
 * dht-rpc 6.28.0 matched each reply by walking every request in flight, and a relay full to its limits has thousands of
 * them (each listen's keep-alives, a restart's lookups and announcements, and all that waits in the window's queue): that
 * walk was a third of the relay's CPU after a restart. A reply now looks at its own tid's requests only.
 */
it("matches a reply without looking at the other requests in flight", async () => {
  const { io } = await lone();
  const requests = Array.from({ length: 20_000 }, () => request(io));
  let reads = 0;
  for (const req of requests) {
    const { tid } = req;
    Object.defineProperty(req, "tid", { get: () => { reads++; return tid; } });
  }
  const answering = shuffled(requests).slice(0, 1_000);
  const tids = answering.map(req => req.tid);
  reads = 0;
  for (const tid of tids) reply(io, tid);
  expect(answering.every(req => !io.inflight.includes(req))).toBe(true);
  expect(reads).toBeLessThan(tids.length * 4);
});

/** A request that times out is destroyed, and dht-rpc 6.28.0 found it with indexOf over every request in flight. */
it("destroys 60,000 requests in flight in any order within 150 ms", async () => {
  const { io } = await lone();
  const before = io.inflight.length;
  const requests = shuffled(Array.from({ length: 60_000 }, () => request(io)));
  // One error for all: dht-rpc's own default is a new one each, its stack taken, which costs more than finding the request.
  const timeout = new Error("timed out");
  const started = performance.now();
  for (const req of requests) req.destroy(timeout);
  const ms = performance.now() - started;
  expect(io.inflight.length).toBe(before);
  // About 40 ms found at their slots, over 300 ms by indexOf.
  expect(ms).toBeLessThan(150);
});

/**
 * hyperdht 6.36.0 refused a listen on a key the node already listens on by comparing it with every server's key: after
 * a restart at the relay's default limits, 8,192 listens made 33 million comparisons, a fifth of the relay's CPU. A
 * listen now looks its own key up, and still refuses one in use.
 */
it("refuses a key in use without comparing it with every listening server's", async () => {
  const dht = await lone();
  let reads = 0;
  const others = Array.from({ length: 5_000 }, () => {
    const { publicKey } = DHT.keyPair();
    return { get _keyPair() { reads++; return { publicKey }; } };
  });
  for (const other of others) dht.listening.add(other);
  try {
    const keyPair = DHT.keyPair();
    const first = dht.createServer();
    await first.listen(keyPair);
    await expect(dht.createServer().listen(keyPair)).rejects.toMatchObject({ code: "KEYPAIR_ALREADY_USED" });
    expect(reads).toBe(0);
    await first.close();
    const next = dht.createServer();
    await next.listen(keyPair);
    await next.close();
  } finally {
    for (const other of others) dht.listening.delete(other);
  }
});
