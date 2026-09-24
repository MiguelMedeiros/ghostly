// Identity-proof screenshots: Profile → Identities (an SSH key and an OpenPGP key, signed by the
// real ssh-keygen and gpg on this machine with throwaway keys), and the chat's Identities dialog on
// the contact's side, where both show as verified.
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRelay } from "../../../e2e/support/relay";
import { testSshKey, type TestSshKey } from "../../../e2e/support/ssh";
import { open, shot, setNickname, pair, converse, dressUp, type Line, type Peer } from "./helpers";

/** The exchange before Boo shares the keys. */
const KEYS_TALK: readonly Line[] = [
  ["casper", "who goes there?"],
  ["boo", "just a friendly ghost 👻"],
  ["casper", "prove it. which ghost?"],
  ["boo", "the one with the keys. sharing them now."],
];

const chatId = (p: Peer) => p.page.evaluate(() => location.hash);
const go = (p: Peer, hash: string) => p.page.evaluate(h => { location.hash = h; }, hash);
async function identities(p: Peer) {
  await p.page.getByTitle("Options").click();
  await p.page.getByTestId("chat-identities-open").click();
  const dialog = p.page.getByTestId("chat-identities");
  await expect(dialog).toBeVisible();
  return dialog;
}
const closeDialog = (p: Peer) => p.page.getByTestId("chat-identities").getByRole("button", { name: "Close" }).click();

/**
 * A throwaway OpenPGP key made by the gpg on this machine in a short-pathed temporary home (the
 * agent's socket path must stay short): Ed25519 certify-only primary with a signing subkey, like a
 * YubiKey layout. No passphrase; deleted by dispose(). Never a real key.
 */
