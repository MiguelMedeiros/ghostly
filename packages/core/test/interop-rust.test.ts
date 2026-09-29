import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { RelayTransport, encrypt, fromBase64Url, identityFromSeedB64, parseLinkRecords } from "../src";
// covers-gated: cli.interop, core.records, core.relay-client

/**
 * Live interoperability with the Rust implementation, over the real network:
 *
 *   cargo build -p ghostly-cli
 *   GHOSTLY_CLI=target/debug/ghostly-cli npm run test:interop
 *
 * Skipped unless GHOSTLY_CLI points at the binary.
 */
const cli = process.env.GHOSTLY_CLI;
const run = (...args: string[]) => JSON.parse(execFileSync(cli!, args).toString());
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!cli)("interop with ghostly-cli", () => {
  it("exchanges messages in both directions", { timeout: 120_000 }, async () => {
    const rust = run("identity", "new");
    const browser = run("identity", "new");
    const key = fromBase64Url(rust.shared_key);
    const transport = new RelayTransport();

    // Rust publishes to the DHT and its relays, the relay transport reads it back.
    const fromRust = `from rust ${Date.now()}`;
    run("send", "--seed", rust.seed, "--peer", browser.pubkey, "--key", rust.shared_key, fromRust);
    let received: string[] = [];
    for (let i = 0; i < 20 && !received.includes(fromRust); i++) {
      const packet = await transport.resolve(rust.pubkey);
      received = packet ? parseLinkRecords(packet, key).messages.map((m) => m.text) : [];
      if (!received.includes(fromRust)) await sleep(2000);
    }
    expect(received).toContain(fromRust);

    // The relay transport publishes, Rust resolves it.
    const me = identityFromSeedB64(browser.seed);
    expect(me.pubKeyZ32).toBe(browser.pubkey);
    const timestamp = Date.now();
    const fromBrowser = `from the browser ${timestamp}`;
    await transport.publish(me, [
      { label: "_msgs", value: encrypt(JSON.stringify([{ t: timestamp, m: fromBrowser }]), key) },
      { label: "_ts", value: String(timestamp) },
      { label: "_nick", value: encrypt("Browser", key) },
    ]);
    let seen: { text: string; nick: string | null }[] = [];
    for (let i = 0; i < 20 && !seen.some((m) => m.text === fromBrowser); i++) {
      seen = run("recv", "--peer", browser.pubkey, "--key", rust.shared_key).messages;
      if (!seen.some((m) => m.text === fromBrowser)) await sleep(2000);
    }
    expect(seen).toContainEqual(expect.objectContaining({ text: fromBrowser, nick: "Browser" }));
  });
});
