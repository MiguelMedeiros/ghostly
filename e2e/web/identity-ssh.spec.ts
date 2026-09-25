import { expect, test, type Peer } from "../support/fixtures";
import { closeIdentities, openIdentities, shareIdentity, theirCards, theirFace, turnTheirs } from "../support/identities";
import { pair } from "../support/paired";
import { testSshKey, type TestSshKey } from "../support/ssh";

/**
 * SSH identity proofs, signed by the real ssh-keygen exactly as the app tells people to (the test keys
 * live in a temporary directory). GitHub is never contacted: api.github.com is answered from `published`,
 * and any other forge request fails the test.
 */
const chatId = (peer: Peer) => peer.page.evaluate(() => location.hash);
const go = (peer: Peer, hash: string) => peer.page.evaluate(h => { location.hash = h; }, hash);

async function stubGitHub(peer: Peer, published: Map<string, string[]>, asked: string[]) {
  await peer.context.route("https://api.github.com/**", route => {
    const url = route.request().url();
    asked.push(`${peer.name} ${url}`);
    const login = /^https:\/\/api\.github\.com\/users\/([^/]+)\/keys\?per_page=100$/.exec(url)?.[1];
    const keys = login ? published.get(login) : undefined;
    return keys
      ? route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(keys.map((key, id) => ({ id, key }))) })
      : route.fulfill({ status: 404, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: '{"message":"Not Found"}' });
  });
  await peer.context.route("https://gitlab.com/**", route => { asked.push(`${peer.name} UNEXPECTED ${route.request().url()}`); return route.abort(); });
}

let keys: TestSshKey[] = [];
test.afterEach(() => { for (const k of keys) k.dispose(); keys = []; });

