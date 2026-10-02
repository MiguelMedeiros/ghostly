import { expect, it } from "vitest";
import { DEFAULT_IROH_RELAYS, createIrohWebEndpoint, irohRelayProblem, type IrohWasm } from "../src/platform/irohWeb";

// covers: transport.iroh-web, settings.network.iroh-relays

/**
 * What reaches the wasm Iroh: it compares relay URLs as text, so each goes in under one spelling (a domain name with
 * its trailing dot, as n0's relays and the Desktop's records have it), whichever way it was written.
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

it("names the default relays as Iroh does, with the trailing dot", () => {
  expect(DEFAULT_IROH_RELAYS).toHaveLength(4);
  for (const relay of DEFAULT_IROH_RELAYS) {
    expect(relay).toMatch(/^https:\/\/[a-z0-9-]+\.relay\.n0\.iroh\.link\.\/$/);
    expect(irohRelayProblem(relay)).toBeNull();
  }
});

it("homes on the same relays whichever way they are spelled, and publishes that spelling", async () => {
  const wasm = fakeWasm();
  const byDefault = await createIrohWebEndpoint(seed, { load: wasm.load });
  // As Settings kept them from before the defaults had the dot, and as a person types a relay of their own.
  const typed = await createIrohWebEndpoint(seed, { load: wasm.load, relays: ["https://use1-1.relay.n0.iroh.link/", "https://use1-1.relay.n0.iroh.link./", "https://relay.example.com", "http://127.0.0.1:47085"] });
  expect(wasm.started).toEqual([
    [...DEFAULT_IROH_RELAYS],
    ["https://use1-1.relay.n0.iroh.link./", "https://relay.example.com./", "http://127.0.0.1:47085"],
  ]);
  expect(byDefault.descriptor).toEqual({ id: "c".repeat(64), relay: "https://use1-1.relay.n0.iroh.link./", addresses: [], relayed: true });
  await Promise.all([byDefault.close(), typed.close()]);
});

it("dials a contact through its relay in that spelling, so one on this endpoint's relay needs no second connection", async () => {
  const wasm = fakeWasm();
  const endpoint = await createIrohWebEndpoint(seed, { load: wasm.load });
  const older = { id: "d".repeat(64), relay: "https://use1-1.relay.n0.iroh.link/", addresses: [], relayed: true };
  const desktop = { id: "e".repeat(64), relay: "https://euc1-1.relay.n0.iroh.link./", addresses: ["192.0.2.1:4433"] };
  const local = { id: "f".repeat(64), relay: "http://127.0.0.1:47085/", addresses: [] };
  for (const descriptor of [older, desktop, local]) await endpoint.connect(descriptor);
  expect(wasm.dialled).toEqual([{ ...older, relay: "https://use1-1.relay.n0.iroh.link./" }, desktop, local]);
  await endpoint.close();
});
