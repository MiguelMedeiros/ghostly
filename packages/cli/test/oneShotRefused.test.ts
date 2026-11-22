import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";
// covers: headless.one-shot

/** A Pkarr relay on loopback that counts the requests that came to it. */
async function countingRelay() {
  const packets = new Map<string, Buffer>();
  const relay = { url: "", requests: 0, close: () => {} };
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
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  relay.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  relay.close = () => { server.closeAllConnections(); server.close(); };
  return relay;
}

/**
 * A one-shot on a message its chat does not have (a mistyped id) is refused `not_found`, and the chat is never
 * started: it put its records on the relays and the close waited for its leave packet there, 4 to 10 s with relays
 * that are slow or do not answer, before "No message" was said. One on a message the chat has starts it, as before.
 */
describe("a one-shot on a message the chat does not have", { timeout: 120_000 }, () => {
  let relay: Awaited<ReturnType<typeof countingRelay>>;
  const bob = home("one-shot-refused-bob");
  let env: NodeJS.ProcessEnv;
  let messageId: string;

  beforeAll(async () => {
    relay = await countingRelay();
    env = { GHOSTLY_PKARR_RELAYS: relay.url };
    ok(await ghostly(["--home", bob, "invite", "create", "--label", "carol"], { env }));
    messageId = ok(await ghostly(["--home", bob, "send", "carol", "kept for Carol", "--wait", "none"], { env })).messageId as string;
  }, 60_000);
  afterAll(() => relay?.close());

  /** The relay's requests while `args` runs as a one-shot on Bob's profile. */
  const counted = async (args: string[]) => {
    relay.requests = 0;
    const result = await ghostly(["--home", bob, ...args], { env });
    return { result, requests: relay.requests };
  };

  it("react, pin, edit, message delete and message retry say not_found without starting the chat", async () => {
    for (const args of [
      ["react", "carol", "nosuch", "👍"],
      ["pin", "carol", "nosuch"],
      ["edit", "carol", "nosuch", "new text"],
      ["message", "delete", "carol", "nosuch"],
      ["message", "delete", "carol", "nosuch", "--everyone"],
      ["message", "retry", "carol", "nosuch"],
    ]) {
      const { result, requests } = await counted(args);
      expect(error(result, "not_found", 3).message, args.join(" ")).toMatch(/^No message "nosuch"/);
      expect(requests, args.join(" ")).toBe(0);
    }
  });

  it("starts the chat for a message it has", async () => {
    const { result, requests } = await counted(["react", "carol", messageId, "👍"]);
    expect(ok(result)).toMatchObject({ messageId, emoji: "👍" });
    expect(requests).toBeGreaterThan(0);
  });
});
