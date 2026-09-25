import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { base58 } from "@scure/base";
import { expect, test, type Peer } from "../support/fixtures";
import { closeIdentities, openIdentities, shareIdentity, theirCards, theirFace, turnTheirs } from "../support/identities";
import { pair } from "../support/paired";
import { DOMAIN_SLOTS, startTestDomain, type TestDomain } from "../support/domain";
import { choose } from "../support/select";

/**
 * DID identity proofs. A did:key is signed in the test process, the way a person's own tool would sign it
 * (the private key never enters the app); a did:web is served by support/domain.ts's local HTTPS stub, reached
 * through routes on the domain's own address and the public DNS-over-HTTPS resolvers, so the app resolves it
 * exactly as it does in production.
 */

const chatId = (peer: Peer) => peer.page.evaluate(() => location.hash);
const go = (peer: Peer, hash: string) => peer.page.evaluate(h => { location.hash = h; }, hash);
const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** An Ed25519 did:key and the compact JWS its holder's tool would print for a statement. */
function didKey() {
  const secret = ed25519.utils.randomSecretKey();
  const multibase = `z${base58.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(secret)]))}`;
  const jws = (statement: string) => {
    const signingInput = `${b64u(Buffer.from(JSON.stringify({ alg: "EdDSA" })))}.${b64u(Buffer.from(statement))}`;
    return `${signingInput}.${b64u(ed25519.sign(Buffer.from(signingInput), secret))}`;
  };
  return { did: `did:key:${multibase}`, multibase, jws };
}

/** Identities → Add → Advanced → DID, with the DID typed in; returns the dialog once its preview is shown. */
async function startDidProof(peer: Peer, did: string) {
  await go(peer, "#/identities");
  await peer.page.getByTestId("identity-add").click();
  const add = peer.page.getByTestId("add-identity");
  // DIDs wait under Advanced, so the picker stays simple for newcomers.
  await expect(add.getByTestId("add-identity-did")).toHaveCount(0);
  await add.getByTestId("add-identity-advanced").click();
  await add.getByTestId("add-identity-did").click();
  await add.getByTestId("add-identity-subject").fill(did);
  return add;
}

let site: TestDomain;
test.beforeEach(async ({}, info) => { site = await startTestDomain(info.parallelIndex % DOMAIN_SLOTS); });
test.afterEach(async () => { await site.close(); });

test("a did:key signed outside the app is shown before signing, verified by the one contact it is shared with", { tag: ["@feature:proofs.did", "@feature:proofs.share", "@feature:proofs.picker"] }, async ({ peer }) => {
  const mine = didKey(), other = didKey();
  const [alice, bob, carol] = await Promise.all([peer("did-alice"), peer("did-bob"), peer("did-carol")]);
  await pair(alice, bob);
  const withBob = await chatId(alice);
  await pair(alice, carol);

  // A method Ghostly does not check is named, and nothing can start.
  const add = await startDidProof(alice, "did:plc:ewvi7nxzyoun6zhxrhs64oiz");
  await expect(add.getByTestId("add-identity-preview-error")).toContainText("did:plc is not supported yet");
  await expect(add.getByTestId("add-identity-start")).toBeDisabled();

  // The did:key resolves on the device: its method and its one key, and signing is the only way.
  await add.getByTestId("add-identity-subject").fill(mine.did);
  await expect(add.getByTestId("add-identity-preview")).toHaveAttribute("data-status", "ok");
  await expect(add.getByTestId("add-identity-preview-method")).toHaveText("did:key, the key is the identifier");
  await expect(add.getByTestId("add-identity-preview-key")).toHaveText(`#${mine.multibase.slice(0, 10)}…${mine.multibase.slice(-4)} (Ed25519)`);
  await expect(add.getByTestId("add-identity-signer")).toHaveCount(0);
  await add.getByTestId("add-identity-start").click();

  // The statement, then snippets for jose, @noble/curves and OpenSSL filled in with it.
  const statement = (await add.getByTestId("add-identity-copy-0").textContent())!;
  expect(statement).toMatch(new RegExp(`^Ghostly identity proof v1: I control did:${mine.did} and authorize the Ghostly key [a-z0-9]{52} `));
  await expect(add.getByTestId("add-identity-copy-1")).toContainText(`kid: "${mine.did}#${mine.multibase}"`);
  await expect(add.getByTestId("add-identity-copy-3")).toContainText("openssl pkeyutl -sign -rawin");

  // Another key's signature is refused; the right one is checked the way contacts will, then saved.
  await add.getByTestId("add-identity-paste").fill(other.jws(statement));
  await add.getByTestId("add-identity-finish").click();
  await expect(add.getByTestId("add-identity-error")).toContainText("does not match");
  await add.getByTestId("add-identity-paste").fill(mine.jws(statement));
  await add.getByTestId("add-identity-finish").click();
  await expect(add).toHaveCount(0);
  const proof = alice.page.getByTestId("identity-proof");
  await expect(proof).toHaveCount(1);
  await expect(proof).toContainText(`did:key:${mine.multibase.slice(0, 8)}…`);
  await proof.click();
  await expect(alice.page.getByTestId("identity-panel-subject")).toHaveText(mine.did);

  // Shared with Bob only: his app resolves the did:key itself and checks the JWS.
  await go(alice, withBob);
  await shareIdentity(alice);
  await closeIdentities(alice);
  await expect(bob.page.getByTestId("chat-identity-badges")).toBeVisible();
  await openIdentities(bob);
  await expect(theirCards(bob)).toHaveCount(1);
  await expect(theirFace(bob)).toHaveAttribute("data-status", "verified");
  const back = await turnTheirs(bob);
  await expect(back).toHaveAttribute("data-provider", "did");
  await expect(back.getByTestId("chat-identity-received-subject")).toHaveAttribute("title", mine.did);
  await expect(back).toContainText("did:key · EdDSA JWS by #z6Mk");
  await closeIdentities(bob);

  // Carol was never shown it.
  await openIdentities(carol);
  await expect(theirCards(carol)).toHaveCount(0);
  await closeIdentities(carol);
});

