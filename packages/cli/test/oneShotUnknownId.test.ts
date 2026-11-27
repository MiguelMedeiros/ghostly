import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";
// covers: headless.one-shot

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
 * A one-shot that names a proof, a service, a payment or a call by an id that names nothing (a typo, one removed) says
 * not_found, in the words, code and exit it always had, with no saved chat started. It started every one first: with 20
 * chats saved, 20 relay requests and 0.4-0.7 s more per typo. An id that names something still starts them.
 */
describe("a one-shot on an id that names nothing", { timeout: 120_000 }, () => {
  let relay: Awaited<ReturnType<typeof countingRelay>>;
  const dir = home("one-shot-unknown-id");
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    relay = await countingRelay();
    env = { GHOSTLY_PKARR_RELAYS: relay.url };
    for (const label of ["bob", "carol", "dave"]) ok(await ghostly(["--home", dir, "invite", "create", "--label", label], { env }));
  });
  afterAll(() => relay?.close());

  it.each([
    [["identity", "remove", "idx"], `No identity proof "idx" (ghostly identity list)`],
    [["service", "enable", "svcx"], `No service "svcx" (ghostly service list)`],
    [["service", "enable", "svcx", "--off"], `No service "svcx" (ghostly service list)`],
    [["service", "remove", "svcx"], `No service "svcx" (ghostly service list)`],
    [["payment", "reclaim", "payx"], `No payment "payx" (ghostly payment list)`],
    [["call", "hangup", "callx"], `No chat "callx" (ghostly chat list)`],
  ])("%j says not_found with no chat started", async (args, message) => {
    relay.requests.length = 0;
    expect(error(await ghostly(["--home", dir, ...args], { env }), "not_found", 3).message).toBe(message);
    expect(relay.requests).toEqual([]);
  });

  it("starts the saved chats for a service it has", async () => {
    const { service } = ok(await ghostly(["--home", dir, "service", "add", "Notes", "http://127.0.0.1:8080"], { env })) as { service: string };
    relay.requests.length = 0;
    expect(ok(await ghostly(["--home", dir, "service", "enable", service, "--off"], { env }))).toEqual({ service, enabled: false });
    expect(relay.requests.length).toBeGreaterThan(0);
  });
});
