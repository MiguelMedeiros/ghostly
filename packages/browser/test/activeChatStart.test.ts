import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";

// covers: chat.dht.fallback, invite.delivery-mode

const transport = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
let node: GhostlyNode | undefined;
afterEach(async () => { await node?.shutdown(); node = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

type Live = { link: { session: { active: boolean }; dht: { active: boolean } } | null };

/**
 * A new chat's page opens it while the engine is still saving it: `setActiveLink` comes before the chat's link exists.
 * The link started then is the chat on screen all the same. It was not: the inviter read its contact's mailbox every 30 s
 * in the background, and a contact who chose DHT only right after going live stayed "On DHT · retrying live" for a minute.
 */
it("a chat opened while the engine still saves it reads its contact as the chat on screen", async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport: transport as never, automaticWallets: false, nativeTransports: {} });
  await node.start();
  const links = (node as unknown as { links: Map<string, Live> }).links;
  const putLink = db.putLink.bind(db);
  let opened: string | undefined;
  vi.spyOn(db, "putLink").mockImplementation(async (stored) => {
    // The page opens the chat now: the engine knows it, its link is not started yet.
    if (!opened) { opened = stored.id; expect(links.get(stored.id)?.link ?? null).toBeNull(); node!.setActiveLink({ linkId: stored.id }); }
    return putLink(stored);
  });
  const { linkId } = await node.createLink();
  expect(opened).toBe(linkId);
  const link = links.get(linkId)!.link!;
  expect(link.session.active).toBe(true);
  expect(link.dht.active).toBe(true);
}, 20000);