test("a did:web proven by a file beside its did.json is fetched from the domain, and fails once the file is gone", { tag: ["@feature:proofs.did", "@feature:proofs.share", "@feature:proofs.recheck"] }, async ({ peer }) => {
  const did = `did:web:${site.domain}`;
  const point = p256.getPublicKey(p256.utils.randomSecretKey(), false);
  site.files.set("/.well-known/did.json", JSON.stringify({
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: did,
    verificationMethod: [{ id: `${did}#key-1`, type: "JsonWebKey2020", controller: did, publicKeyJwk: { kty: "EC", crv: "P-256", x: b64u(point.slice(1, 33)), y: b64u(point.slice(33)) } }],
    authentication: ["#key-1"],
    assertionMethod: ["#key-1"],
  }));
  const [alice, bob] = await Promise.all([peer("didw-alice"), peer("didw-bob")]);
  for (const p of [alice, bob]) await site.attach(p.context);
  await pair(alice, bob);
  const chat = await chatId(alice);

  // The did:web resolves first: its domain, where its document is, its key; then Sign or Publish.
  const add = await startDidProof(alice, did.toUpperCase().replace("DID:WEB:", "did:web:"));
  await expect(add.getByTestId("add-identity-preview")).toHaveAttribute("data-status", "ok");
  await expect(add.getByTestId("add-identity-preview-domain")).toHaveText(site.domain);
  await expect(add.getByTestId("add-identity-preview-document")).toHaveText(`https://${site.domain}/.well-known/did.json`);
  await expect(add.getByTestId("add-identity-preview-key")).toHaveText("#key-1 (P-256)");
  await choose(add.getByTestId("add-identity-signer"), "file");
  await add.getByTestId("add-identity-start").click();

  const url = (await add.getByTestId("add-identity-copy-0").textContent())!;
  expect(url).toMatch(new RegExp(`^https://${site.domain.replace(/\./g, "\\.")}/\\.well-known/ghostly/[a-f0-9]{64}\\.json$`));
  const file = (await add.getByTestId("add-identity-copy-1").textContent())!;
  expect(JSON.parse(file)).toMatchObject({ ghostly: 1, did, statement: expect.stringMatching(/^Ghostly identity proof v1: I control did:did:web:/) });
  const path = new URL(url).pathname;

  // Not uploaded yet: nothing is saved, and the person is told where it was looked for.
  await add.getByTestId("add-identity-finish").click();
  await expect(add.getByTestId("add-identity-error")).toContainText(`${url} was not found`);
  site.files.set(path, file);
  await add.getByTestId("add-identity-finish").click();
  await expect(add).toHaveCount(0);

  await go(alice, chat);
  await shareIdentity(alice);
  await closeIdentities(alice);

  await openIdentities(bob);
  await expect(theirFace(bob)).toHaveAttribute("data-status", "verified");
  const back = await turnTheirs(bob);
  await expect(back).toContainText(`did:web · statement file beside the did.json of ${site.domain}`);
  // The domain's addresses were checked through the resolver before its web server was contacted.
  expect(site.asked).toContain(`dns ${site.domain}`);
  expect(site.asked).toContain("web /.well-known/did.json");
  expect(site.asked).toContain(`web ${path}`);

  // The file is deleted: Bob's next check no longer confirms it, and says why.
  site.files.delete(path);
  await back.getByTestId("chat-identity-recheck").click();
  await expect(back).toHaveAttribute("data-status", "failed");
  await expect(back).toContainText("was not found");
});
