import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ghostly, home, ok, Running } from "./support/cli";
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
        packets.set(key, Buffer.concat(chunks));
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
 * A one-shot `invite create` (no daemon) starts the new invite's chat only. It started every saved chat too, each of
 * which put its records and its leave packet on the relays: from about 10 saved chats that was the relays' whole minute
 * (30 requests a relay), the new invite's records waited behind them, and the command waited its 20 s for them (21 s
 * instead of under a second, and `published: false`).
 */
describe("a one-shot invite create in a profile with many chats", { timeout: 180_000 }, () => {
  let relay: Awaited<ReturnType<typeof countingRelay>>;
  const dir = home("one-shot-invite-create");
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    relay = await countingRelay();
    env = { GHOSTLY_PKARR_RELAYS: relay.url };
    // Twelve saved chats (invites nobody used yet), made through a daemon, which publishes them at its own pace.
    const daemon = new Running(["--home", dir, "daemon"], env);
    await daemon.waitFor((line) => line.daemon === "ready");
    for (let i = 0; i < 12; i++) ok(await ghostly(["--home", dir, "invite", "create", "--label", `saved${i}`], { env }));
    ok(await ghostly(["--home", dir, "daemon", "stop"], { env }));
    await daemon.exited(30_000);
  }, 120_000);
  afterAll(() => relay?.close());

  it("is published at once, asking the relays about the new invite only", async () => {
    relay.requests.length = 0;
    const started = Date.now();
    const created = ok(await ghostly(["--home", dir, "invite", "create", "--label", "new"], { env }));
    const ms = Date.now() - started;
    expect({ published: created.published, requests: relay.requests.length <= 15 ? "few" : relay.requests.length }).toEqual({ published: true, requests: "few" });
    expect(ms).toBeLessThan(10_000);
    // The saved chats are still there, and a one-shot for one of them goes on as before.
    expect((ok(await ghostly(["--home", dir, "chat", "list"], { env })).chats as unknown[]).length).toBe(13);
  });
});
