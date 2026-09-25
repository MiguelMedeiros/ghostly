// "Prove who you are. Only to whom you choose.": Boo adds four identities on the Identities page, each
// proved with the real tool a person would use (ssh-keygen and gpg on this machine with throwaway
// keys, a BIP-322 signature from a disposable signet key, a NIP-07 signer holding a disposable Nostr
// key), shares them in the chat with Casper, and Casper's app verifies every one. Desktop from
// Casper's side; the phone reopens Casper's own profile.
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRelay } from "../../../e2e/support/relay";
import { testSshKey, type TestSshKey } from "../../../e2e/support/ssh";
import { addNostrIdentity, injectNostrSigner } from "../../../e2e/support/nostrSigner";
import { choose } from "../../../e2e/support/select";
import { closeIdentities, shareIdentity } from "../../../e2e/support/identities";
import { testBitcoinWallet } from "../../../packages/browser/test/helpers/bitcoinSign";
import { CAST, converse, newProfile, open, pair, person, shot, type Peer } from "./helpers";

const go = (p: Peer, hash: string) => p.page.evaluate((h) => { location.hash = h; }, hash);

/**
 * A throwaway OpenPGP key made by the gpg on this machine in a short-pathed temporary home (the
 * agent's socket path must stay short): Ed25519 certify-only primary with signing and encryption
 * subkeys. No passphrase; deleted by dispose(). Never a real key.
 */
