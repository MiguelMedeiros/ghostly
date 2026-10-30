import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ghostly, home, hyperdhtTestnet, ok, Running } from "./support/cli";
// covers: headless.cli

/** A Pkarr relay on loopback that counts each request. */
async function countingRelay() {
  const packets = new Map<string, Buffer>();
  const relay = { url: "", requests: [] as string[], close: () => {} };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (c: Buffer) => chunks.push(c));
    request.on("end", () => {
      relay.requests.push(request.method ?? "?");
      const key = new URL(request.url ?? "/", "http://relay").pathname.slice(1);
      if (request.method === "PUT") {
        const body = Buffer.concat(chunks), known = packets.get(key);
        if (body.length >= 72 && (!known || body.readBigUInt64BE(64) >= known.readBigUInt64BE(64))) packets.set(key, body);
        response.writeHead(204).end();
        return;
      }
      const packet = packets.get(key);
      response.writeHead(packet ? 200 : 404).end(packet);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  relay.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  relay.close = () => { server.closeAllConnections(); server.close(); };
  return relay;
}

/**
 * A one-shot `invite join` (no daemon) starts the joined chat only. It started every saved chat too, each of which put
 * its records and its leave packet on the relays: from about 10 saved chats that was the relays' whole minute, the
 * join's own publishes and reads waited behind them, and the one-shot waited its whole 60 s and left unpaired.
 */
describe("a one-shot invite join in a profile with many chats", { timeout: 240_000 }, () => {
  let relay: Awaited<ReturnType<typeof countingRelay>>;
  let dht: Awaited<ReturnType<typeof hyperdhtTestnet>>;
  const inviter = home("one-shot-join-inviter"), joiner = home("one-shot-join-joiner");
  const running: Running[] = [];
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    relay = await countingRelay();
    dht = await hyperdhtTestnet();
    env = { GHOSTLY_PKARR_RELAYS: relay.url, GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap };
    // Twelve saved chats on the joiner's side (invites nobody used yet), made through a daemon, then stopped.
    const daemon = new Running(["--home", joiner, "daemon"], env);
    await daemon.waitFor((line) => line.daemon === "ready");
    for (let i = 0; i < 12; i++) ok(await ghostly(["--home", joiner, "invite", "create", "--label", `saved${i}`], { env }));
    ok(await ghostly(["--home", joiner, "daemon", "stop"], { env }));
    await daemon.exited(30_000);
    // The inviter stays online on its daemon.
    const online = new Running(["--home", inviter, "daemon"], env);
    running.push(online);
    await online.waitFor((line) => line.daemon === "ready");
  }, 180_000);
  afterAll(async () => {
    await Promise.all(running.map((r) => r.stop()));
    await dht?.destroy();
    relay?.close();
  }, 30_000);

  it("pairs in a few seconds", async () => {
    const { link } = ok(await ghostly(["--home", inviter, "invite", "create", "--label", "joiner"], { env })) as { link: string };
    const started = Date.now();
    const joined = ok(await ghostly(["--home", joiner, "invite", "join", link, "--label", "inviter"], { env }));
    expect({ paired: joined.paired, fast: Date.now() - started < 20_000 }).toEqual({ paired: true, fast: true });
    // Joined again (the same invite, now a saved chat of this profile): that chat starts, and the answer is the same chat.
    const again = ok(await ghostly(["--home", joiner, "invite", "join", link], { env }));
    expect(again).toMatchObject({ chat: joined.chat, paired: true });
    expect((ok(await ghostly(["--home", joiner, "chat", "list"], { env })).chats as unknown[]).length).toBe(13);
  });
});
