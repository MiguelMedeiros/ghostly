import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDidDhtPayload } from "@ghostly/core";
import { ghostly, home, ok, Running } from "./support/cli";
// covers: headless.identities, headless.one-shot

/** A Pkarr relay on loopback that keeps the newest packet of each key. */
async function loopbackRelay() {
  const packets = new Map<string, Buffer>();
  const relay = { url: "", packets, close: () => {} };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (c: Buffer) => chunks.push(c));
    request.on("end", () => {
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

const hasGpg = (() => { try { execFileSync("gpg", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

/**
 * A proof listed in the profile's DID (its public did:dht document, on Pkarr) and then removed leaves the document.
 * The engine published the new document 2 s after the change, and a one-shot `identity remove` ended before that: the
 * DID went on naming the removed identity until a daemon ran for 15 s.
 */
describe("a one-shot identity remove of a proof listed in the DID", { timeout: 120_000 }, () => {
  const dir = home("one-shot-did-listing");
  let relay: Awaited<ReturnType<typeof loopbackRelay>> | undefined;
  let daemon: Running | undefined;
  afterAll(async () => { await daemon?.stop(); relay?.close(); });

  it.skipIf(!hasGpg)("publishes the document without it before it ends", async () => {
    relay = await loopbackRelay();
    const env = { GHOSTLY_PKARR_RELAYS: relay.url };
    const gpgHome = join(dir, "gnupg");
    mkdirSync(gpgHome, { mode: 0o700 });
    const gpg = (args: string[]) => execFileSync("gpg", ["--batch", ...args], { env: { ...process.env, GNUPGHOME: gpgHome }, stdio: ["ignore", "pipe", "ignore"] }).toString();
    gpg(["--passphrase", "", "--quick-gen-key", "Bot <bot@example.com>", "ed25519", "sign", "never"]);
    const fpr = /fpr:+([A-F0-9]{40}):/.exec(gpg(["--with-colons", "--fingerprint"]))![1];

    // A draft lives in the engine: the proof is made and listed through a daemon.
    daemon = new Running(["--home", dir, "daemon"], env);
    await daemon.waitFor((l) => l.daemon === "ready");
    const started = ok(await ghostly(["--home", dir, "identity", "add", "openpgp", fpr, "--signer", "gpg"], { env }));
    const statement = join(dir, "statement.txt");
    writeFileSync(statement, started.statement as string);
    const signed = gpg(["--local-user", fpr, "--clearsign", "--output", "-", statement]) + gpg(["--armor", "--export", "--export-options", "export-minimal", fpr]);
    const { id } = ok(await ghostly(["--home", dir, "identity", "complete", started.draft as string], { env, input: signed })).proof as { id: string };
    ok(await ghostly(["--home", dir, "engine", "setDidListed", JSON.stringify({ id, listed: true })], { env }));
    const did = ((ok(await ghostly(["--home", dir, "engine", "getState"], { env })) as { did: { id: string } }).did).id;
    const listed = () => {
      const packet = relay!.packets.get(did.slice("did:dht:".length));
      return packet ? openDidDhtPayload(did, new Uint8Array(packet)).document.alsoKnownAs ?? [] : null;
    };
    for (let i = 0; i < 40 && !listed()?.length; i++) await new Promise((r) => setTimeout(r, 500));
    expect(listed()).toEqual([`openpgp4fpr:${fpr}`]);
    await daemon.stop();
    daemon = undefined;

    expect(ok(await ghostly(["--home", dir, "identity", "remove", id], { env }))).toEqual({ removed: id });
    expect(listed()).toEqual([]);
  });
});
