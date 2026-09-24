import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { expect, type Peer } from "./fixtures";

/**
 * A NIP-07 signer in the page, like a Nostr browser extension. Its key stays in the test process: the page
 * only gets the public key and the signed events. A disposable key, never a real account. Returns the
 * key pair so the test can also sign events the relay holds beforehand.
 */
export async function injectNostrSigner(peer: Peer, secret = generateSecretKey()): Promise<{ pubkey: string; secret: Uint8Array; signed: (kind: number) => number }> {
  const pubkey = getPublicKey(secret);
  const counts = new Map<number, number>();
  await peer.page.exposeFunction("__testNostrPubkey", () => pubkey);
  await peer.page.exposeFunction("__testNostrSign", (template: Parameters<typeof finalizeEvent>[0]) => { counts.set(template.kind, (counts.get(template.kind) ?? 0) + 1); return finalizeEvent(template, secret); });
  await peer.context.addInitScript(() => {
    const w = window as unknown as Record<string, (...args: unknown[]) => Promise<unknown>> & { nostr?: unknown };
    w.nostr = { getPublicKey: () => w.__testNostrPubkey(), signEvent: (event: unknown) => w.__testNostrSign(event) };
  });
  await peer.page.reload();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
  return { pubkey, secret, signed: kind => counts.get(kind) ?? 0 };
}

/** Identities → Nostr, signed by the injected NIP-07 signer. Leaves the page on Identities. */
export async function addNostrIdentity(peer: Peer): Promise<void> {
  await peer.page.evaluate(() => { location.hash = "#/identities"; });
  await peer.page.getByTestId("identity-add").click();
  const add = peer.page.getByTestId("add-identity");
  await add.getByTestId("add-identity-nostr").click();
  await expect(add.getByTestId("add-identity-signer")).toHaveValue("nip07");
  await add.getByTestId("add-identity-start").click();
  await expect(add).toHaveCount(0);
  await expect(peer.page.getByTestId("identity-proof").filter({ hasText: "Nostr" })).toHaveCount(1);
}
