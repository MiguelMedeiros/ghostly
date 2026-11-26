import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ghostly, home, ok, Running } from "./support/cli";
// covers: headless.identities, headless.one-shot

/** A Pkarr relay on loopback that keeps the key of each PUT. */
async function countingRelay() {
  const packets = new Map<string, Buffer>();
  const relay = { url: "", puts: [] as string[], close: () => {} };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (c: Buffer) => chunks.push(c));
    request.on("end", () => {
      const key = new URL(request.url ?? "/", "http://relay").pathname.slice(1);
      if (request.method === "PUT") {
        relay.puts.push(key);
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
 * `identity remove` of a proof shared in a chat revokes it: a record its proof key publishes on Pkarr, for contacts the
 * app never reconnects to. The engine published it without waiting, and a one-shot ended before it reached any relay:
 * someone who only runs one-shots never revoked a removed proof (the next daemon start was the first to publish it).
 */
describe("a one-shot identity remove", { timeout: 120_000 }, () => {
  const dir = home("one-shot-identity-remove");
  let relay: Awaited<ReturnType<typeof countingRelay>> | undefined;
  let daemon: Running | undefined;
  afterAll(async () => { await daemon?.stop(); relay?.close(); });

  it("publishes the revocation of a shared proof before it ends", async () => {
    relay = await countingRelay();
    const env = { GHOSTLY_PKARR_RELAYS: relay.url };
    ok(await ghostly(["--home", dir, "invite", "create", "--label", "bob"], { env }));
    // A draft lives in the engine: the proof is made through a daemon, then everything else is one-shots.
    daemon = new Running(["--home", dir, "daemon"], env);
    await daemon.waitFor((l) => l.daemon === "ready");
    const key = join(dir, "id_ed25519");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "bot", "-f", key]);
    const pub = readFileSync(`${key}.pub`, "utf8").trim();
    const started = ok(await ghostly(["--home", dir, "identity", "add", "ssh", pub, "--signer", "ssh-keygen", "--days", "30"], { env }));
    const signature = execFileSync("ssh-keygen", ["-Y", "sign", "-n", "ghostly", "-f", key], { input: started.statement as string }).toString();
    const { id } = ok(await ghostly(["--home", dir, "identity", "complete", started.draft as string], { env, input: signature })).proof as { id: string };
    const proofKey = /the Ghostly key (\S+)/.exec(started.statement as string)![1].replace(/[.,;]$/, "");
    await daemon.stop();
    daemon = undefined;

    ok(await ghostly(["--home", dir, "identity", "share", "bob", id], { env }));
    relay.puts.length = 0;
    expect(ok(await ghostly(["--home", dir, "identity", "remove", id], { env }))).toEqual({ removed: id });
    expect(relay.puts).toContain(proofKey);
  });
});
