import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import { DEFAULT_IROH_RELAYS, MAX_IROH_RELAYS, createIrohWebEndpoint, irohRelayProblem, onPublicIrohRelay, type IrohWasm } from "../src/platform/irohWeb";

// covers: transport.iroh-web, settings.network.iroh-relays

/**
 * What reaches the wasm Iroh. It compares relay URLs as text, so each goes in under one spelling, whichever way it
 * was written; and that spelling has no trailing dot, because WebKit (Safari, the iPhone app) opens no host name that
 * ends in one: neither the `wss://…/relay` socket nor the `https://…/ping` probe. A Desktop's record names its relay
 * with the dot, so this is the one place that keeps a browser from being asked to open it.
 */
function fakeWasm({ home = 0, refuse = (_relays: string[]) => false } = {}) {
  const started: string[][] = [], dialled: unknown[] = [];
  const conn = { binding: () => ({ transport: "iroh/1" as const, context: "00", identities: ["a", "b"] as [string, string] }), send: async () => {}, recv: () => new Promise<undefined>(() => {}), rtt: () => -1, close() {}, free() {} };
  const load = async (): Promise<IrohWasm> => ({
    IrohNode: {
      start: async (_seed, relays) => {
        started.push(relays);
        await new Promise(resolve => setTimeout(resolve, 5));
        if (refuse(relays)) throw new Error("Iroh relay unreachable");
        // The relay it measured as nearest, spelled as Iroh spells a relay URL.
        const relay = home ? new URL(relays[Math.min(home, relays.length - 1)]).href : relays[0];
        return {
          address: () => ({ id: "c".repeat(64), relay, addresses: [] }),
          connect: async (descriptor: unknown) => { dialled.push(descriptor); return conn; },
          accept: () => new Promise<undefined>(() => {}), close: async () => {}, free() {},
        };
      },
    },
  });
  return { started, dialled, load };
}
const seed = Buffer.alloc(32, 7).toString("base64url");

const noDottedHost = (urls: (string | null | undefined)[]) => { for (const url of urls) expect(new URL(url!).hostname, url!).not.toMatch(/\.$/); };

it("lists the default relays in the spelling every browser opens: n0's four, then Ghostly's own, no trailing dot", () => {
  expect(DEFAULT_IROH_RELAYS).toHaveLength(5);
  expect(DEFAULT_IROH_RELAYS.length).toBeLessThanOrEqual(MAX_IROH_RELAYS);
  for (const relay of DEFAULT_IROH_RELAYS.slice(0, 4)) expect(relay).toMatch(/^https:\/\/[a-z0-9-]+\.relay\.n0\.iroh\.link\/$/);
  // Plain: the Cloudflare tunnel in front of it answers the dotted name with 404.
  expect(DEFAULT_IROH_RELAYS[4]).toBe("https://iroh.miguelmedeiros.dev/");
  for (const relay of DEFAULT_IROH_RELAYS) expect(irohRelayProblem(relay)).toBeNull();
  noDottedHost([...DEFAULT_IROH_RELAYS]);
});

it("tells n0's public relays, in either spelling, from Ghostly's and a relay of one's own", () => {
  expect(onPublicIrohRelay(DEFAULT_IROH_RELAYS)).toBe(true);
  expect(onPublicIrohRelay(["http://127.0.0.1:4980/", "https://euc1-1.relay.n0.iroh.link./"])).toBe(true);
  expect(onPublicIrohRelay(["https://iroh.miguelmedeiros.dev/"])).toBe(false);
  expect(onPublicIrohRelay(["https://relay.example.com/", "http://127.0.0.1:4980/", "https://notiroh.link/", "https://iroh.link.example.com/"])).toBe(false);
});

/**
 * The relay count is checked inside the committed wasm (`native/transports/iroh-web`), so a default list longer than
 * it takes would leave the browser build with no Iroh at all. The real wasm, on closed loopback ports (no network):
 * as many relays as the defaults get past the count and fail only for want of an answer; one more is refused.
 */
