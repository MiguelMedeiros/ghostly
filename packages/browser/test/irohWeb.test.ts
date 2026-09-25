import "fake-indexeddb/auto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { GhostLink, createIdentity, createLink, type NativeEndpoint, type PairingState } from "@ghostly/core";
import { db } from "../src/engine/db";
import { createIrohWebEndpoint, type IrohWasm } from "../src/platform/irohWeb";
import { nativePeer } from "./helpers/nativePeer";
// covers-gated: transport.iroh-web

/**
 * Iroh in the browser build (wasm, relay only) against itself and against the
 * Desktop's native Iroh, through a real `iroh-relay`. Paired sessions run the
 * whole core handshake: the pin and the binding check see the TLS exporter the
 * wasm computed. Runs when GHOSTLY_IROH_RELAY_URL is set (the e2e infra's relay: `npm run e2e:infra:use` writes it to .env.e2e).
 */
const RELAY = process.env.GHOSTLY_IROH_RELAY_URL;
const NATIVE = resolve("../../target/debug/examples/iroh-peer");

const loadNode = async (): Promise<IrohWasm> => {
  const module = await import("@ghostly/iroh-web");
  const wasm = createRequire(import.meta.url).resolve("@ghostly/iroh-web/wasm");
  module.initSync({ module: readFileSync(wasm) });
  return module as unknown as IrohWasm;
};
const seed = (n: number) => Buffer.alloc(32, n).toString("base64url");
const opened: NativeEndpoint[] = [];
afterAll(async () => { await Promise.all(opened.map(endpoint => endpoint.close())); });

async function pair(endpoints: [NativeEndpoint, NativeEndpoint], name: string) {
  const invitation = createLink();
  const params = [invitation.mine, invitation.invite];
  const identities = [createIdentity(), createIdentity()];
  const states: PairingState[] = [{ status: "connecting" }, { status: "connecting" }];
  const received: string[][] = [[], []];
  const links: GhostLink[] = [];
  for (let i = 0; i < 2; i++) {
    const id = `${name}-${i}`;
    await db.putLink({ ...params[i], id, profile: "paired-chat/1", participationSeed: identities[i].seedB64, createdAt: 1 });
    links[i] = new GhostLink({ params: { ...params[i], profile: "paired-chat/1" }, rtcAvailable: false,
      pairing: { credentials: { seedB64: identities[i].seedB64 }, pinPeer: (key, signed) => db.pinPeer(id, key, signed) },
      native: { preferred: "iroh/1", fallback: false, peerDescriptors: { "iroh/1": endpoints[1 - i].descriptor }, peerTransports: ["iroh/1"] },
      transport: { publish: vi.fn(), resolve: async () => null, describe: () => ({ protocol: "unused local test discovery", relays: [] }) },
      createPeerConnection: () => { throw new Error("WebRTC must not be used"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
      events: {
        onPairingState: state => { states[i] = state; },
        onMessage: async message => { received[i].push(message.text); },
      },
    });
    links[i].registerEndpoint(endpoints[i]);
  }
  return { links, states, received };
}

it.skipIf(!RELAY)("two browsers pair and chat over Iroh through a relay, with the same binding on both sides", async () => {
  const web = await Promise.all([41, 42].map(n => createIrohWebEndpoint(seed(n), { relays: [RELAY!], load: loadNode })));
  opened.push(...web);
  expect(web.map(e => (e.descriptor as { addresses: string[] }).addresses)).toEqual([[], []]);
  const { links, states, received } = await pair([web[0], web[1]], "iroh-web");
  try {
    const started = Date.now();
    await links[0].connect(15000);
    await vi.waitFor(() => expect(states.map(s => s.status)).toEqual(["ready", "ready"]), { timeout: 15000 });
    console.info(`web-web paired over the relay in ${Date.now() - started} ms`);
    expect(states.every(s => s.transport === "iroh/1")).toBe(true);
    expect(states[0].code).toBe(states[1].code);
    expect(await links[0].sendMessage("hello from a browser over Iroh")).toBeNull();
    await vi.waitFor(() => expect(received[1]).toEqual(["hello from a browser over Iroh"]));
    // A frame close to the 60 KiB transport budget crosses whole.
    expect(await links[1].sendMessage("x".repeat(16 * 1024 - 1))).toBeNull();
    await vi.waitFor(() => expect(received[0][0]).toHaveLength(16 * 1024 - 1));
  } finally {
    await Promise.all(links.map(link => link.stop(false)));
  }
}, 40000);

it.skipIf(!RELAY || !existsSync(NATIVE))("a browser and the Desktop's native Iroh pair through the same relay, either side dialling", async () => {
  for (const dialler of [0, 1]) {
    // A stopped link closes its endpoints: each direction gets fresh ones.
    const [webEndpoint, native] = await Promise.all([
      createIrohWebEndpoint(seed(43 + dialler), { relays: [RELAY!], load: loadNode }),
      nativePeer(NATIVE, 53 + dialler, { relays: [RELAY!] }),
    ]);
    expect((native.descriptor as { relay: string }).relay).toMatch(/^http/);
    const { links, states, received } = await pair([webEndpoint, native], `iroh-web-native-${dialler}`);
    try {
      await links[dialler].connect(15000);
      await vi.waitFor(() => expect(states.map(s => s.status)).toEqual(["ready", "ready"]), { timeout: 15000 });
      expect(states.every(s => s.transport === "iroh/1")).toBe(true);
      expect(await links[0].sendMessage(`web to desktop ${dialler}`)).toBeNull();
      expect(await links[1].sendMessage(`desktop to web ${dialler}`)).toBeNull();
      await vi.waitFor(() => expect(received).toEqual([[`desktop to web ${dialler}`], [`web to desktop ${dialler}`]]));
    } finally {
      await Promise.all(links.map(link => link.stop(false)));
    }
  }
}, 60000);

it.skipIf(!RELAY)("refuses a contact with no relay and a seed of the wrong size", async () => {
  const endpoint = await createIrohWebEndpoint(seed(47), { relays: [RELAY!], load: loadNode });
  opened.push(endpoint);
  await expect(endpoint.connect({ id: "a".repeat(64), relay: null, addresses: ["127.0.0.1:1"] })).rejects.toThrow(/no Iroh relay|Invalid Iroh endpoint ID/);
  await expect(createIrohWebEndpoint(Buffer.alloc(16).toString("base64url"), { relays: [RELAY!], load: loadNode })).rejects.toThrow("Invalid transport seed");
});
