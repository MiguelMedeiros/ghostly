import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";
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
 * A one-shot whose argument has the wrong shape (no invoice, token, mint URL, identity provider, group link or local
 * service) is refused before the profile opens, in the words, code and exit it always had. It opened the profile online
 * and started every saved chat first: with 10 chats saved each typo cost 20 relay requests, the run's whole budget,
 * and 0.4 s more (1.4 s with 100 chats), for the refusal `invite join` gives a word that is no invite with none.
 */
describe("a one-shot with a malformed argument", { timeout: 120_000 }, () => {
  let relay: Awaited<ReturnType<typeof countingRelay>>;
  const dir = home("one-shot-bad-shape");
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    relay = await countingRelay();
    env = { GHOSTLY_PKARR_RELAYS: relay.url };
    for (const label of ["bob", "carol", "dave"]) ok(await ghostly(["--home", dir, "invite", "create", "--label", label], { env }));
  });
  afterAll(() => relay?.close());

  it.each([
    [["pay", "notaninvoice"], "bad_request", 1, "Not a Lightning invoice, Lightning address or LNURL"],
    [["wallet", "redeem", "notatoken"], "bad_request", 1, "That is not a valid ecash token"],
    [["wallet", "add-mint", "notaurl"], "bad_request", 1, "That is not a valid mint URL"],
    [["wallet", "add-mint", "http://mint.example"], "bad_request", 1, "Mints must use https"],
    [["identity", "add", "bogus", "x"], "not_found", 3, "No identity provider bogus (ghostly identity providers)"],
    [["group", "join", "notalink"], "bad_request", 1, "This is not a link to a group"],
    [["service", "add", "s", "http://example.com:80"], "refused", 1, "Only services on this machine can be shared (localhost, 127.0.0.1 or [::1]): http://example.com/"],
  ])("%j is refused with no chat started", async (args, code, exit, message) => {
    relay.requests.length = 0;
    expect(error(await ghostly(["--home", dir, ...args], { env }), code, exit).message).toBe(message);
    expect(relay.requests).toEqual([]);
  });
});
