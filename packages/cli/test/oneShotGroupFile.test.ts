import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatOnly, oneChatOnly } from "../src/main";
import { ghostly, home, hyperdhtTestnet, ok, Running } from "./support/cli";
// covers: groups.files, headless.one-shot

/** Pkarr relays on loopback, on this test's ports, that keep one store between them: each counts its requests. */
async function relays(ports: number[]) {
  const packets = new Map<string, Buffer>();
  return Promise.all(ports.map(async (port) => {
    const relay = { url: `http://127.0.0.1:${port}`, requests: 0, close: () => {} };
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (c: Buffer) => chunks.push(c));
      request.on("end", () => {
        relay.requests++;
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
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    relay.close = () => { server.closeAllConnections(); server.close(); };
    return relay;
  }));
}

async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  let value = await read();
  while (!done(value)) {
    if (Date.now() > end) throw new Error(`${what}: not done in ${ms / 1000} s; last ${JSON.stringify(value).slice(0, 1500)}`);
    await new Promise((r) => setTimeout(r, 1000));
    value = await read();
  }
  return value;
}

/**
 * `file send <group>` as a one-shot: it opened the profile with the groups unstarted (it was taken for a 1:1 chat's
 * command), so the file's message never left the device (no relay request), and the answer, exit 0, said nothing of
 * it. It starts the groups as `group send` and `pin` do, and waits until a member's edge took the message. Bob's
 * requests come to a relay of his own, which shares its store with Carol's: only his are counted.
 */
describe("a one-shot file send to a group", { timeout: 300_000 }, () => {
  let bobRelay: Awaited<ReturnType<typeof relays>>[number], carolRelay: typeof bobRelay;
  let dht: Awaited<ReturnType<typeof hyperdhtTestnet>>;
  const bob = home("one-shot-group-file-bob"), carol = home("one-shot-group-file-carol");
  const running: Running[] = [];
  let bobEnv: NodeJS.ProcessEnv, carolEnv: NodeJS.ProcessEnv;
  const as = (dir: string, ...args: string[]) => ghostly(["--home", dir, ...args], { env: dir === bob ? bobEnv : carolEnv });

  beforeAll(async () => {
    [bobRelay, carolRelay] = await relays([16040, 16041]);
    dht = await hyperdhtTestnet();
    bobEnv = { GHOSTLY_PKARR_RELAYS: bobRelay.url, GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap };
    carolEnv = { GHOSTLY_PKARR_RELAYS: carolRelay.url, GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap };
  }, 60_000);
  afterAll(async () => {
    await Promise.all(running.map((r) => r.stop()));
    await dht?.destroy();
    bobRelay?.close(); carolRelay?.close();
  }, 30_000);

  it("starts the groups, and answers once a member's edge took the file's message", async () => {
    const daemons = [bob, carol].map((dir) => new Running(["--home", dir, "daemon"], dir === bob ? bobEnv : carolEnv));
    running.push(...daemons);
    await Promise.all(daemons.map((d) => d.waitFor((l) => l.daemon === "ready")));
    const group = ok(await as(bob, "group", "create", "Crew", "--mesh")).group as string;
    ok(await as(carol, "group", "join", ok(await as(bob, "group", "link", group)).link as string));
    for (const dir of [bob, carol]) {
      await until(`${dir} reaches the other`, async () => ok(await as(dir, "group", "show", group)).members as { online: boolean }[], (m) => m.length === 2 && m.every((x) => x.online));
    }
    ok(await as(bob, "daemon", "stop"));
    await daemons[0].exited(20_000);

    const note = join(bob, "note.txt");
    writeFileSync(note, "a".repeat(22_000));
    bobRelay.requests = 0;
    const sent = ok(await as(bob, "file", "send", group, note));
    expect(bobRelay.requests).toBeGreaterThan(0);
    expect(sent).toMatchObject({ group, messageId: expect.any(String), file: { name: "note.txt", size: 22_000 }, sent: true, edges: expect.any(Number) });
    expect(sent.edges).toBeGreaterThan(0);
    // Carol hears of it now, not on Bob's next daemon run.
    await until("carol hears of it", async () => ok(await as(carol, "file", "list", group)).files as { messageId: string }[], (l) => l.some((f) => f.messageId === sent.messageId), 30_000);
  });

  it("starts the groups for it: its chat may name a group (a 1:1 chat's others stay unstarted)", () => {
    expect(chatOnly("file.send", { chat: "Crew", path: "a.txt" })).toBe(false);
    expect(oneChatOnly("file.send", { chat: "Crew", path: "a.txt" })).toBe(true);
  });
});