it("starts the real wasm on as many relays as the defaults, and refuses one more", async () => {
  const load = async (): Promise<IrohWasm> => {
    const module = await import("@ghostly/iroh-web");
    module.initSync({ module: readFileSync(createRequire(import.meta.url).resolve("@ghostly/iroh-web/wasm")) });
    return module as unknown as IrohWasm;
  };
  const closed = (n: number) => Array.from({ length: n }, (_, i) => `http://127.0.0.1:${9 + i}/`);
  await expect(createIrohWebEndpoint(seed, { load, relays: closed(DEFAULT_IROH_RELAYS.length), onlineMs: 300 })).rejects.toThrow("Iroh relay unreachable");
  await expect(createIrohWebEndpoint(seed, { load, relays: closed(MAX_IROH_RELAYS + 1), onlineMs: 300 })).rejects.toThrow("Between one and five relays are needed");
});

it("homes on the same relays whichever way they are spelled, never under a dotted host, and publishes that spelling", async () => {
  const wasm = fakeWasm();
  const byDefault = await createIrohWebEndpoint(seed, { load: wasm.load });
  // As Iroh's own list and a Desktop's record spell them, and as a person types a relay of their own.
  const typed = await createIrohWebEndpoint(seed, { load: wasm.load, relays: ["https://use1-1.relay.n0.iroh.link./", "https://use1-1.relay.n0.iroh.link/", "https://relay.example.com.", "http://127.0.0.1:47085"] });
  expect(wasm.started).toEqual([
    [...DEFAULT_IROH_RELAYS],
    ["https://use1-1.relay.n0.iroh.link/", "https://relay.example.com/", "http://127.0.0.1:47085"],
  ]);
  noDottedHost(wasm.started.flat());
  expect(byDefault.descriptor).toEqual({ id: "c".repeat(64), relay: "https://use1-1.relay.n0.iroh.link/", addresses: [], relayed: true });
  await Promise.all([byDefault.close(), typed.close()]);
});

/**
 * Iroh moves an endpoint's home to another of its relays when the one it homed on goes away, or another answers
 * faster. The contact reaches it only through the relay its record names: one dialled through the relay it left timed
 * out (15 s, every time, 7 of 7 on local relays, the old one up or down), and through the new one it was live in 2 to 16 ms.
 */
