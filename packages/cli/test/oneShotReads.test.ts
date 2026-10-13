import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ghostly, home, ok } from "./support/cli";
// covers: headless.cli

/**
 * A Pkarr relay on loopback that counts each request. `silent`: it takes requests and never answers them, as a relay
 * that hangs does.
 */
async function countingRelay() {
  const packets = new Map<string, Buffer>();
  const relay = { url: "", requests: [] as string[], silent: false, close: () => {} };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (c: Buffer) => chunks.push(c));
    request.on("end", () => {
      relay.requests.push(request.method ?? "?");
      if (relay.silent) return;
      const key = new URL(request.url ?? "/", "http://relay").pathname.slice(1);
      if (request.method === "PUT") { packets.set(key, Buffer.concat(chunks)); response.writeHead(204).end(); return; }
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
 * A one-shot that only reads (status, a chat list, the settings) answers from the profile's store and says nothing to
 * the network. Opened online, each started every chat, put the profile's records on the relays again and waited for
 * its leave packet to be taken: 3 s and more with a slow relay, 10 s with one that does not answer.
 */
describe("a one-shot that only reads", { timeout: 90_000 }, () => {
  let relay: Awaited<ReturnType<typeof countingRelay>>;
  const dir = home("one-shot-reads");
  let env: NodeJS.ProcessEnv;
  let chat: string;
  const reads = () => [
    ["status"], ["chat", "list"], ["chat", "show", chat], ["chat", "history", chat], ["settings", "get"], ["group", "list"], ["profile", "show"], ["events"],
  ];

  beforeAll(async () => {
    relay = await countingRelay();
    env = { GHOSTLY_PKARR_RELAYS: relay.url };
    chat = ok(await ghostly(["--home", dir, "invite", "create", "--label", "bob"], { env })).chat as string;
  });
  afterAll(() => relay?.close());

  it("asks the relays nothing", async () => {
    relay.requests.length = 0;
    for (const args of reads()) ok(await ghostly(["--home", dir, ...args], { env }));
    expect(relay.requests).toEqual([]);
  });

  it("answers at once when the relay does not answer", async () => {
    relay.silent = true;
    for (const args of reads().slice(0, 3)) {
      const started = Date.now();
      ok(await ghostly(["--home", dir, ...args], { env }));
      expect(Date.now() - started, args.join(" ")).toBeLessThan(5_000);
    }
  });
});
