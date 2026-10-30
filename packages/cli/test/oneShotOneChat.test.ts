import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { oneChatOnly } from "../src/main";
import { ghostly, home, hyperdhtTestnet, ok, Running } from "./support/cli";
// covers: headless.one-shot

/** Pkarr relays on loopback that keep one store between them: each counts the requests that came to it. */
async function relays(count: number) {
  const packets = new Map<string, Buffer>();
  return Promise.all(Array.from({ length: count }, async () => {
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
          response.writeHead(body.length >= 72 ? 204 : 400).end();
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
  }));
}

/**
 * A one-shot about one 1:1 chat (`send`, `chat wait`) or one that joins a chat (`invite join`) starts that chat only.
 * It started every saved chat: each put its records and its leave packet on the relays, and with 12 unused invites
 * saved one `send` took the relays' 30 requests a minute (60 on two). Bob's requests come to a relay of his own,
 * which shares its store with Carol's: only his are counted.
 */
describe("a one-shot about one chat", { timeout: 180_000 }, () => {
  let bobRelay: Awaited<ReturnType<typeof relays>>[number], carolRelay: typeof bobRelay;
  let dht: Awaited<ReturnType<typeof hyperdhtTestnet>>;
  const bob = home("one-shot-one-chat-bob"), carol = home("one-shot-one-chat-carol");
  const running: Running[] = [];
  let bobEnv: NodeJS.ProcessEnv, carolEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    [bobRelay, carolRelay] = await relays(2);
    dht = await hyperdhtTestnet();
    bobEnv = { GHOSTLY_PKARR_RELAYS: bobRelay.url, GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap };
    carolEnv = { GHOSTLY_PKARR_RELAYS: carolRelay.url, GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap };
    // Twelve invites nobody took, made through Bob's daemon (it answers at once when the relays hold them back).
    const daemon = new Running(["--home", bob, "daemon"], bobEnv);
    running.push(daemon);
    await daemon.waitFor((l) => l.daemon === "ready");
    for (let i = 0; i < 12; i++) ok(await ghostly(["--home", bob, "invite", "create", "--label", `unused${i}`], { env: bobEnv }));
    ok(await ghostly(["--home", bob, "daemon", "stop"], { env: bobEnv }));
    await daemon.exited(20_000);
    const carolDaemon = new Running(["--home", carol, "daemon"], carolEnv);
    running.push(carolDaemon);
    await carolDaemon.waitFor((l) => l.daemon === "ready");
  }, 120_000);
  afterAll(async () => {
    await Promise.all(running.map((r) => r.stop()));
    await dht?.destroy();
    bobRelay?.close(); carolRelay?.close();
  }, 30_000);

  /** Bob's relay requests while `args` runs as a one-shot on his profile. */
  const counted = async (args: string[]) => {
    bobRelay.requests.length = 0;
    const result = await ghostly(["--home", bob, ...args], { env: bobEnv });
    return { result, requests: bobRelay.requests.length };
  };

  it("invite join starts the joined chat only, and send and chat wait the chat they name", async () => {
    const invite = ok(await ghostly(["--home", carol, "invite", "create", "--label", "bob"], { env: carolEnv }));
    const join = await counted(["invite", "join", invite.link as string, "--label", "carol"]);
    const wait = await counted(["chat", "wait", "carol", "--until", "live", "--timeout", "60"]);
    const send = await counted(["send", "carol", "hello from a one-shot"]);
    // The chat named started: it paired, went live with Carol's daemon, and took the text.
    expect(ok(join.result)).toMatchObject({ paired: true });
    expect(ok(wait.result)).toMatchObject({ live: true });
    expect(ok(send.result)).toMatchObject({ chat: join.result.json.chat, delivery: expect.stringMatching(/^(sent|delivered)$/) });
    // 13 chats started asked the relay its whole 30 a minute; the one chat named asks it 6 to 20 times.
    for (const [name, requests] of [["invite join", join.requests], ["chat wait", wait.requests], ["send", send.requests]] as const) {
      expect(requests, name).toBeLessThan(24);
    }
  });

  it("starts every chat for a call that names none, or one that may name a group", () => {
    expect(oneChatOnly("invite.join", { invite: "ghostly1…" })).toBe(true);
    expect(oneChatOnly("file.send", { chat: "carol", path: "a.txt" })).toBe(true);
    expect(oneChatOnly("usage.send", { all: true })).toBe(false);
    expect(oneChatOnly("task.send", { chat: "Sala" })).toBe(false);
    expect(oneChatOnly("group.send", { group: "Sala", chat: "carol" })).toBe(false);
    expect(oneChatOnly("invite.create", {})).toBe(false);
  });
});