it("says when the wasm Iroh moves home to another relay, and publishes that one", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    let home: string | null = "https://use1-1.relay.n0.iroh.link/";
    const load = async (): Promise<IrohWasm> => ({
      IrohNode: {
        start: async () => ({
          address: () => ({ id: "c".repeat(64), relay: home, addresses: [] }),
          connect: async () => { throw new Error("unused"); },
          accept: () => new Promise<undefined>(() => {}), close: async () => {}, free() {},
        }),
      },
    });
    const endpoint = await createIrohWebEndpoint(seed, { load });
    const told = vi.fn(() => (endpoint.descriptor as { relay: string }).relay);
    endpoint.onDescriptor = told;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(told).not.toHaveBeenCalled();
    // Between two homes it has none for a moment: the last one stays published.
    home = null;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(told).not.toHaveBeenCalled();
    home = "https://iroh.miguelmedeiros.dev/";
    await vi.advanceTimersByTimeAsync(10_000);
    expect(told).toHaveBeenCalledTimes(1);
    expect(told).toHaveReturnedWith("https://iroh.miguelmedeiros.dev/");
    expect(endpoint.descriptor).toEqual({ id: "c".repeat(64), relay: "https://iroh.miguelmedeiros.dev/", addresses: [], relayed: true });
    // Closed, it says nothing more.
    await endpoint.close();
    home = "https://euc1-1.relay.n0.iroh.link/";
    await vi.advanceTimersByTimeAsync(30_000);
    expect(told).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

it("dials a Desktop through its relay without the dot its record has, so one on this endpoint's relay needs no second connection", async () => {
  const wasm = fakeWasm();
  const endpoint = await createIrohWebEndpoint(seed, { load: wasm.load });
  const desktop = { id: "e".repeat(64), relay: "https://use1-1.relay.n0.iroh.link./", addresses: ["192.0.2.1:4433"] };
  const browser = { id: "d".repeat(64), relay: "https://euc1-1.relay.n0.iroh.link/", addresses: [], relayed: true };
  const local = { id: "f".repeat(64), relay: "http://127.0.0.1:47085/", addresses: [] };
  const onLocal = await createIrohWebEndpoint(seed, { load: wasm.load, relays: ["http://127.0.0.1:47085"] });
  for (const descriptor of [desktop, browser]) await endpoint.connect(descriptor);
  await onLocal.connect(local);
  expect(wasm.dialled).toEqual([{ ...desktop, relay: "https://use1-1.relay.n0.iroh.link/" }, browser, local]);
  // The Desktop's relay is this endpoint's own, to the letter: the wasm keys its relay connections by that text.
  expect((wasm.dialled[0] as { relay: string }).relay).toBe(wasm.started[0][0]);
  noDottedHost(wasm.dialled.map(d => (d as { relay: string }).relay));
  await Promise.all([endpoint.close(), onLocal.close()]);
});

/**
 * The relay a contact's descriptor names is dialled by this device on its own, again on each redial: only https at a
 * public name or address, or one of this endpoint's own relays (a private network's, a test's). Never this machine or
 * its network, which would take requests the contact chose the host and port of.
 */
it("dials a contact through a public relay or one of its own, never one on this machine or its network", async () => {
  const wasm = fakeWasm();
  const endpoint = await createIrohWebEndpoint(seed, { load: wasm.load });
  const onLan = await createIrohWebEndpoint(seed, { load: wasm.load, relays: ["https://relay.example.com/", "https://10.0.0.2/", "http://localhost:4600"] });
  const contact = (relay: string | null) => ({ id: "f".repeat(64), relay, addresses: [] });
  for (const relay of ["http://127.0.0.1:4601", "http://localhost:4601/", "http://[::1]:4601/", "https://10.0.0.1/", "https://[::1]/", "https://192.168.1.2/",
    "https://169.254.169.254/", "https://100.64.0.1/", "https://[fd00::1]/", "https://localhost/", "https://router/", "https://nas.local/", "https://wiki.internal./"]) {
    await expect(endpoint.connect(contact(relay)), relay).rejects.toThrow("not one this device dials");
    await expect(onLan.connect(contact(relay)), relay).rejects.toThrow("not one this device dials");
  }
  expect(wasm.dialled).toEqual([]);
  // A public relay, or none (a direct address alone).
  for (const relay of ["https://relay.contact.example/", "https://iroh.miguelmedeiros.dev/", "https://8.8.8.8/", null]) await endpoint.connect(contact(relay));
  // The person's own relays, in either spelling.
  for (const relay of ["https://10.0.0.2", "http://localhost:4600/", "https://relay.example.com./"]) await onLan.connect(contact(relay));
  expect(wasm.dialled.map(d => (d as { relay: string | null }).relay)).toEqual([
    "https://relay.contact.example/", "https://iroh.miguelmedeiros.dev/", "https://8.8.8.8/", null, "https://10.0.0.2", "http://localhost:4600/", "https://relay.example.com/"]);
  await Promise.all([endpoint.close(), onLan.close()]);
});

/**
 * Hide my IP from contacts (WISP 100 § Relay only): the wasm reaches a contact through the relay its descriptor names,
 * so a contact who runs that relay would see this profile's address there. With `ownRelaysOnly` a contact is dialled
 * only on one of this endpoint's relays (either spelling), and nothing is opened toward any other.
 */
it("with ownRelaysOnly, dials a contact only through one of this endpoint's own relays", async () => {
  const wasm = fakeWasm({ home: 1 });
  const own = ["https://relay.example.com/", "https://use1-1.relay.n0.iroh.link/"];
  const endpoint = await createIrohWebEndpoint(seed, { load: wasm.load, relays: own, ownRelaysOnly: true });
  const later = await createIrohWebEndpoint(Buffer.alloc(32, 2).toString("base64url"), { load: wasm.load, relays: own, ownRelaysOnly: true });
  const onOwn = { id: "e".repeat(64), relay: "https://use1-1.relay.n0.iroh.link./", addresses: ["192.0.2.1:4433"] };
  const onTheirs = { id: "d".repeat(64), relay: "https://relay.contact.example/", addresses: [], relayed: true };
  const noRelay = { id: "f".repeat(64), relay: null, addresses: ["192.0.2.2:4433"] };
  await endpoint.connect(onOwn);
  await expect(endpoint.connect(onTheirs)).rejects.toThrow("not on one of this profile's Iroh relays");
  await expect(endpoint.connect(noRelay)).rejects.toThrow("not on one of this profile's Iroh relays");
  // One that started on the measured home alone still takes the whole list as its own.
  expect(wasm.started[wasm.started.length - 1]).toEqual([own[1]]);
  await later.connect({ ...onOwn, relay: own[0] });
  expect(wasm.dialled).toEqual([{ ...onOwn, relay: "https://use1-1.relay.n0.iroh.link/" }, { ...onOwn, relay: own[0] }]);
  // Without it (a link to the profile's own device), any relay is dialled as before.
  const device = await createIrohWebEndpoint(Buffer.alloc(32, 3).toString("base64url"), { load: wasm.load, relays: own });
  await device.connect(onTheirs);
  expect(wasm.dialled[wasm.dialled.length - 1]).toEqual(onTheirs);
  await Promise.all([endpoint.close(), later.close(), device.close()]);
});

/**
 * A contact's relay at a public name may still resolve to this machine or its network. Where a resolver is at hand (the
 * CLI), `publicRelay` is asked before each dial through a relay that is not one of the endpoint's own, and the wasm is
 * never given one whose name answers otherwise.
 */
it("with publicRelay, dials a contact's relay only while its name resolves to public addresses", async () => {
  const wasm = fakeWasm();
  const asked: string[] = [];
  const endpoint = await createIrohWebEndpoint(seed, { load: wasm.load, relays: ["https://relay.example.com/"],
    publicRelay: async relay => { asked.push(relay); return !relay.includes("contact"); } });
  const contact = (relay: string | null) => ({ id: "d".repeat(64), relay, addresses: [], relayed: true });
  await expect(endpoint.connect(contact("https://relay.contact.example./"))).rejects.toThrow("not one this device dials");
  await endpoint.connect(contact("https://relay.public.example/"));
  // One of its own relays (either spelling), or none: nothing to ask.
  await endpoint.connect(contact("https://relay.example.com./"));
  await endpoint.connect(contact(null));
  expect(asked).toEqual(["https://relay.contact.example/", "https://relay.public.example/"]);
  expect(wasm.dialled.map(d => (d as { relay: string | null }).relay)).toEqual(["https://relay.public.example/", "https://relay.example.com/", null]);
  await endpoint.close();
});

/**
 * Each endpoint pings every relay in its list about 1.3 times a minute, and an app runs up to 16 of them on one
 * network. The first measures; the others, started at the same time or later, home on its relay alone.
 */
it("measures the relays once per app: endpoints after the first start on its home relay alone", async () => {
  const wasm = fakeWasm({ home: 1 });
  const own = ["https://relay.example.com/", "http://127.0.0.1:47085"];
  const endpoints = await Promise.all([...[1, 2, 3].map(n => createIrohWebEndpoint(Buffer.alloc(32, n).toString("base64url"), { load: wasm.load })),
    createIrohWebEndpoint(seed, { load: wasm.load, relays: own })]);
  const later = await createIrohWebEndpoint(Buffer.alloc(32, 4).toString("base64url"), { load: wasm.load, relays: own });
  expect(wasm.started).toEqual([[...DEFAULT_IROH_RELAYS], own, [DEFAULT_IROH_RELAYS[1]], [DEFAULT_IROH_RELAYS[1]], ["http://127.0.0.1:47085"]]);
  expect(endpoints.slice(0, 3).map(e => (e.descriptor as { relay: string }).relay)).toEqual(Array(3).fill(DEFAULT_IROH_RELAYS[1]));
  expect((later.descriptor as { relay: string }).relay).toBe("http://127.0.0.1:47085/");
  await Promise.all([...endpoints, later].map(e => e.close()));
});

/**
 * One started on the measured home alone never leaves that relay by itself: with it down, 5 of 6 such listeners stayed
 * out of reach for the whole outage (local relays, 90 s), the one measuring homed elsewhere within 45 s. They follow it
 * (only with no channel open, which a new node ends), and one takes on the measuring when the one measuring closes.
 */
it("moves the endpoints on the measured home alone where the measuring one moved, and measures when it closes", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const started: string[][] = [];
    let measured = DEFAULT_IROH_RELAYS[1] as string;
    const conn = { binding: () => ({ transport: "iroh/1" as const, context: "00", identities: ["a", "b"] as [string, string] }), send: async () => {}, recv: () => new Promise<undefined>(() => {}), rtt: () => -1, close() {}, free() {} };
    const load = async (): Promise<IrohWasm> => ({
      IrohNode: {
        start: async (_seed, relays) => {
          started.push(relays);
          let accepted: ((value: typeof conn | undefined) => void) | null = null;
          return {
            // On the whole list it goes where it measures best; on one relay, it stays there.
            address: () => ({ id: "c".repeat(64), relay: relays.length > 1 ? measured : relays[0], addresses: [] }),
            connect: async () => conn,
            accept: () => new Promise<typeof conn | undefined>(resolve => { accepted = resolve; }),
            close: async () => { accepted?.(undefined); }, free() {},
          };
        },
      },
    });
    const first = await createIrohWebEndpoint(seed, { load });
    const second = await createIrohWebEndpoint(Buffer.alloc(32, 2).toString("base64url"), { load });
    const busy = await createIrohWebEndpoint(Buffer.alloc(32, 3).toString("base64url"), { load });
    expect(started).toEqual([[...DEFAULT_IROH_RELAYS], [DEFAULT_IROH_RELAYS[1]], [DEFAULT_IROH_RELAYS[1]]]);
    const told = vi.fn(), unavailable = vi.fn();
    second.onDescriptor = told; second.onUnavailable = unavailable;
    const live = await busy.connect({ id: "d".repeat(64), relay: DEFAULT_IROH_RELAYS[1], addresses: [] });

    // The relay they are on went down: the one measuring homed on another.
    measured = DEFAULT_IROH_RELAYS[3];
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started.slice(3)).toEqual([[DEFAULT_IROH_RELAYS[3]]]);
    expect((second.descriptor as { relay: string }).relay).toBe(DEFAULT_IROH_RELAYS[3]);
    expect(told).toHaveBeenCalled();
    expect(unavailable).not.toHaveBeenCalled();
    // The one with a channel open moves once it ends.
    expect((busy.descriptor as { relay: string }).relay).toBe(DEFAULT_IROH_RELAYS[1]);
    live.channel.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect((busy.descriptor as { relay: string }).relay).toBe(DEFAULT_IROH_RELAYS[3]);
    expect(started).toHaveLength(5);

    // Nobody measures any more: one of them does, the other stays on its home.
    await first.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started.slice(5)).toEqual([[...DEFAULT_IROH_RELAYS]]);
    measured = DEFAULT_IROH_RELAYS[0];
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started.slice(6)).toEqual([[DEFAULT_IROH_RELAYS[0]]]);
    expect([second, busy].map(e => (e.descriptor as { relay: string }).relay)).toEqual([DEFAULT_IROH_RELAYS[0], DEFAULT_IROH_RELAYS[0]]);
    expect(unavailable).not.toHaveBeenCalled();
    await Promise.all([second.close(), busy.close()]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started).toHaveLength(7);
  } finally { vi.useRealTimers(); }
});

