import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity, createLink } from "@ghostly/core";
import { EngineServer } from "../src/engine/server";
import { db } from "../src/engine/db";

// Counts the engine's derivations of a public key from a seed.
const derived = vi.hoisted(() => ({ seeds: [] as string[] }));
vi.mock("@ghostly/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ghostly/core")>();
  return { ...actual, identityFromSeedB64: (seedB64: string) => { derived.seeds.push(seedB64); return actual.identityFromSeedB64(seedB64); } };
});

const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
const servers: EngineServer[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.node.shutdown(); });

describe("a chat's participation key", () => {
  it("is derived from its seed once, not at every state built", async () => {
    await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
    const seeds = new Set<string>();
    for (let c = 0; c < 20; c++) {
      const seed = createIdentity().seedB64;
      seeds.add(seed);
      await db.putLink({ ...createLink().mine, id: `paired-${c}`, profile: "paired-chat/1", participationSeed: seed, pairedPeerKey: createIdentity().pubKeyZ32, createdAt: 1 });
    }
    const server = new EngineServer({ automaticWallets: false, transport: fixture });
    servers.push(server);
    await server.ready;
    const first = server.node.getState();
    expect(first.links.filter((l) => l.participationKey).length).toBe(20);
    derived.seeds.length = 0;
    for (let i = 0; i < 5; i++) server.node.getState();
    expect(derived.seeds.filter((s) => seeds.has(s)).length).toBe(0);
  }, 60_000);
});
