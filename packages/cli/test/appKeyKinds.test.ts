import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { error, ghostly, ok } from "./support/cli";
// covers: apps.bundle, apps.store

/*
 * The files a publisher or store --key is often given by mistake, named for what they are: a public key (an SSH
 * .pub, a PEM public key) is no secret, so its mode is no reason to refuse it; an OpenSSH private key is a private key
 * in a format ghostly does not read. Before, a .pub was refused as a key others may read, and after the chmod (as an
 * OpenSSH key always was) as holding no Ed25519 private key. A PEM private key others may read is still refused.
 * Every key here is made for the test, in a folder of its own.
 */

const tmp = () => mkdtempSync(join(tmpdir(), "ghostly-key-kinds-"));
const storeVectors = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../core/test/vectors/app-store.json"), "utf8")) as { valid: { index: string }[] };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const sshString = (bytes: Buffer | string) => { const b = Buffer.from(bytes); return Buffer.concat([u32(b.length), b]); };

/** A throwaway Ed25519 key in the forms people have at hand: PKCS #8 PEM, SPKI PEM, OpenSSH public line and private file. */
function throwawayKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
  const pubBlob = Buffer.concat([sshString("ssh-ed25519"), sshString(pub)]);
  const check = u32(0x5eed1e55);
  let inner = Buffer.concat([check, check, sshString("ssh-ed25519"), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString("throwaway@test")]);
  for (let i = 1; inner.length % 8 !== 0; i++) inner = Buffer.concat([inner, Buffer.from([i])]);
  const blob = Buffer.concat([Buffer.from("openssh-key-v1\0"), sshString("none"), sshString("none"), sshString(""), u32(1), sshString(pubBlob), sshString(inner)]);
  const label = ["OPENSSH", "PRIVATE", "KEY"].join(" ");
  return {
    pkcs8: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    spki: publicKey.export({ type: "spki", format: "pem" }) as string,
    sshPub: `ssh-ed25519 ${pubBlob.toString("base64")} throwaway@test\n`,
    openSsh: `-----BEGIN ${label}-----\n${blob.toString("base64").replace(/.{70}/g, "$&\n")}\n-----END ${label}-----\n`,
  };
}

function keyFile(name: string, text: string, mode: number): string {
  const path = join(tmp(), name);
  writeFileSync(path, text, { mode });
  return path;
}

async function appDir(): Promise<string> {
  const dir = join(tmp(), "demo");
  ok(await ghostly(["app", "init", dir]));
  return dir;
}

const publicWords = (path: string, kind: string) =>
  `${path} is a public key, not a private one: --key names a ${kind} key file (an Ed25519 key in a PEM "PRIVATE KEY" block). Name a new path and ghostly makes one`;

describe.skipIf(process.platform === "win32")("--key given a file that is not a ghostly key", () => {
  it("names an SSH .pub as a public key, whatever its mode", async () => {
    const dir = await appDir();
    const key = throwawayKey();
    const open = keyFile("id_ed25519.pub", key.sshPub, 0o644);
    // Others may read it, and that is no reason to refuse it: the wrong file given, as at 0600.
    expect(error(await ghostly(["app", "publish", dir, "--key", open]), "bad_request", 1).message).toBe(publicWords(open, "publisher"));
    const closed = keyFile("id_ed25519.pub", key.sshPub, 0o600);
    expect(error(await ghostly(["app", "publish", dir, "--key", closed]), "bad_request", 1).message).toBe(publicWords(closed, "publisher"));
  }, 60_000);

  it("names a PEM public key as a public key, for a store key too", async () => {
    const index = join(tmp(), "index.json");
    const { key: _key, ...unsigned } = JSON.parse(storeVectors.valid[0].index) as Record<string, unknown>;
    writeFileSync(index, JSON.stringify(unsigned));
    const pem = keyFile("store.pub.pem", throwawayKey().spki, 0o644);
    expect(error(await ghostly(["store", "sign", index, "--key", pem]), "bad_request", 1).message).toBe(publicWords(pem, "store"));
  }, 60_000);

  it("refuses a private key ghostly does not read, next to its public key, that others may read", async () => {
    const dir = await appDir();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const encrypted = privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "throwaway" }) as string;
    const spki = publicKey.export({ type: "spki", format: "pem" }) as string;
    // As `openssl pkey -pubout >> key.pem` leaves it: a private key, so no public key, and a mode that may have shown it.
    const open = keyFile("publisher.pem", encrypted + spki, 0o644);
    expect(error(await ghostly(["app", "publish", dir, "--key", open]), "refused", 1).message).toBe(`${open} may be read by others (mode 644): run chmod 600 ${open}, and think whether the key was seen`);
  }, 60_000);

  it("names an OpenSSH private key as one, and refuses it others may read as before", async () => {
    const dir = await appDir();
    const { openSsh } = throwawayKey();
    const closed = keyFile("id_ed25519", openSsh, 0o600);
    expect(error(await ghostly(["app", "publish", dir, "--key", closed]), "bad_request", 1).message)
      .toBe(`${closed} is an OpenSSH private key (as ssh-keygen writes), which ghostly does not read: a publisher key is a key of its own. Name a new path with --key and ghostly makes one, or give an Ed25519 key in a PEM "PRIVATE KEY" block (openssl genpkey -algorithm ed25519)`);
    const open = keyFile("id_ed25519", openSsh, 0o644);
    expect(error(await ghostly(["app", "publish", dir, "--key", open]), "refused", 1).message).toContain(`${open} may be read by others (mode 644): run chmod 600`);
  }, 60_000);

  it("still refuses a PEM private key others may read, and signs with it at 0600", async () => {
    const dir = await appDir();
    const { pkcs8 } = throwawayKey();
    const open = keyFile("publisher.pem", pkcs8, 0o644);
    expect(error(await ghostly(["app", "publish", dir, "--key", open]), "refused", 1).message).toBe(`${open} may be read by others (mode 644): run chmod 600 ${open}, and think whether the key was seen`);
    const good = keyFile("publisher.pem", pkcs8, 0o600);
    expect(ok(await ghostly(["app", "publish", dir, "--key", good]))).toMatchObject({ keyCreated: false, sequence: 1 });
  }, 60_000);

  it("still says a file with no key holds no Ed25519 private key", async () => {
    const dir = await appDir();
    const junk = keyFile("notes.txt", "not a key\n", 0o600);
    expect(error(await ghostly(["app", "publish", dir, "--key", junk]), "bad_request", 1).message).toContain("holds no Ed25519 private key");
  }, 60_000);
});
