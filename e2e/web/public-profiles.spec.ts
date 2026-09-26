import { mkdirSync, readFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { DEFAULT_NOSTR_RELAYS, expect, test, type Peer } from "../support/fixtures";
import { LocalAtproto, atprotoConfigured, type AtprotoAccount } from "../support/atproto";
import { closeIdentities, openIdentities, setLoadPublicProfiles, shareIdentity, stopSharing, theirCards, theirFace, turnTheirs } from "../support/identities";
import { LocalNostrRelay } from "../support/nostrRelay";
import { addNostrIdentity, injectNostrSigner } from "../support/nostrSigner";
import { pair } from "../support/paired";
import { attachPubky, PubkyApprover, pubkyTestnet } from "../support/pubky";

/**
 * Identity cards wear the public profile of a verified identity (docs/wisps/PUBLIC-PROFILES.md): picture and name on
 * the face, handle, bio, followers/following and where it was loaded from under the card or on its back. A card asks
 * once it is on screen, never before, and only while its proof is current; Settings → Load public profiles turns it
 * off. No public host is reached: Nostr is the test relay answering the default relays, the Pubky index and Bluesky's
 * AppView are answered here.
 */

const PNG = readFileSync(new URL("../../src-tauri/icons/32x32.png", import.meta.url));
/** Real WebP files (e2e/support/avatar-fixtures): what the Pubky index serves (extended, VP8X) and a lossy one. */
const WEBP = readFileSync(new URL("../support/avatar-fixtures/avatar-extended.webp", import.meta.url));
const WEBP_LOSSY = readFileSync(new URL("../support/avatar-fixtures/avatar-lossy.webp", import.meta.url));
const CORS = { "access-control-allow-origin": "*" };
const now = () => Math.floor(Date.now() / 1000);
const chatId = (peer: Peer) => peer.page.evaluate(() => location.hash);
const go = (peer: Peer, hash: string) => peer.page.evaluate(h => { location.hash = h; }, hash);
/** Screenshots for the pull request, when E2E_SHOTS names a directory. */
async function shot(peer: Peer, name: string) {
  const dir = process.env.E2E_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await peer.page.waitForTimeout(700); // a card's turn ends, for the picture
  await peer.page.screenshot({ path: `${dir}/${name}.png` });
}
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", headers: CORS, body: JSON.stringify(body) });

/** Identities → Yours, the proof's card chosen; its face and the details under the deck. */
async function ownCard(page: Page, which: string | RegExp) {
  await page.evaluate(() => { location.hash = "#/identities"; });
  const card = page.getByTestId("identity-proof").filter({ hasText: which });
  await card.click();
  return { card, face: card.locator("[data-deck=face]"), details: page.getByTestId("identity-public-profile-details") };
}

test("a Nostr card loads its signed profile when on screen, for the owner and for a contact it was shared with; off, and once withdrawn, it is gone", {
  tag: ["@feature:proofs.public-profile", "@feature:proofs.public-profile.nostr", "@feature:proofs.public-profile.picture", "@feature:proofs.public-profile.setting", "@feature:proofs.nostr", "@feature:proofs.share"],
}, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const relay = new LocalNostrRelay();
  const [alice, bob] = await Promise.all([peer("pp-alice"), peer("pp-bob")]);
  // Neither changed the relays: the defaults are answered here, and no real relay is reached.
  await Promise.all([relay.attach(alice.context, "alice", DEFAULT_NOSTR_RELAYS), relay.attach(bob.context, "bob", DEFAULT_NOSTR_RELAYS)]);
  // Her picture is a nostr.build short link, as many are: it is read where it redirects (image.nostr.build), a WebP.
  // (A redirect answered by a route is not intercepted on its second leg, so Primal's redirects are unit-tested.)
  let pictures = 0;
  for (const p of [alice, bob]) await p.context.route("https://image.nostr.build/**", route => { pictures++; return route.fulfill({ status: 200, contentType: "image/webp", headers: CORS, body: WEBP_LOSSY }); });
  const a = await injectNostrSigner(alice);
  relay.add({ kind: 0, created_at: now() - 600, tags: [], content: JSON.stringify({ name: "alice", display_name: "Alice Nostr", about: "Ghosts and relays.", picture: "https://nostr.build/i/alice.webp" }) }, a.secret);
  relay.add({ kind: 3, created_at: now() - 300, tags: [["p", getPublicKey(generateSecretKey())], ["p", getPublicKey(generateSecretKey())]], content: "" }, a.secret);

  // Her own card, once made and on screen: the picture and the name on its face, the rest under it.
  await addNostrIdentity(alice);
  const own = await ownCard(alice.page, "Nostr");
  await expect(own.face).toHaveAttribute("data-profile", "found");
  await expect(own.card.getByTestId("id-card-name")).toHaveText("Alice Nostr");
  await expect(own.card.getByTestId("id-card-photo")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
  await expect(own.card.getByTestId("id-card-photo-badge").locator("[data-icon]")).toHaveAttribute("data-icon", "nostr");
  await expect(own.details.getByTestId("identity-public-profile-details-handle")).toHaveText("alice");
  await expect(own.details.getByTestId("identity-public-profile-details-about")).toHaveText("Ghosts and relays.");
  await expect(own.details.getByTestId("identity-public-profile-details-counts")).toHaveText("2 following");
  // The picture's hosts are named too: they saw this device's address as well.
  await expect(own.details.getByTestId("identity-public-profile-details-source")).toContainText("Loaded from relay.damus.io, nos.lol and image.nostr.build");
  await expect(own.details).toContainText("IP address");
  expect(pictures).toBe(1);
  await shot(alice, "own-card");
  // Only her key, only kinds 0 and 3.
  expect(relay.requests.every(r => r.by === "alice" && r.filter.authors?.length === 1 && r.filter.authors[0] === a.pubkey && [0, 3].includes(r.filter.kinds![0]))).toBe(true);

  // Shared with Bob: his app asks nothing about her until her card is on his screen.
  await pair(alice, bob);
  await shareIdentity(alice, "Nostr");
  await closeIdentities(alice);
  await expect(bob.page.getByTestId("chat-identity-badge").first()).toBeVisible();
  expect(relay.requests.filter(r => r.by === "bob")).toEqual([]);
  await openIdentities(bob);
  await expect(theirFace(bob, "Nostr")).toHaveAttribute("data-profile", "found");
  await expect(theirCards(bob).getByTestId("id-card-name")).toHaveText("Alice Nostr");
  await expect(theirCards(bob).getByTestId("id-card-photo")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
  await shot(bob, "contact-card");
  const back = await turnTheirs(bob, "Nostr");
  const theirs = back.getByTestId("chat-identity-public-profile");
  await expect(theirs.getByTestId("chat-identity-public-profile-counts")).toHaveText("2 following");
  await expect(theirs.getByTestId("chat-identity-public-profile-source")).toContainText("relay.damus.io");
  await shot(bob, "contact-card-back");
  expect(relay.requests.filter(r => r.by === "bob").every(r => r.filter.authors?.[0] === a.pubkey)).toBe(true);
  await closeIdentities(bob);
  // Once read, the header's mark wears her picture too, the Nostr mark on its corner.
  const mark = bob.page.getByTestId("chat-identity-badge").first();
  await expect(mark.getByTestId("badge-mark-photo")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
  await shot(bob, "header-mark");
  const withAlice = await chatId(bob);

  // Off on Bob's side: the cards show only what the proof carries, and nothing more is asked.
  await setLoadPublicProfiles(bob, false);
  const asked = relay.requests.length;
  await go(bob, withAlice);
  await openIdentities(bob);
  await expect(theirCards(bob)).toHaveCount(1);
  await expect(theirCards(bob).getByTestId("id-card-name")).toHaveCount(0);
  await expect(theirCards(bob).getByTestId("id-card-photo")).toHaveCount(0);
  await expect(theirFace(bob)).not.toHaveAttribute("data-profile", "found");
  await shot(bob, "setting-off");
  await closeIdentities(bob);
  expect(relay.requests.length).toBe(asked);
  // On again: what was kept was deleted when it went off, so the card asks again.
  await setLoadPublicProfiles(bob, true);
  await go(bob, withAlice);
  await openIdentities(bob);
  await expect(theirCards(bob).getByTestId("id-card-name")).toHaveText("Alice Nostr");
  expect(relay.requests.length).toBeGreaterThan(asked);
  await closeIdentities(bob);

  // Withdrawn: Bob's card no longer wears her profile.
  await stopSharing(alice, "Nostr");
  await closeIdentities(alice);
  await openIdentities(bob);
  await expect(theirFace(bob)).toHaveAttribute("data-status", "withdrawn");
  await expect(theirCards(bob).getByTestId("id-card-name")).toHaveCount(0);
});

/** The Pubky index for one key, as nexus.pubky.app answers it. */
async function answerNexus(context: BrowserContext, key: string, asked: string[]) {
  await context.route("https://nexus.pubky.app/**", route => {
    const path = new URL(route.request().url()).pathname;
    asked.push(path);
    if (path === `/v0/user/${key}/details`) return route.fulfill(json({ id: key, name: "Pat Pubky", bio: "Writes on Pubky.", image: "pubky://x/pub/pubky.app/files/1", links: [], status: null, indexed_at: 1 }));
    if (path === `/v0/user/${key}/counts`) return route.fulfill(json({ tagged: 0, tags: 0, unique_tags: 0, posts: 4, replies: 0, following: 7, followers: 12, friends: 2, bookmarks: 0 }));
    // The real index serves every avatar as WebP (checked 2026-09-26): #292's PNG here hid that no WebP was decoded.
    if (path === `/static/avatar/${key}`) return route.fulfill({ status: 200, contentType: "image/webp", headers: CORS, body: WEBP });
    return route.fulfill(json({ error: "not found" }, 404));
  });
}

test("a Pubky card shows the index's name, picture, followers and following, loaded from nexus.pubky.app", {
  tag: ["@gated", "@feature:proofs.public-profile.pubky", "@feature:proofs.public-profile.picture", "@feature:proofs.pubky"],
}, async ({ peer, relay }) => {
  test.skip(!pubkyTestnet(), "Needs the e2e infra's Pubky testnet (npm run e2e:infra:use)");
  test.setTimeout(240_000);
  const approver = await new PubkyApprover(relay).start();
  try {
    const alice = await peer("ppp-alice");
    await attachPubky(alice.context, relay, approver);
    const asked: string[] = [];
    await answerNexus(alice.context, approver.key, asked);
    await alice.page.evaluate(() => { location.hash = "#/identities"; });
    await alice.page.getByTestId("identities-new").click();
    const add = alice.page.getByTestId("add-identity");
    await add.getByTestId("add-identity-pubky").click();
    await add.getByTestId("add-identity-start").click();
    const [passport] = await Promise.all([alice.context.waitForEvent("page"), add.getByTestId("approval-open").click()]);
    await passport.getByRole("button", { name: "Approve" }).click();
    await expect(add).toHaveCount(0, { timeout: 90_000 });

    const own = await ownCard(alice.page, "Pubky");
    await expect(own.card.getByTestId("id-card-name")).toHaveText("Pat Pubky");
    await expect(own.card.getByTestId("id-card-photo")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
    await expect(own.card.getByTestId("id-card-photo-badge").locator("[data-icon]")).toHaveAttribute("data-icon", "pubky");
    await shot(alice, "pubky-card");
    await expect(own.details.getByTestId("identity-public-profile-details-about")).toHaveText("Writes on Pubky.");
    await expect(own.details.getByTestId("identity-public-profile-details-counts")).toHaveText("12 followers · 7 following");
    await expect(own.details.getByTestId("identity-public-profile-details-source")).toContainText("Loaded from nexus.pubky.app");
    // Exactly this key, and nothing else of the index.
    expect([...new Set(asked)].sort()).toEqual([`/static/avatar/${approver.key}`, `/v0/user/${approver.key}/counts`, `/v0/user/${approver.key}/details`]);
  } finally { await approver.stop(); }
});

const origin = (process.env.E2E_WEB_URL ?? `http://localhost:${process.env.E2E_WEB_PORT || 4173}`).replace("//localhost:", "//127.0.0.1:");

/** The PDS's own login and consent pages (atproto-proofs.spec.ts). */
async function approveOnServer(popup: Page, account: AtprotoAccount) {
  await popup.waitForLoadState();
  const password = popup.locator('input[type="password"]');
  await expect(password).toBeVisible();
  const identifier = popup.locator('input[autocomplete="username"], input[name="username"], input[name="identifier"]').first();
  if (await identifier.count() && !(await identifier.inputValue())) await identifier.fill(account.handle);
  await password.fill(account.password);
  await popup.getByRole("button", { name: /^(Sign in|Next|Log in)$/i }).click();
  await popup.getByRole("button", { name: /^(Authorize|Accept|Allow)$/i }).click();
}

test.describe("Bluesky", () => {
  // AT Protocol's development client only returns to 127.0.0.1 (atproto-proofs.spec.ts).
  test.use({ baseURL: origin });

  test("a Bluesky card shows the AppView's profile, its picture read from the account's own server", {
    tag: ["@gated", "@feature:proofs.public-profile.atproto", "@feature:proofs.atproto"],
  }, async ({ peer }) => {
    test.skip(!atprotoConfigured(), "Requires the AT Protocol network of e2e/infra (E2E_ATPROTO_PDS_URL, E2E_ATPROTO_PLC_URL)");
    test.setTimeout(240_000);
    const atproto = new LocalAtproto();
    const account = await atproto.account("pp");
    const alice = await peer("ppa-alice");
    await atproto.attach(alice.context);
    const CID = "bafkreihwihm6kpd6zuwhhlro75p5qks5qtrcu55jp3gddbfjsieiv7wuka";
    const blobs: string[] = [];
    await alice.context.route("https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?**", route => {
      const actor = new URL(route.request().url()).searchParams.get("actor");
      return route.fulfill(json({ did: actor, handle: account.handle, displayName: "Alice Sky", description: "Posting from a test PDS.", followersCount: 1204, followsCount: 87,
        avatar: `https://cdn.bsky.app/img/avatar/plain/${actor}/${CID}@jpeg` }));
    });
    await alice.context.route("https://pds.ghostly.test/xrpc/com.atproto.sync.getBlob?**", route => {
      blobs.push(route.request().url());
      return route.fulfill({ status: 200, contentType: "image/png", headers: CORS, body: PNG });
    });

    await alice.page.evaluate(() => { location.hash = "#/identities"; });
    await alice.page.getByTestId("identities-new").click();
    const add = alice.page.getByTestId("add-identity");
    await add.getByTestId("add-identity-atproto").click();
    await add.getByTestId("add-identity-field-handle").fill(account.handle);
    const [popup] = await Promise.all([alice.context.waitForEvent("page"), add.getByTestId("add-identity-start").click()]);
    await approveOnServer(popup, account);
    await expect(add).toHaveCount(0, { timeout: 90_000 });

    const own = await ownCard(alice.page, "Bluesky");
    await expect(own.card.getByTestId("id-card-name")).toHaveText("Alice Sky");
    await expect(own.card.locator(".id-card-photo img")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
    await expect(own.details.getByTestId("identity-public-profile-details-handle")).toHaveText(`@${account.handle}`);
    await expect(own.details.getByTestId("identity-public-profile-details-counts")).toHaveText("1,204 followers · 87 following");
    await expect(own.details.getByTestId("identity-public-profile-details-source")).toContainText("Loaded from public.api.bsky.app and pds.ghostly.test");
    expect(blobs).toHaveLength(1);
    expect(blobs[0]).toContain(`did=${encodeURIComponent(account.did)}&cid=${CID}`);
  });
});
