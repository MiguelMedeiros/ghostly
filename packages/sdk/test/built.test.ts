import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "vite";
import { expect, it } from "vitest";
// covers: sdk.package, proofs.keet

const SDK = new URL("..", import.meta.url).pathname;

/**
 * In plain Node, not here: Vitest's module runner hands an imported file a `require`, which an ES module has not.
 * Prints what `verifyPeerProof` of the built /core says of a real Keet attestation, then of a tampered one.
 */
const KEET_CHECK = `
import IdentityKey from "keet-identity-key";
const core = await import(process.argv[1]);
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const keet = await IdentityKey.from({ mnemonic: IdentityKey.generateMnemonic() });
const now = Math.floor(Date.now() / 1000);
const c = { adapter: "keet-import", externalKey: hex(keet.identityPublicKey), subject: core.createIdentity().pubKeyZ32, audience: core.createIdentity().pubKeyZ32,
  context: "a".repeat(64), session: "b".repeat(64), nonce: core.toBase64Url(crypto.getRandomValues(new Uint8Array(32))), issuedAt: now, expiresAt: now + 86400 };
const attestation = new Uint8Array(IdentityKey.attestData(core.utf8Encode(core.proofStatement(c)), keet.identityKeyPair));
const said = async (sig) => { try { await core.verifyPeerProof(await core.importedProof(c, sig), c); return "accepted"; } catch (e) { return e.message; } };
console.log(JSON.stringify([await said(attestation), await said(attestation.map((b, i) => (i === 100 ? b ^ 1 : b)))]));
keet.keyChain.seed.fill(0); keet.clear();
`;

it("the built /core verifies a Keet attestation in Node, with no `require` of a package it leaves external", async () => {
  // Inside the package, so the built files find the dependencies they leave as imports.
  const dir = mkdtempSync(join(SDK, ".built-test-"));
  try {
    await build({ root: SDK, configFile: join(SDK, "vite.config.ts"), logLevel: "silent", build: { outDir: dir, sourcemap: false } });
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", KEET_CHECK, pathToFileURL(join(dir, "core.js")).href], { cwd: SDK });
    expect(JSON.parse(stdout)).toEqual(["accepted", "Invalid Keet attestation"]);
    // keet-identity-key is CommonJS: its bundled `require` of a package left external throws in an ES module.
    const required = readdirSync(dir).filter((f) => f.endsWith(".js"))
      .flatMap((f) => [...readFileSync(join(dir, f), "utf8").matchAll(/__require(?:\$\d+)?\(("[^"]+")\)/g)].map((m) => m[1]));
    expect([...new Set(required)]).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30000);
