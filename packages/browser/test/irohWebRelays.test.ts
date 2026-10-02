import { expect, it } from "vitest";
import { DEFAULT_IROH_RELAYS, createIrohWebEndpoint, irohRelayProblem, type IrohWasm } from "../src/platform/irohWeb";

// covers: transport.iroh-web, settings.network.iroh-relays

/**
 * What reaches the wasm Iroh. It compares relay URLs as text, so each goes in under one spelling, whichever way it
 * was written; and that spelling has no trailing dot, because WebKit (Safari, the iPhone app) opens no host name that
 * ends in one: neither the `wss://…/relay` socket nor the `https://…/ping` probe. A Desktop's record names its relay
 * with the dot, so this is the one place that keeps a browser from being asked to open it.
 */
function fakeWasm() {
  const started: string[][] = [], dialled: unknown[] = [];
  const conn = { binding: () => ({ transport: "iroh/1" as const, context: "00", identities: ["a", "b"] as [string, string] }), send: async () => {}, recv: () => new Promise<undefined>(() => {}), rtt: () => -1, close() {}, free() {} };
  const load = async (): Promise<IrohWasm> => ({
    IrohNode: {
      start: async (_seed, relays) => {
        started.push(relays);
        return {
          address: () => ({ id: "c".repeat(64), relay: relays[0], addresses: [] }),
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

it("lists the default relays in the spelling every browser opens: no trailing dot", () => {
  expect(DEFAULT_IROH_RELAYS).toHaveLength(4);
  for (const relay of DEFAULT_IROH_RELAYS) {
    expect(relay).toMatch(/^https:\/\/[a-z0-9-]+\.relay\.n0\.iroh\.link\/$/);
    expect(irohRelayProblem(relay)).toBeNull();
  }
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

it("dials a Desktop through its relay without the dot its record has, so one on this endpoint's relay needs no second connection", async () => {
  const wasm = fakeWasm();
  const endpoint = await createIrohWebEndpoint(seed, { load: wasm.load });
  const desktop = { id: "e".repeat(64), relay: "https://use1-1.relay.n0.iroh.link./", addresses: ["192.0.2.1:4433"] };
  const browser = { id: "d".repeat(64), relay: "https://euc1-1.relay.n0.iroh.link/", addresses: [], relayed: true };
  const local = { id: "f".repeat(64), relay: "http://127.0.0.1:47085/", addresses: [] };
  for (const descriptor of [desktop, browser, local]) await endpoint.connect(descriptor);
  expect(wasm.dialled).toEqual([{ ...desktop, relay: "https://use1-1.relay.n0.iroh.link/" }, browser, local]);
  // The Desktop's relay is this endpoint's own, to the letter: the wasm keys its relay connections by that text.
  expect((wasm.dialled[0] as { relay: string }).relay).toBe(wasm.started[0][0]);
  noDottedHost(wasm.dialled.map(d => (d as { relay: string }).relay));
  await endpoint.close();
});