it("measures every relay again when the home relay stops answering, or the first endpoint fails", async () => {
  let down = false;
  const wasm = fakeWasm({ home: 1, refuse: relays => down && relays.length === 1 });
  const first = await createIrohWebEndpoint(seed, { load: wasm.load });
  down = true;
  const second = await createIrohWebEndpoint(Buffer.alloc(32, 2).toString("base64url"), { load: wasm.load });
  expect(wasm.started).toEqual([[...DEFAULT_IROH_RELAYS], [DEFAULT_IROH_RELAYS[1]], [...DEFAULT_IROH_RELAYS]]);
  expect((second.descriptor as { relay: string }).relay).toBe(DEFAULT_IROH_RELAYS[1]);

  let calls = 0;
  const failing = fakeWasm({ home: 1, refuse: () => calls++ === 0 });
  const [lost, kept] = await Promise.allSettled([1, 2].map(n => createIrohWebEndpoint(Buffer.alloc(32, n).toString("base64url"), { load: failing.load })));
  expect(lost.status).toBe("rejected");
  expect(kept.status).toBe("fulfilled");
  expect(failing.started).toEqual([[...DEFAULT_IROH_RELAYS], [...DEFAULT_IROH_RELAYS]]);
  await Promise.all([first.close(), second.close(), (kept as PromiseFulfilledResult<{ close(): Promise<void> }>).value.close()]);
});
