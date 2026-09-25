import { DidDht } from "@web5/dids";
import { npubEncode } from "nostr-tools/nip19";
import { expect, test } from "../support/fixtures";
import { addNostrIdentity, injectNostrSigner } from "../support/nostrSigner";

/**
 * Every profile has a did:dht (WISP 3xx-did-dht), shown in the Ghostly card's details. The app publishes it to
 * the Pkarr relay (the suite's, support/relay.ts), and an independent resolver, TBD's @web5/dids, reads it
 * there: the identity key alone at first, then with the Nostr identity the person lists, then without it again.
 */
test("the profile's did:dht is published and resolved by @web5/dids, with a Nostr identity listed only while its switch is on",
  { tag: ["@feature:did.dht.profile", "@feature:did.dht.public-links", "@feature:did.dht.interop"] }, async ({ peer, relay }, testInfo) => {
    test.setTimeout(150_000);
    const alice = await peer("did-alice");
    const { pubkey } = await injectNostrSigner(alice);
    const { page } = alice;
    // The resolver asks the same relay the app publishes to, over HTTP (a port of this session's range).
    const gatewayUri = await relay.listen(51150 + testInfo.workerIndex % 40);

    await page.getByTestId("account-identities").click();
    // The page opens on the Ghostly card, whose details hold the public DID.
    const section = page.getByTestId("did-section");
    await expect(section).toBeVisible();
    const did = (await section.getByTestId("did-id").textContent())!.trim();
    expect(did).toMatch(/^did:dht:[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/);
    await expect(section.getByTestId("did-published")).toHaveText("Published", { timeout: 60_000 });

    const resolve = async () => {
      const result = await DidDht.resolve(did, { gatewayUri });
      expect(result.didResolutionMetadata.error).toBeUndefined();
      return result.didDocument!;
    };
    const first = await resolve();
    expect(first.id).toBe(did);
    expect(first.verificationMethod).toHaveLength(1);
    expect(first.verificationMethod![0]).toMatchObject({ id: `${did}#0`, publicKeyJwk: { kty: "OKP", crv: "Ed25519" } });
    expect(first.authentication).toEqual([`${did}#0`]);
    expect(first.assertionMethod).toEqual([`${did}#0`]);
    // Nothing about the person by default.
    expect(first.alsoKnownAs).toBeUndefined();
    expect(first.service).toBeUndefined();

    await addNostrIdentity(alice);
    // The new proof's card came up: back to the Ghostly card.
    await page.getByTestId("identity-ghostly").click();
    await expect(section.getByTestId("did-warning")).toContainText("public to everyone, for good");
    const listed = section.getByTestId("did-list");
    await expect(listed).toHaveCount(1);
    await expect(listed).toHaveAttribute("aria-checked", "false");
    const npub = `nostr:${npubEncode(pubkey)}`;
    await expect(section.getByTestId("did-identity")).toContainText(npub);

    await listed.click();
    await expect(listed).toHaveAttribute("aria-checked", "true");
    await expect.poll(async () => (await resolve()).alsoKnownAs, { timeout: 30_000 }).toEqual([npub]);
    await expect(section.getByTestId("did-published")).toHaveText("Published");

    await listed.click();
    await expect(listed).toHaveAttribute("aria-checked", "false");
    await expect.poll(async () => (await resolve()).alsoKnownAs, { timeout: 30_000 }).toBeUndefined();
    // Same DID throughout: its key is the profile's, not a chat's.
    expect((await resolve()).id).toBe(did);
  });
