import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { finalizeEvent as pinnedFinalize, getPublicKey as pinnedPublicKey, nip44 as pinnedNip44, verifyEvent as pinnedVerify } from "nostr-tools";
import { build, type Plugin, type Rollup } from "vite";
import { expect, it } from "vitest";
import { ghostlyPlatformModules } from "../../../packages/browser/vite-plugin";

const ROOT = join(import.meta.dirname, "../../..");
const PINNED = ["@noble/ciphers", "@noble/curves", "@noble/hashes", "@scure/base", "@scure/bip32", "@scure/bip39"];
const version = (path: string): string => JSON.parse(readFileSync(join(ROOT, "node_modules", path, "package.json"), "utf8")).version;

/**
 * nostr-tools pins exact versions of the noble and scure libraries, older than the ones the app and its other
 * libraries share. Left alone, a browser build bundled both copies, a second secp256k1 among them, in the web
 * app's first load.
 */
it("a browser build bundles nostr-tools on the app's own noble and scure libraries, and it signs and seals as on its pinned ones", async () => {
  const dir = mkdtempSync(join(ROOT, "node_modules/.ghostly-crypto-copies-"));
  const modules: string[] = [];
  const collect: Plugin = { name: "collect", moduleParsed: (info) => void modules.push(info.id) };
  try {
    writeFileSync(join(dir, "entry.js"), [
      `import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";`,
      `import { nip44 } from "nostr-tools";`,
      `import { secp256k1 } from "@noble/curves/secp256k1.js";`,
      `export { finalizeEvent, getPublicKey, verifyEvent, nip44, secp256k1 };`,
    ].join("\n"));
    const output = await build({
      root: dir, configFile: false, logLevel: "silent", plugins: [ghostlyPlatformModules(), collect],
      build: { write: false, minify: false, lib: { entry: join(dir, "entry.js"), formats: ["es"], fileName: "bundle" } },
    }) as Rollup.RollupOutput[];
    const chunk = output[0].output.find((file) => file.type === "chunk") as Rollup.OutputChunk;
    writeFileSync(join(dir, "bundle.mjs"), chunk.code);
    const bundled = await import(pathToFileURL(join(dir, "bundle.mjs")).href);

    const crypto = modules.filter((id) => /node_modules\/@(noble|scure)\//.test(id));
    expect(crypto.some((id) => id.includes("/@noble/curves/secp256k1.js"))).toBe(true);
    expect(crypto.filter((id) => id.includes("/nostr-tools/node_modules/"))).toEqual([]);

    const alice = new Uint8Array(32).fill(1), bob = new Uint8Array(32).fill(2);
    expect(bundled.getPublicKey(alice)).toBe(pinnedPublicKey(alice));
    const event = { kind: 1, created_at: 1_700_000_000, tags: [["p", pinnedPublicKey(bob)]], content: "hello" };
    expect(pinnedVerify(bundled.finalizeEvent({ ...event }, alice))).toBe(true);
    expect(bundled.verifyEvent(pinnedFinalize({ ...event }, alice))).toBe(true);
    const key = bundled.nip44.v2.utils.getConversationKey(alice, pinnedPublicKey(bob));
    expect(key).toEqual(pinnedNip44.v2.utils.getConversationKey(alice, pinnedPublicKey(bob)));
    const nonce = new Uint8Array(32).fill(7);
    const sealed = bundled.nip44.v2.encrypt("a message for Bob", key, nonce);
    expect(sealed).toBe(pinnedNip44.v2.encrypt("a message for Bob", key, nonce));
    expect(pinnedNip44.v2.decrypt(sealed, pinnedNip44.v2.utils.getConversationKey(bob, pinnedPublicKey(alice)))).toBe("a message for Bob");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

/** The app's copies may stand in for nostr-tools' pins only while they are of the same major. */
it("nostr-tools' pinned noble and scure versions share a major with the app's", () => {
  const pins = JSON.parse(readFileSync(join(ROOT, "node_modules/nostr-tools/package.json"), "utf8")).dependencies as Record<string, string>;
  const major = (v: string) => v.replace(/^[^\d]*/, "").split(".")[0];
  for (const name of PINNED) expect(major(version(name)), name).toBe(major(pins[name]));
});
