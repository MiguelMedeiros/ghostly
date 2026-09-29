import { mkdirSync, readFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { DEFAULT_NOSTR_RELAYS, expect, test, type Peer } from "../support/fixtures";
import { LocalAtproto, atprotoConfigured, type AtprotoAccount } from "../support/atproto";
import { closeIdentities, openIdentities, setLoadPublicProfiles, shareIdentity } from "../support/identities";
import { LocalNostrRelay } from "../support/nostrRelay";
import { addNostrIdentity, injectNostrSigner } from "../support/nostrSigner";
import { pair } from "../support/paired";
import { attachPubky, PubkyApprover, pubkyTestnet } from "../support/pubky";

/**
 * A contact's identities panel is about the contact (docs/wisps/PUBLIC-PROFILES.md, "Posts and follows"): under the
 * deck, the chosen verified identity's profile, the people the reader knows that it follows, and its recent posts,
 * pictures only on a tap. Asked only while the panel is open. No public host is reached: Nostr is the test relay
 * answering the default relays, the Pubky index and Bluesky's AppView are answered here.
 */

const WEBP = readFileSync(new URL("../support/avatar-fixtures/avatar-lossy.webp", import.meta.url));
const PNG = readFileSync(new URL("../../src-tauri/icons/32x32.png", import.meta.url));
const CORS = { "access-control-allow-origin": "*" };
const now = () => Math.floor(Date.now() / 1000);
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", headers: CORS, body: JSON.stringify(body) });
const go = (peer: Peer, hash: string) => peer.page.evaluate(h => { location.hash = h; }, hash);
const chatId = (peer: Peer) => peer.page.evaluate(() => location.hash);
const activity = (peer: Peer) => peer.page.getByTestId("chat-identities").getByTestId("contact-activity");
async function shot(peer: Peer, name: string) {
  const dir = process.env.E2E_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await peer.page.waitForTimeout(500);
  await peer.page.screenshot({ path: `${dir}/${name}.png` });
}

test("a contact's Nostr identity shows its profile, that it follows you, and its notes; pictures only on a tap", {
  tag: ["@feature:proofs.public-activity", "@feature:proofs.public-activity.nostr", "@feature:proofs.public-activity.graph", "@feature:proofs.public-profile.setting"],
}, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const relay = new LocalNostrRelay();
  const [alice, bob] = await Promise.all([peer("act-alice"), peer("act-bob")]);
  await Promise.all([relay.attach(alice.context, "alice", DEFAULT_NOSTR_RELAYS), relay.attach(bob.context, "bob", DEFAULT_NOSTR_RELAYS)]);
  let pictures = 0;
  for (const p of [alice, bob]) await p.context.route("https://image.nostr.build/**", route => { pictures++; return route.fulfill({ status: 200, contentType: "image/webp", headers: CORS, body: WEBP }); });
  const a = await injectNostrSigner(alice);
  const b = await injectNostrSigner(bob);
  // Bob has a Nostr identity of his own; Alice's follow list names it.
  await addNostrIdentity(bob);
  relay.add({ kind: 0, created_at: now() - 600, tags: [], content: JSON.stringify({ name: "alice", display_name: "Alice Nostr", about: "Ghosts and relays.", website: "https://alice.example/" }) }, a.secret);
  relay.add({ kind: 3, created_at: now() - 300, tags: [["p", b.pubkey], ["p", getPublicKey(generateSecretKey())], ["p", getPublicKey(generateSecretKey())]], content: "" }, a.secret);
  for (let i = 0; i < 12; i++) relay.add({ kind: 1, created_at: now() - 5000 + i * 60, tags: [], content: i === 11 ? "Newest <b>note</b> https://image.nostr.build/cat.webp" : `Note ${i}` }, a.secret);
  relay.add({ kind: 1, created_at: now() - 100, tags: [["e", "f".repeat(64)]], content: "A reply, not shown" }, a.secret);

  await addNostrIdentity(alice);
  await pair(alice, bob);
  await shareIdentity(alice, "Nostr");
  await expect(bob.page.getByTestId("chat-identity-badge").first()).toBeVisible();
  const withAlice = await chatId(bob);
  const before = relay.requests.filter(r => r.by === "bob" && r.filter.kinds?.includes(1)).length;
  expect(before).toBe(0);

  // The panel is about Alice: no "Yours" section; her Nostr card comes chosen, and under the deck what it publishes.
  const panel = await openIdentities(bob);
  await expect(panel.getByTestId("chat-identities-mine")).toHaveCount(0);
  const block = activity(bob);
  await expect(block).toHaveAttribute("data-provider", "nostr");
  await expect(block.getByTestId("contact-activity-name")).toHaveText("Alice Nostr");
  await expect(block.getByTestId("contact-activity-counts")).toHaveText("3 following");
  await expect(block.getByTestId("contact-activity-website")).toHaveAttribute("href", "https://alice.example/");
  await expect(block.getByTestId("contact-activity-follows-you")).toBeVisible();
  const posts = block.getByTestId("contact-activity-post");
  await expect(posts).toHaveCount(10);
  await expect(posts.first().getByTestId("contact-activity-post-text")).toContainText("Newest <b>note</b>");
  await expect(posts.first().locator("b")).toHaveCount(0);
  await expect(posts.first().getByTestId("contact-activity-post-open")).toHaveAttribute("href", /^https:\/\/njump\.me\/note1/);
  await expect(block).not.toContainText("A reply, not shown");
  await expect(block.getByTestId("contact-activity-source")).toContainText("relay.damus.io");
  await shot(bob, "nostr-activity");

  // Its picture waits for a tap, then shows re-encoded.
  expect(pictures).toBe(0);
  const show = posts.first().getByTestId("contact-activity-post-image");
  await expect(show).toContainText("image.nostr.build");
  await show.click();
  await expect(posts.first().getByTestId("contact-activity-post-picture")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
  expect(pictures).toBe(1);

  // More, on demand.
  await block.getByTestId("contact-activity-more").click();
  await expect(posts).toHaveCount(12);
  await shot(bob, "nostr-activity-more");

  // Only Alice's key was asked about, only kinds 0, 1 and 3; nothing names Bob.
  const bobs = relay.requests.filter(r => r.by === "bob" && r.filter.authors?.includes(a.pubkey));
  expect(bobs.length).toBeGreaterThan(0);
  expect(bobs.every(r => r.filter.authors!.length === 1 && r.filter.kinds!.every(k => [0, 1, 3].includes(k)))).toBe(true);

  // Closed, nothing more is asked.
  await closeIdentities(bob);
  const asked = relay.requests.length;
  await bob.page.waitForTimeout(1_500);
  expect(relay.requests.length).toBe(asked);

  // Load public profiles off: the block says so, and asks nothing.
  await setLoadPublicProfiles(bob, false);
  await go(bob, withAlice);
  await openIdentities(bob);
  await expect(activity(bob).or(bob.page.getByTestId("contact-activity-off"))).toBeVisible();
  await expect(bob.page.getByTestId("contact-activity-off")).toBeVisible();
  await bob.page.waitForTimeout(1_000);
  expect(relay.requests.length).toBe(asked);
  await closeIdentities(bob);
});

/** The Pubky index for one key: details, counts, posts and a picture file; follow lists are counted, never expected. */
async function answerNexus(context: BrowserContext, key: string, asked: string[]) {
  await context.route("https://nexus.pubky.app/**", route => {
    const url = new URL(route.request().url());
    asked.push(url.pathname + url.search);
    const path = url.pathname;
    if (path === `/v0/user/${key}/details`) return route.fulfill(json({ id: key, name: "Pat Pubky", bio: "Writes on Pubky.", image: null, links: [{ title: "site", url: "https://pat.example/" }], status: null, indexed_at: 1 }));
    if (path === `/v0/user/${key}/counts`) return route.fulfill(json({ posts: 2, following: 7, followers: 12, friends: 2 }));
    if (path === "/v0/stream/posts" && url.searchParams.get("author_id") === key) {
      const file = `pubky://${key}/pub/pubky.app/files/0035RMX0NHQC0`;
      return route.fulfill(json([
        { details: { content: "Hello from Pubky", id: "0035RMX0NHSAG", indexed_at: Date.now() - 3_600_000, author: key, kind: "image", uri: `pubky://${key}/pub/pubky.app/posts/0035RMX0NHSAG`, attachments: [file] },
          relationships: { replied: null, reposted: null, mentioned: [] }, attachments_metadata: [{ uri: file, content_type: "image/webp", name: "cat.webp" }] },
        { details: { content: "Second post", id: "0035RMX0NHSAH", indexed_at: Date.now() - 7_200_000, author: key, kind: "short", uri: "", attachments: [] }, relationships: { replied: null, reposted: null, mentioned: [] } },
      ]));
    }
    if (path === `/static/files/${key}/0035RMX0NHQC0/feed`) return route.fulfill({ status: 200, contentType: "image/webp", headers: CORS, body: WEBP });
    return route.fulfill(json({ error: "not found" }, 404));
  });
}

test("a contact's Pubky identity shows the index's profile and posts; with nobody to compare, no follow list is read", {
  tag: ["@gated", "@feature:proofs.public-activity", "@feature:proofs.public-activity.pubky"],
}, async ({ peer, relay }) => {
  test.skip(!pubkyTestnet(), "Needs the e2e infra's Pubky testnet (npm run e2e:infra:use)");
  test.setTimeout(300_000);
  const approver = await new PubkyApprover(relay).start();
  try {
    const [alice, bob] = await Promise.all([peer("actp-alice"), peer("actp-bob")]);
    await attachPubky(alice.context, relay, approver);
    await attachPubky(bob.context, relay, approver);
    const asked: string[] = [];
    await answerNexus(bob.context, approver.key, asked);
    await answerNexus(alice.context, approver.key, []);
    await alice.page.evaluate(() => { location.hash = "#/identities"; });
    await alice.page.getByTestId("identities-new").click();
    const add = alice.page.getByTestId("add-identity");
    await add.getByTestId("add-identity-pubky").click();
    await add.getByTestId("add-identity-start").click();
    const [passport] = await Promise.all([alice.context.waitForEvent("page"), add.getByTestId("approval-open").click()]);
    await passport.getByRole("button", { name: "Approve" }).click();
    await expect(add).toHaveCount(0, { timeout: 90_000 });

    await pair(alice, bob);
    await shareIdentity(alice, "Pubky", { timeout: 90_000 });
    await openIdentities(bob);
    const block = activity(bob);
    await expect(block).toHaveAttribute("data-provider", "pubky");
    await expect(block.getByTestId("contact-activity-name")).toHaveText("Pat Pubky");
    await expect(block.getByTestId("contact-activity-counts")).toHaveText("12 followers · 7 following");
    await expect(block.getByTestId("contact-activity-website")).toHaveAttribute("href", "https://pat.example/");
    await expect(block.getByTestId("contact-activity-open-profile")).toHaveAttribute("href", `https://pubky.app/profile/${approver.key}`);
    const posts = block.getByTestId("contact-activity-post");
    await expect(posts).toHaveCount(2);
    await expect(posts.first().getByTestId("contact-activity-post-open")).toHaveAttribute("href", `https://pubky.app/post/${approver.key}/0035RMX0NHSAG`);
    expect(asked.some(u => u.startsWith("/static/files/"))).toBe(false);
    await posts.first().getByTestId("contact-activity-post-image").click();
    await expect(posts.first().getByTestId("contact-activity-post-picture")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
    await shot(bob, "pubky-activity");
    // No viewer named; Bob has no Pubky identity and no other contact with one: the follow lists were never read.
    expect(asked.some(u => /viewer_id|observer_id/.test(u))).toBe(false);
    expect(asked.some(u => /\/following|\/followers/.test(u))).toBe(false);
  } finally { await approver.stop(); }
});

const origin = (process.env.E2E_WEB_URL ?? `http://localhost:${process.env.E2E_WEB_PORT || 4173}`).replace("//localhost:", "//127.0.0.1:");

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
  test.use({ baseURL: origin });

  test("a contact's Bluesky identity shows the AppView's posts, links in full, pictures from the account's own server on a tap", {
    tag: ["@gated", "@feature:proofs.public-activity", "@feature:proofs.public-activity.atproto"],
  }, async ({ peer }) => {
    test.skip(!atprotoConfigured(), "Requires the AT Protocol network of e2e/infra (E2E_ATPROTO_PDS_URL, E2E_ATPROTO_PLC_URL)");
    test.setTimeout(300_000);
    const atproto = new LocalAtproto();
    const account = await atproto.account("act");
    const [alice, bob] = await Promise.all([peer("acta-alice"), peer("acta-bob")]);
    await Promise.all([atproto.attach(alice.context), atproto.attach(bob.context)]);
    const CID = "bafkreih3mb3cwnbc5kv5b2qyy24q6banms25i5ut3cbty4ej2x7vjvd6y4";
    const blobs: string[] = [];
    for (const p of [alice, bob]) {
      await p.context.route("https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?**", route => {
        const actor = new URL(route.request().url()).searchParams.get("actor");
        return route.fulfill(json({ did: actor, handle: account.handle, displayName: "Alice Sky", description: "Posting from a test PDS.", followersCount: 1204, followsCount: 87 }));
      });
      await p.context.route("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?**", route => {
        const actor = new URL(route.request().url()).searchParams.get("actor")!;
        const text = "Read example.com/long…";
        return route.fulfill(json({ feed: [
          { post: { uri: `at://${actor}/app.bsky.feed.post/3mv3shqdfuc2e`, author: { did: actor }, indexedAt: new Date().toISOString(), record: {
            text, createdAt: new Date(Date.now() - 3_600_000).toISOString(),
            facets: [{ index: { byteStart: 5, byteEnd: Buffer.byteLength(text) }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com/long/article" }] }],
            embed: { $type: "app.bsky.embed.images", images: [{ alt: "A photo", image: { $type: "blob", ref: { $link: CID }, mimeType: "image/png", size: 100 } }] },
          } } },
          { post: { uri: `at://did:plc:someoneelse/app.bsky.feed.post/3mv3x`, author: { did: "did:plc:someoneelse" }, record: { text: "Reposted", createdAt: new Date().toISOString() } }, reason: { $type: "app.bsky.feed.defs#reasonRepost" } },
        ] }));
      });
      await p.context.route("https://pds.ghostly.test/xrpc/com.atproto.sync.getBlob?**", route => { blobs.push(route.request().url()); return route.fulfill({ status: 200, contentType: "image/png", headers: CORS, body: PNG }); });
    }

    await alice.page.evaluate(() => { location.hash = "#/identities"; });
    await alice.page.getByTestId("identities-new").click();
    const add = alice.page.getByTestId("add-identity");
    await add.getByTestId("add-identity-atproto").click();
    await add.getByTestId("add-identity-field-handle").fill(account.handle);
    const [popup] = await Promise.all([alice.context.waitForEvent("page"), add.getByTestId("add-identity-start").click()]);
    await approveOnServer(popup, account);
    await expect(add).toHaveCount(0, { timeout: 90_000 });

    await pair(alice, bob);
    await shareIdentity(alice, "Bluesky", { timeout: 90_000 });
    await openIdentities(bob);
    const block = activity(bob);
    await expect(block).toHaveAttribute("data-provider", "atproto");
    await expect(block.getByTestId("contact-activity-counts")).toHaveText("1,204 followers · 87 following");
    const posts = block.getByTestId("contact-activity-post");
    await expect(posts).toHaveCount(1);
    await expect(posts.first().getByTestId("contact-activity-post-text")).toContainText("https://example.com/long/article");
    await expect(posts.first().getByTestId("contact-activity-post-open")).toHaveAttribute("href", `https://bsky.app/profile/${account.did}/post/3mv3shqdfuc2e`);
    const before = blobs.filter(u => u.includes(CID)).length;
    await posts.first().getByTestId("contact-activity-post-image").click();
    await expect(posts.first().getByTestId("contact-activity-post-picture")).toHaveAttribute("alt", "A photo");
    expect(blobs.filter(u => u.includes(CID)).length).toBe(before + 1);
    await shot(bob, "bluesky-activity");
  });
});