test("an SSH key proves a GitHub account, shared with one contact only, and a removed key stops counting", { tag: ["@feature:proofs.recheck", "@feature:proofs.ssh.github", "@feature:proofs.share"] }, async ({ peer }) => {
  const [mine, other] = keys = [testSshKey(), testSshKey("ecdsa")];
  const published = new Map([["octo-cat", [other.publicKey, mine.publicKey]]]);
  const asked: string[] = [];
  const [alice, bob, carol] = await Promise.all([peer("ssh-alice"), peer("ssh-bob"), peer("ssh-carol")]);
  for (const p of [alice, bob, carol]) await stubGitHub(p, published, asked);

  await pair(alice, bob);
  const withBob = await chatId(alice);
  await pair(alice, carol);

  // Identities → GitHub (SSH key): the app says whom it asks, and shows what to run.
  await go(alice, "#/identities");
  await alice.page.getByTestId("identity-add").click();
  const add = alice.page.getByTestId("add-identity");
  await add.getByTestId("add-identity-ssh-github").click();
  await expect(add).toContainText("asks api.github.com for this account's public SSH keys");
  await add.getByTestId("add-identity-subject").fill("Octo-Cat");
  await add.getByTestId("add-identity-start").click();
  const statement = (await add.getByTestId("add-identity-copy-1").textContent())!;
  expect(statement).toMatch(/^Ghostly identity proof v1: I control ssh-github:octo-cat and authorize the Ghostly key [a-z0-9]{52} to present it /);
  await expect(add.getByTestId("add-identity-copy-0")).toHaveText(`printf '%s' '${statement}' | ssh-keygen -Y sign -n ghostly -f ~/.ssh/id_ed25519`);

  // Refused before anything is saved: another namespace, another statement, a key the account does not list.
  const paste = async (signature: string, error?: RegExp) => {
    await add.getByTestId("add-identity-paste").fill(signature);
    await add.getByTestId("add-identity-finish").click();
    if (error) await expect(add.getByTestId("add-identity-error")).toHaveText(error);
  };
  await paste(mine.sign(statement, "git"), /for "git", not "ghostly"/);
  await paste(mine.sign(statement.replace("octo-cat", "someone-else")), /not over this statement/);
  const stranger = testSshKey();
  keys.push(stranger);
  await paste(stranger.sign(statement), /GitHub: octo-cat does not list the key that signed \(SHA256:/);
  await paste(mine.sign(statement));
  await expect(add).toHaveCount(0);
  await expect(alice.page.getByTestId("identity-proof")).toHaveCount(1);
  await expect(alice.page.getByTestId("identity-proof")).toContainText("Not shared");

  // Shared with Bob only. His app checks the signature and GitHub's key list itself.
  await go(alice, withBob);
  await shareIdentity(alice);
  await closeIdentities(alice);
  await expect(bob.page.getByTestId("chat-identity-badge").first()).toBeVisible();
  await openIdentities(bob);
  await expect(theirCards(bob)).toHaveCount(1);
  await expect(theirFace(bob)).toHaveAttribute("data-status", "verified");
  const back = await turnTheirs(bob);
  await expect(back).toHaveAttribute("data-provider", "ssh-github");
  await expect(back.getByTestId("chat-identity-received-subject")).toHaveAttribute("title", "octo-cat");
  await expect(back).toContainText("GitHub: octo-cat (via published SSH key)");
  expect(asked.filter(a => a.startsWith("ssh-bob"))).toEqual(["ssh-bob https://api.github.com/users/octo-cat/keys?per_page=100"]);

  // The key leaves the account: Bob's re-check says it can no longer be confirmed, never "verified".
  published.set("octo-cat", [other.publicKey]);
  await back.getByTestId("chat-identity-recheck").click();
  await expect(back).toHaveAttribute("data-status", "failed");
  await expect(back).toContainText("does not list the key that signed");
  await closeIdentities(bob);

  // Carol was never shown it, and her app never asked GitHub about anyone.
  await openIdentities(carol);
  await expect(theirCards(carol)).toHaveCount(0);
  await closeIdentities(carol);
  await expect(carol.page.getByTestId("chat-identity-ghostly-mark")).toBeVisible();
  expect(asked.filter(a => a.startsWith("ssh-carol") || a.includes("UNEXPECTED"))).toEqual([]);
});

test("a bare SSH key is proven on the device, and another key's signature is refused", { tag: ["@feature:proofs.ssh", "@feature:proofs.share"] }, async ({ peer }) => {
  const [mine, other] = keys = [testSshKey("ecdsa"), testSshKey()];
  const [alice, bob] = await Promise.all([peer("sshk-alice"), peer("sshk-bob")]);
  const asked: string[] = [];
  for (const p of [alice, bob]) await stubGitHub(p, new Map(), asked);
  await pair(alice, bob);
  const chat = await chatId(alice);

  await go(alice, "#/identities");
  await alice.page.getByTestId("identity-add").click();
  const add = alice.page.getByTestId("add-identity");
  await add.getByTestId("add-identity-ssh").click();
  await add.getByTestId("add-identity-subject").fill(`${mine.publicKey} me@laptop`);
  await add.getByTestId("add-identity-start").click();
  const statement = (await add.getByTestId("add-identity-copy-1").textContent())!;
  expect(statement).toMatch(/^Ghostly identity proof v1: I control ssh:SHA256:[A-Za-z0-9+/]{43} and authorize /);
  await add.getByTestId("add-identity-paste").fill(other.sign(statement));
  await add.getByTestId("add-identity-finish").click();
  await expect(add.getByTestId("add-identity-error")).toHaveText(/made by SHA256:.* not the key you entered/);
  await add.getByTestId("add-identity-paste").fill(mine.sign(statement));
  await add.getByTestId("add-identity-finish").click();
  await expect(add).toHaveCount(0);

  await go(alice, chat);
  await shareIdentity(alice);
  await closeIdentities(alice);
  await openIdentities(bob);
  await expect(theirFace(bob)).toHaveAttribute("data-status", "verified");
  const back = await turnTheirs(bob);
  await expect(back).toContainText("SSH signature (nistp256)");
  // A re-check looks for a revocation of the proof key; the signature itself needs no forge.
  await back.getByTestId("chat-identity-recheck").click();
  await expect(back.getByTestId("chat-identity-recheck")).toHaveText("Check again");
  await expect(back).toHaveAttribute("data-status", "verified");
  expect(asked).toEqual([]);
});