function testGpgKey(userId: string) {
  const home = mkdtempSync(join(tmpdir(), "ghostly-idshot-gpg-"));
  const env = { ...process.env, GNUPGHOME: home, TZ: "UTC" };
  const gpg = (args: string[], input?: string) => execFileSync("gpg", ["--batch", "--yes", "--no-tty", "--quiet", "--pinentry-mode", "loopback", "--passphrase", "", ...args],
    { env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  try { execFileSync("gpgconf", ["--launch", "gpg-agent"], { env, stdio: "ignore" }); } catch { /* gpg autostarts it */ }
  gpg(["--quick-gen-key", userId, "ed25519", "cert", "never"]);
  const fingerprint = gpg(["--with-colons", "--list-keys", userId]).split("\n").find((l) => l.startsWith("fpr:"))!.split(":")[9];
  gpg(["--quick-add-key", fingerprint, "ed25519", "sign", "never"]);
  gpg(["--quick-add-key", fingerprint, "cv25519", "encr", "never"]);
  return {
    fingerprint,
    /** `gpg --clearsign` of exactly `text`, as the app's commands do (the file has no final newline). */
    clearsign(text: string): string {
      const file = join(home, "ghostly-identity.txt");
      writeFileSync(file, text);
      return gpg(["--local-user", fingerprint, "--clearsign", "--output", "-", file]);
    },
    exportKey: () => gpg(["--armor", "--export", "--export-options", "export-minimal", fingerprint]),
    dispose() {
      try { execFileSync("gpgconf", ["--kill", "all"], { env, stdio: "ignore" }); } catch { /* no agent */ }
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const adding = async (p: Peer, kind: string) => {
  await go(p, "#/identities");
  await p.page.getByTestId("identity-add").click();
  const add = p.page.getByTestId("add-identity");
  await add.getByTestId(`add-identity-${kind}`).click();
  return add;
};
const finish = async (add: ReturnType<Peer["page"]["getByTestId"]>, signature: string) => {
  await add.getByTestId("add-identity-paste").fill(signature);
  await add.getByTestId("add-identity-finish").click();
  await expect(add).toHaveCount(0);
};

async function addSsh(p: Peer, key: TestSshKey, comment: string) {
  const add = await adding(p, "ssh");
  await add.getByTestId("add-identity-subject").fill(`${key.publicKey} ${comment}`);
  await add.getByTestId("add-identity-start").click();
  await finish(add, key.sign((await add.getByTestId("add-identity-copy-1").textContent())!));
}

async function addPgp(p: Peer, key: ReturnType<typeof testGpgKey>) {
  const add = await adding(p, "openpgp");
  await add.getByTestId("add-identity-subject").fill(key.fingerprint.replace(/(.{4})/g, "$1 ").trim()); // as gpg --fingerprint prints it
  await add.getByTestId("add-identity-start").click();
  const statement = (await add.getByTestId("add-identity-copy-2").textContent())!;
  await finish(add, `${key.clearsign(statement)}\n${key.exportKey()}`);
}

async function addBitcoin(p: Peer) {
  const wallet = testBitcoinWallet("p2wpkh");
  const add = await adding(p, "bitcoin");
  await add.getByTestId("add-identity-subject").fill(wallet.address);
  await choose(add.getByTestId("add-identity-signer"), "sparrow");
  await add.getByTestId("add-identity-start").click();
  const statement = (await add.getByTestId("add-identity-copy-0").textContent())!.trim();
  await finish(add, wallet.signBip322(statement).simple!);
}

/** Shared in this chat, one by one, each waited on until the contact's app has verified it. */
async function shareAll(p: Peer) {
  for (const which of [/SSH/, /OpenPGP/, /Bitcoin/, /Nostr/]) await shareIdentity(p, which, { timeout: 90_000 });
  await closeIdentities(p);
}

let ssh: TestSshKey | undefined, casperSsh: TestSshKey | undefined, pgp: ReturnType<typeof testGpgKey> | undefined;
test.afterEach(() => { ssh?.dispose(); casperSsh?.dispose(); pgp?.dispose(); ssh = casperSsh = pgp = undefined; });

test("identities proved, shared and verified, desktop and phone", async ({ browser, baseURL }) => {
  test.setTimeout(15 * 60_000);
  const relay = new LocalRelay();
  ssh = testSshKey(); casperSsh = testSshKey(); pgp = testGpgKey("Boo <boo@ghostly.tools>");
  const profile = newProfile();
  const [boo, casper] = await Promise.all([person(browser, relay, baseURL!, CAST.boo), person(browser, relay, baseURL!, CAST.casper, { profile })]);
  await injectNostrSigner(boo);
  await pair(boo, casper);
  const withCasper = await boo.page.evaluate(() => location.hash);
  const withBoo = await casper.page.evaluate(() => location.hash);
  await converse([
    [casper, "is this really you? new phone, new app"],
    [boo, "it's me 👻 sharing my keys so you can check"],
  ], [boo, casper]);

  // Made once, on the Identities page.
  await addSsh(boo, ssh, "boo@lake-house");
  await addPgp(boo, pgp);
  await addBitcoin(boo);
  await addNostrIdentity(boo);
  await expect(boo.page.getByTestId("identity-proof")).toHaveCount(4);
  await shot(boo, "x-identities-page.png");

  // Shared with Casper, in this chat only; Casper's app checks each one itself.
  await go(boo, withCasper);
  await shareAll(boo);
  // Casper answers with a key of their own.
  await addSsh(casper, casperSsh, "casper@laptop");
  await go(casper, withBoo);
  await shareIdentity(casper, /SSH/, { timeout: 90_000 });
  await closeIdentities(casper);
  await converse([[casper, "all four check out ✅ here's mine"]], [boo, casper]);
  await expect(casper.page.getByTestId("chat-identity-badges")).toBeVisible({ timeout: 60_000 });
  await casper.page.getByTitle("Options").click();
  await casper.page.getByTestId("chat-identities-open").click();
  const received = casper.page.getByTestId("chat-identities-received").getByTestId("chat-identity-received");
  await expect(received).toHaveCount(4, { timeout: 90_000 });
  for (let i = 0; i < 4; i++) await expect(received.nth(i).locator("[data-deck=face]")).toHaveAttribute("data-status", "verified", { timeout: 90_000 });
  await casper.page.waitForTimeout(1200);
  await shot(casper, "identities-chat.png");
  await casper.page.getByTestId("chat-identities-close").click();
  await go(boo, "#/identities");
  await boo.page.waitForTimeout(800);
  await shot(boo, "x-identities-page-shared.png");

  // The same Casper on a phone.
  await casper.context.close();
  const phone = await open(browser, relay, baseURL!, "mCasper", { mobile: true, profile });
  await go(phone, withBoo);
  await expect(phone.page.getByTestId("chat-identity-badges")).toBeVisible({ timeout: 60_000 });
  await phone.page.getByTitle("Options").click();
  await phone.page.getByTestId("chat-identities-open").click();
  await expect(phone.page.getByTestId("chat-identities-received").getByTestId("chat-identity-received")).toHaveCount(4, { timeout: 90_000 });
  await phone.page.waitForTimeout(1200);
  await shot(phone, "identities-chat-mobile.png");
  await phone.context.close();
  rmSync(profile, { recursive: true, force: true });
  relay.close();
});
