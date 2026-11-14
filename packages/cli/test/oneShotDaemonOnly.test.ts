import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ghostly, home, ok } from "./support/cli";
// covers: headless.cli

/** A Pkarr relay on loopback that counts each request and holds each PUT `holdMs`, as a slow relay does. */
async function holdingRelay() {
  const relay = { url: "", requests: [] as string[], holdMs: 0, close: () => {} };
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      relay.requests.push(request.method ?? "?");
      if (request.method === "PUT") { setTimeout(() => response.writeHead(204).end(), relay.holdMs); return; }
      response.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  relay.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  relay.close = () => { server.closeAllConnections(); server.close(); };
  return relay;
}

/**
 * What only a daemon does (a call placed, a contact's app opened on a port, a served app opened, closed or spoken in) a
 * one-shot refuses whatever the network says. It opened the profile online first, put its records on the relays and
 * waited for its leave packet: "start `ghostly daemon --detach`" came after 10 s with a relay that does not answer.
 */
describe("a one-shot of what only a daemon does", { timeout: 120_000 }, () => {
  let relay: Awaited<ReturnType<typeof holdingRelay>>;
  const dir = home("one-shot-daemon-only");
  let env: NodeJS.ProcessEnv;
  let bob: string;

  beforeAll(async () => {
    relay = await holdingRelay();
    env = { GHOSTLY_PKARR_RELAYS: relay.url };
    bob = ok(await ghostly(["--home", dir, "invite", "create", "--label", "bob"], { env })).chat as string;
  });
  afterAll(() => relay?.close());

  it("refuses at once, with the words it had, and asks the relays nothing", async () => {
    relay.requests.length = 0;
    // Online, the close waits for a PUT: 6 s, twice the bound below.
    relay.holdMs = 6_000;
    const refusals: [string[], string, RegExp][] = [
      [["call", "start", bob], "unavailable", /^Calls need the daemon/],
      [["service", "open", bob, "web"], "unavailable", /^An opened service lives in the daemon/],
      [["app", "open", bob, "chess"], "not_found", /^No served app "chess"/],
      [["app", "close", bob, "chess"], "not_found", /^No served app "chess"/],
      [["app", "send", bob, "chess", "{}"], "not_found", /^No served app "chess"/],
    ];
    for (const [args, code, message] of refusals) {
      const started = Date.now();
      const result = await ghostly(["--home", dir, ...args], { env });
      expect(Date.now() - started, args.join(" ")).toBeLessThan(3_000);
      expect(result.json, args.join(" ")).toMatchObject({ error: { code, message: expect.stringMatching(message) } });
    }
    expect(relay.requests).toEqual([]);
  });
});