function testGpgKey(userId: string) {
  const home = mkdtempSync(join(tmpdir(), "ghostly-idshot-gpg-"));
  const env = { ...process.env, GNUPGHOME: home, TZ: "UTC" };
  const gpg = (args: string[], input?: string) => execFileSync("gpg", ["--batch", "--yes", "--no-tty", "--quiet", "--pinentry-mode", "loopback", "--passphrase", "", ...args],
    { env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  try { execFileSync("gpgconf", ["--launch", "gpg-agent"], { env, stdio: "ignore" }); } catch { /* gpg autostarts it */ }
  gpg(["--quick-gen-key", userId, "ed25519", "cert", "never"]);
  const fingerprint = gpg(["--with-colons", "--list-keys", userId]).split("\n").find(l => l.startsWith("fpr:"))!.split(":")[9];
  gpg(["--quick-add-key", fingerprint, "ed25519", "sign", "never"]);
  gpg(["--quick-add-key", fingerprint, "cv25519", "encr", "never"]);
  return {
    fingerprint,
    /** `gpg --clearsign` of exactly `text`, as the app's first two commands do (the file has no final newline). */
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

/** Profile → Identities → SSH key, signed by ssh-keygen exactly as the dialog's command says. */
async function addSshProof(p: Peer, key: TestSshKey) {
  await p.page.getByTestId("identity-add").click();
  const add = p.page.getByTestId("add-identity");
  await add.getByTestId("add-identity-ssh").click();
  await add.getByTestId("add-identity-subject").fill(`${key.publicKey} boo@haunted-house`);
  await add.getByTestId("add-identity-start").click();
  const statement = (await add.getByTestId("add-identity-copy-1").textContent())!;
  expect(statement).toMatch(/^Ghostly identity proof v1: I control ssh:SHA256:/);
  await add.getByTestId("add-identity-paste").fill(key.sign(statement));
  await add.getByTestId("add-identity-finish").click();
  await expect(add).toHaveCount(0);
}

/** Profile → Identities → OpenPGP key with the plain gpg signer: clearsigned statement plus public key. */
async function addPgpProof(p: Peer, key: ReturnType<typeof testGpgKey>) {
  await p.page.getByTestId("identity-add").click();
  const add = p.page.getByTestId("add-identity");
  await add.getByTestId("add-identity-openpgp").click();
  await expect(add.getByTestId("add-identity-signer")).toHaveValue("gpg");
  await add.getByTestId("add-identity-subject").fill(key.fingerprint.replace(/(.{4})/g, "$1 ").trim()); // as gpg --fingerprint prints it
  await add.getByTestId("add-identity-start").click();
  const statement = (await add.getByTestId("add-identity-copy-2").textContent())!;
  expect(statement).toMatch(new RegExp(`^Ghostly identity proof v1: I control openpgp:${key.fingerprint} and authorize`));
  await add.getByTestId("add-identity-paste").fill(`${key.clearsign(statement)}\n${key.exportKey()}`);
  await add.getByTestId("add-identity-finish").click();
  await expect(add).toHaveCount(0);
}

/** Scroll the profile so the Identities section sits at the top of the view. */
async function showIdentities(p: Peer) {
  const section = p.page.getByTestId("profile-identities");
  await expect(section).toBeVisible();
  await section.evaluate(el => el.scrollIntoView({ block: "start" }));
  await p.page.waitForTimeout(400);
}

let ssh: TestSshKey | undefined, pgp: ReturnType<typeof testGpgKey> | undefined;
test.afterEach(() => { ssh?.dispose(); pgp?.dispose(); ssh = pgp = undefined; });

test("desktop: identities on the profile, and verified in the contact's chat", async ({ browser, baseURL }) => {
  const relay = new LocalRelay();
  ssh = testSshKey(); pgp = testGpgKey("Boo <boo@ghostly.tools>");
  const [boo, casper] = await Promise.all([open(browser, relay, baseURL!, "Boo"), open(browser, relay, baseURL!, "Casper")]);
  await setNickname(boo, "Boo");
  await setNickname(casper, "Casper");
  await dressUp(boo, casper);
  await pair(boo, casper);
  const withCasper = await chatId(boo);
  await converse(boo, casper, KEYS_TALK);

  // Made once, in Profile → Identities.
  await go(boo, "#/profile");
  await expect(boo.page.getByTestId("profile-page")).toBeVisible();
  await addSshProof(boo, ssh);
  await addPgpProof(boo, pgp);
  await expect(boo.page.getByTestId("identity-proof")).toHaveCount(2);
  await showIdentities(boo);
  await shot(boo, "x-identities-not-shared.png");

  // Shared with Casper, in this chat only.
  await go(boo, withCasper);
  const mine = await identities(boo);
  for (const i of [0, 1]) {
    await mine.getByTestId("chat-identity-share").first().click();
    await expect(mine.getByTestId("chat-identity-mine-status").nth(i)).toHaveText("Shared · verified by your contact");
  }
  await shot(boo, "x-identities-chat-boo.png");
  await closeDialog(boo);

  // Casper's app checked both itself.
  await expect(casper.page.getByTestId("chat-identity-badges")).toBeVisible();
  const dialog = await identities(casper);
  const received = dialog.getByTestId("chat-identity-received");
  await expect(received).toHaveCount(2);
  for (const provider of ["ssh", "openpgp"]) await expect(casper.page.locator(`[data-testid="chat-identity-received"][data-provider="${provider}"]`)).toHaveAttribute("data-status", "verified");
  await expect(received.filter({ hasText: "Boo <boo@ghostly.tools>" })).toHaveCount(1);
  await shot(casper, "identities-chat.png");
  await received.first().getByText("Details").click();
  await casper.page.waitForTimeout(300);
  await shot(casper, "x-identities-chat-details.png");
  await closeDialog(casper);

  // Back on Boo's profile: each proof now says it is shared in one chat.
  await go(boo, "#/profile");
  await expect(boo.page.getByTestId("identity-proof").filter({ hasText: "Shared in 1 chat" })).toHaveCount(2);
  await showIdentities(boo);
  await shot(boo, "identities.png");
  relay.close();
});

test("phone: identities on the profile, and verified in the contact's chat", async ({ browser, baseURL }) => {
  const relay = new LocalRelay();
  ssh = testSshKey(); pgp = testGpgKey("Boo <boo@ghostly.tools>");
  const [mboo, mcasper] = await Promise.all([open(browser, relay, baseURL!, "mBoo", true), open(browser, relay, baseURL!, "mCasper", true)]);
  await setNickname(mboo, "Boo");
  await setNickname(mcasper, "Casper");
  await dressUp(mboo, mcasper);
  await pair(mboo, mcasper);
  const withCasper = await chatId(mboo);
  await converse(mboo, mcasper, KEYS_TALK);

  await go(mboo, "#/profile");
  await expect(mboo.page.getByTestId("profile-page")).toBeVisible();
  await addSshProof(mboo, ssh);
  await addPgpProof(mboo, pgp);
  await expect(mboo.page.getByTestId("identity-proof")).toHaveCount(2);

  await go(mboo, withCasper);
  const mine = await identities(mboo);
  for (const i of [0, 1]) {
    await mine.getByTestId("chat-identity-share").first().click();
    await expect(mine.getByTestId("chat-identity-mine-status").nth(i)).toHaveText("Shared · verified by your contact");
  }
  await closeDialog(mboo);

  await expect(mcasper.page.getByTestId("chat-identity-badges")).toBeVisible();
  const dialog = await identities(mcasper);
  const received = dialog.getByTestId("chat-identity-received");
  await expect(received).toHaveCount(2);
  await expect(received.filter({ hasText: "Boo <boo@ghostly.tools>" })).toHaveCount(1);
  await shot(mcasper, "identities-chat-mobile.png");
  await closeDialog(mcasper);

  await go(mboo, "#/profile");
  await expect(mboo.page.getByTestId("identity-proof").filter({ hasText: "Shared in 1 chat" })).toHaveCount(2);
  await showIdentities(mboo);
  await shot(mboo, "identities-mobile.png");
  relay.close();
});
