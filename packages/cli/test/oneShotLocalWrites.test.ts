import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ghostly, home, ok } from "./support/cli";
// covers: headless.cli

/** A Pkarr relay on loopback that counts each request; `holdMs`: how long it holds each PUT, as a slow relay does. */
async function countingRelay() {
  const packets = new Map<string, Buffer>();
  const relay = { url: "", requests: [] as string[], holdMs: 0, close: () => {} };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (c: Buffer) => chunks.push(c));
    request.on("end", () => {
      relay.requests.push(request.method ?? "?");
      const key = new URL(request.url ?? "/", "http://relay").pathname.slice(1);
      if (request.method === "PUT") {
        packets.set(key, Buffer.concat(chunks));
        setTimeout(() => response.writeHead(204).end(), relay.holdMs);
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
 * A one-shot whose change stays on this device (a chat's name, a chat removed, a setting of this device, auto-answer, a
 * proof dropped, a web app added) opens the profile offline, as the reads do: no relay request and no time waiting
 * for one. Opened online, each put the profile's records on the relays and waited for two PUTs: 6 PUT + 4 GET and
 * 3.3 s each with a relay that takes 1.5 s, and the contacts' apps saw this device come online for each rename.
 */
describe("a one-shot that changes only this device", { timeout: 120_000 }, () => {
  let relay: Awaited<ReturnType<typeof countingRelay>>;
  const dir = home("one-shot-local-writes");
  let env: NodeJS.ProcessEnv;
  let bob: string, carol: string;

  beforeAll(async () => {
    relay = await countingRelay();
    env = { GHOSTLY_PKARR_RELAYS: relay.url };
    bob = ok(await ghostly(["--home", dir, "invite", "create", "--label", "bob"], { env })).chat as string;
    carol = ok(await ghostly(["--home", dir, "invite", "create", "--label", "carol"], { env })).chat as string;
  });
  afterAll(() => relay?.close());

  it("asks the relays nothing, answers at once with a slow relay, and keeps what it changed", async () => {
    relay.requests.length = 0;
    relay.holdMs = 1_500;
    const writes = [
      ["chat", "rename", bob, "Bobby"], ["settings", "set", "sendTyping", "false"], ["settings", "set", "autoDownloads", "false"],
      ["settings", "set", "serveFiles", "false"], ["call", "auto", "on"], ["call", "auto", "off"], ["call", "auto", "on"],
      ["service", "add", "web", "http://127.0.0.1:46049"], ["chat", "remove", carol, "--yes"],
    ];
    for (const args of writes) {
      const started = Date.now();
      ok(await ghostly(["--home", dir, ...args], { env }));
      expect(Date.now() - started, args.join(" ")).toBeLessThan(1_500);
    }
    // A proof not started here: said as before, with nothing asked of the relays either.
    expect((await ghostly(["--home", dir, "identity", "cancel", "no-such-draft"], { env })).code).not.toBe(0);
    expect(relay.requests).toEqual([]);

    // Kept: the process's last writes reach the store before it closes (they are not awaited where they are made).
    expect(ok(await ghostly(["--home", dir, "chat", "show", bob], { env }))).toMatchObject({ name: "Bobby" });
    expect((await ghostly(["--home", dir, "chat", "show", carol], { env })).code).not.toBe(0);
    expect(ok(await ghostly(["--home", dir, "settings", "get"], { env }))).toMatchObject({ sendTyping: false, autoDownloads: false, serveFiles: false });
    expect(ok(await ghostly(["--home", dir, "call", "auto"], { env }))).toMatchObject({ autoAnswer: { on: true } });
    expect(JSON.stringify(ok(await ghostly(["--home", dir, "service", "list"], { env })))).toContain("http://127.0.0.1:46049");
    expect(relay.requests).toEqual([]);
  });

  it("still goes online for a setting the contacts or the relays see", async () => {
    relay.requests.length = 0;
    relay.holdMs = 0;
    ok(await ghostly(["--home", dir, "settings", "set", "nick", "Bot"], { env }));
    expect(relay.requests).toContain("PUT");
  });
});
