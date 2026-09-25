import { expect, test, type Peer } from "../support/fixtures";
import { closeIdentities, myStatus, openIdentities, shareIdentity, theirCards, theirFace, turnTheirs } from "../support/identities";
import { pair } from "../support/paired";
import { testBitcoinWallet } from "../../packages/browser/test/helpers/bitcoinSign";
import { choose } from "../support/select";

/**
 * A Bitcoin address proof end to end, on a test network. Alice signs the statement once for a signet
 * address, the way her wallet would (a disposable key held in this process, never in the page), and shares
 * it with Bob only: Bob's app verifies it; Carol, in another chat with Alice, sees nothing. A signature by
 * another address, or over another statement, is refused before anything is saved.
 */

const chatId = (peer: Peer) => peer.page.evaluate(() => location.hash);
const go = (peer: Peer, hash: string) => peer.page.evaluate(h => { location.hash = h; }, hash);

test("a Bitcoin address proof: verified by the contact it is shared with, absent for another", { tag: ["@feature:proofs.bitcoin", "@feature:proofs.share"] }, async ({ peer }) => {
  const [alice, bob, carol] = await Promise.all([peer("btc-alice"), peer("btc-bob"), peer("btc-carol")]);
  await pair(alice, bob);
  const withBob = await chatId(alice);
  await pair(alice, carol);
  const withCarol = await chatId(alice);

  const wallet = testBitcoinWallet("p2wpkh"), stranger = testBitcoinWallet("p2wpkh");
  expect(wallet.address).toMatch(/^tb1q/);

  // Identities → Bitcoin address, signed in "Sparrow".
  await go(alice, "#/identities");
  await alice.page.getByTestId("identity-add").click();
  const add = alice.page.getByTestId("add-identity");
  await add.getByTestId("add-identity-bitcoin").click();
  // What it does not prove is said before anything is signed.
  await expect(add).toContainText("Does not prove the address holds any balance");
  await expect(add).toContainText("Does not prove they would pay you");
  await add.getByTestId("add-identity-subject").fill(wallet.address.toUpperCase());
  await choose(add.getByTestId("add-identity-signer"), "sparrow");
  await add.getByTestId("add-identity-start").click();

  // What the person copies into the wallet: one line naming this address (normalized to lower case).
  const statement = (await add.getByTestId("add-identity-copy-0").textContent())!.trim();
  expect(statement).toMatch(new RegExp(`^Ghostly identity proof v1: I control bitcoin:${wallet.address} and authorize `));
  await expect(add).toContainText("BIP322 (Simple)");
  await expect(add).toContainText("does not show a balance");

  const paste = add.getByTestId("add-identity-paste");
  const finish = add.getByTestId("add-identity-finish");
  const error = add.getByTestId("add-identity-error");
  // Another address's signature over the right statement: refused, nothing saved.
  await paste.fill(stranger.signBip322(statement).simple!);
  await finish.click();
  await expect(error).toContainText("does not match");
  // The right address over another statement: refused.
  await paste.fill(wallet.signBip322(`${statement}.`).simple!);
  await finish.click();
  await expect(error).toContainText("does not match");
  await expect(alice.page.getByTestId("identity-proof")).toHaveCount(0);
  // The real one, wrapped over two lines the way a narrow wallet window copies it.
  const signature = wallet.signBip322(statement).simple!;
  await paste.fill(`${signature.slice(0, 60)}\n${signature.slice(60)}`);
  await finish.click();
  await expect(add).toHaveCount(0);
  const proof = alice.page.getByTestId("identity-proof");
  await expect(proof).toHaveCount(1);
  await expect(proof).toContainText("Bitcoin address");
  await expect(proof).toContainText("test network");

  // Shared with Bob, and only with Bob.
  await go(alice, withBob);
  await shareIdentity(alice);
  await closeIdentities(alice);

  await openIdentities(bob);
  await expect(theirCards(bob)).toHaveCount(1);
  await expect(theirFace(bob)).toHaveAttribute("data-status", "verified");
  const back = await turnTheirs(bob);
  await expect(back).toHaveAttribute("data-provider", "bitcoin");
  await expect(back.getByTestId("chat-identity-received-subject")).toHaveAttribute("title", wallet.address);
  await expect(back).toContainText("BIP-322 simple signature, P2WPKH, test network");
  await closeIdentities(bob);

  const none = await openIdentities(carol);
  await expect(none.getByTestId("chat-identities-none")).toBeVisible();
  await expect(theirCards(carol)).toHaveCount(0);
  await closeIdentities(carol);
  await go(alice, withCarol);
  await openIdentities(alice);
  await expect(await myStatus(alice)).toHaveText("Not shared");
});
