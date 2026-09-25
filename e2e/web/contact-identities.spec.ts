import { mkdirSync } from "node:fs";
import { expect, test, type Peer } from "../support/fixtures";
import { closeIdentities, headerMarks, shareIdentity, theirCards, turnTheirs, backToTheirCards } from "../support/identities";
import { LocalNostrRelay, NOSTR_TEST_RELAY } from "../support/nostrRelay";
import { addNostrIdentity, injectNostrSigner } from "../support/nostrSigner";
import { pair } from "../support/paired";
import { choose } from "../support/select";
import { testSshKey, type TestSshKey } from "../support/ssh";
import { testBitcoinWallet } from "../../packages/browser/test/helpers/bitcoinSign";

/**
 * A contact's identities where one looks for the contact: Alice proves three (a GitHub account by its SSH key, a
 * Nostr key, a Bitcoin address) and shares them with Bob. Bob's chat list shows the two most recognisable marks and
 * "+1", the chat's header stacks them, and a click opens the panel beside the chat: Alice's ID cards, each turning
 * over to how it was checked, Check again, and on the Nostr card what her key published, loaded from Bob's relays.
 * GitHub is answered in the test; the relay lives in the test process; the keys are disposable.
 */

const chatId = (peer: Peer) => peer.page.evaluate(() => location.hash);
const go = (peer: Peer, hash: string) => peer.page.evaluate(h => { location.hash = h; }, hash);
const now = () => Math.floor(Date.now() / 1000);
/** Screenshots for the pull request, when E2E_SHOTS names a directory. */
const shots = process.env.E2E_SHOTS;
async function shot(peer: Peer, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await peer.page.screenshot({ path: `${shots}/${name}.png` });
}

async function stubGitHub(peer: Peer, published: Map<string, string[]>) {
  await peer.context.route("https://api.github.com/**", route => {
    const login = /^https:\/\/api\.github\.com\/users\/([^/]+)\/keys\?per_page=100$/.exec(route.request().url())?.[1];
    const keys = login ? published.get(login) : undefined;
    return keys
      ? route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(keys.map((key, id) => ({ id, key }))) })
      : route.fulfill({ status: 404, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: '{"message":"Not Found"}' });
  });
}

async function addGitHub(peer: Peer, key: TestSshKey, login: string) {
  await go(peer, "#/identities");
  await peer.page.getByTestId("identity-add").click();
  const add = peer.page.getByTestId("add-identity");
  await add.getByTestId("add-identity-ssh-github").click();
  await add.getByTestId("add-identity-subject").fill(login);
  await add.getByTestId("add-identity-start").click();
  const statement = (await add.getByTestId("add-identity-copy-1").textContent())!;
  await add.getByTestId("add-identity-paste").fill(key.sign(statement));
  await add.getByTestId("add-identity-finish").click();
  await expect(add).toHaveCount(0);
}

async function addBitcoin(peer: Peer) {
  const wallet = testBitcoinWallet("p2wpkh");
  await go(peer, "#/identities");
  await peer.page.getByTestId("identity-add").click();
  const add = peer.page.getByTestId("add-identity");
  await add.getByTestId("add-identity-bitcoin").click();
  await add.getByTestId("add-identity-subject").fill(wallet.address);
  await choose(add.getByTestId("add-identity-signer"), "sparrow");
  await add.getByTestId("add-identity-start").click();
  const statement = (await add.getByTestId("add-identity-copy-0").textContent())!.trim();
  await add.getByTestId("add-identity-paste").fill(wallet.signBip322(statement).simple!);
  await add.getByTestId("add-identity-finish").click();
  await expect(add).toHaveCount(0);
}

/** Identities → Nostr: this app asks the test relay and nothing else. */
async function useTestRelay(peer: Peer) {
  await go(peer, "#/identities");
  const relays = peer.page.getByTestId("nostr-relays");
  await expect(relays).toHaveValue("wss://relay.damus.io\nwss://nos.lol");
  await relays.fill(NOSTR_TEST_RELAY);
  await peer.page.getByTestId("nostr-relays-save").click();
  await expect(peer.page.getByTestId("nostr-relays-save")).toBeDisabled();
  await expect(relays).toHaveValue(NOSTR_TEST_RELAY);
}

let keys: TestSshKey[] = [];
test.afterEach(() => { for (const k of keys) k.dispose(); keys = []; });

test("a contact's identities: two marks and +1 in the chat list, a stack in the header, their ID cards in a panel that turn over to how each was checked", { tag: ["@feature:proofs.badges", "@feature:proofs.share", "@feature:proofs.recheck", "@feature:nostr.social.profile"] }, async ({ peer }) => {
  test.setTimeout(6 * 60_000);
  const relay = new LocalNostrRelay();
  const [alice, bob] = await Promise.all([peer("ci-alice"), peer("ci-bob")]);
  await Promise.all([relay.attach(alice.context, "alice"), relay.attach(bob.context, "bob")]);
  const [a] = await Promise.all([injectNostrSigner(alice), injectNostrSigner(bob)]);
  relay.add({ kind: 0, tags: [], content: JSON.stringify({ name: "alice", display_name: "Alice in Chains", about: "Just here for the ghosts." }), created_at: now() - 3600 }, a.secret);
  const ssh = testSshKey();
  keys.push(ssh);
  const published = new Map([["octo-cat", [ssh.publicKey]]]);
  await Promise.all([stubGitHub(alice, published), stubGitHub(bob, published)]);

  await addNostrIdentity(alice);
  await addGitHub(alice, ssh, "octo-cat");
  await addBitcoin(alice);
  await expect(alice.page.getByTestId("identity-proof")).toHaveCount(3);
  // Bob's relays are set on Identities → Nostr, which shows once his profile has a Nostr key.
  await addNostrIdentity(bob);
  await useTestRelay(bob);
  await pair(alice, bob);
  const bobsChat = await chatId(bob);

  for (const which of ["GitHub", "Nostr", "Bitcoin"]) await shareIdentity(alice, which);
  await closeIdentities(alice);

  // Bob's chat list: the two most recognisable (GitHub, then Nostr) and +1 for the Bitcoin address.
  await go(bob, bobsChat);
  const row = bob.page.getByTestId("chat-row").first();
  const marks = row.getByTestId("contact-marks");
  await expect(marks).toBeVisible({ timeout: 60_000 });
  await expect(marks.getByTestId("contact-mark")).toHaveCount(2);
  await expect(marks.getByTestId("contact-mark").nth(0)).toHaveAttribute("data-icon", "ssh-github");
  await expect(marks.getByTestId("contact-mark").nth(1)).toHaveAttribute("data-icon", "nostr");
  await expect(marks.getByTestId("contact-marks-more")).toHaveText("+1");
  // The time still shows whole beside them.
  await expect(row.getByTestId("chat-row-time")).toBeVisible();

  // The header: the three stacked, one check, and each mark named on hover.
  const stack = bob.page.getByTestId("chat-identity-badges");
  await expect(stack.getByTestId("chat-identity-badge")).toHaveCount(3);
  await expect(stack.getByTestId("chat-identity-badge").first()).toHaveAttribute("data-icon", "ssh-github");
  await expect(stack.getByTestId("chat-identity-check-3")).toBeVisible();
  await stack.getByTestId("chat-identity-badge").first().hover();
  await expect(bob.page.getByTestId("chat-identity-tip")).toHaveText(/^GitHub \(SSH key\): octo-cat · verified /);
  await shot(bob, "header");

  // A click opens the panel beside the chat, not a modal: the chat stays usable.
  await stack.click();
  const panel = bob.page.getByTestId("chat-identities");
  await expect(panel).toBeVisible();
  await expect(bob.page.getByPlaceholder(/Message/)).toBeEditable();
  await expect(theirCards(bob)).toHaveCount(3);
  await shot(bob, "panel");

  // A click turns the GitHub card over: how it was checked, and Check again.
  let back = await turnTheirs(bob, "GitHub");
  await expect(back).toHaveAttribute("data-status", "verified");
  await expect(back).toContainText("Only the holder of this key could have made this proof.");
  await expect(back.getByTestId("chat-identity-checked")).toContainText("On this device");
  await bob.page.waitForTimeout(700); // the turn's end, for the picture
  await shot(bob, "back");
  const checked = await back.getByTestId("chat-identity-checked").textContent();
  await back.getByTestId("chat-identity-recheck").click();
  await expect(back.getByTestId("chat-identity-recheck")).toHaveText("Check again");
  await expect(back.getByTestId("chat-identity-received-status")).toHaveText("Verified");
  expect(checked).toBeTruthy();
  await backToTheirCards(bob);

  // The Nostr card's back loads what the key published, from Bob's relay, only when asked.
  back = await turnTheirs(bob, "Nostr");
  await expect(back.getByTestId("nostr-contact-note")).toContainText("Loading asks your relays (relay.ghostly.test)");
  expect(relay.requests.filter(r => r.by === "bob")).toEqual([]);
  await back.getByTestId("nostr-load-profile").click();
  await expect(back.getByTestId("nostr-profile-name")).toContainText("Alice in Chains");
  await shot(bob, "nostr");

  // Esc closes it, and the header opens it again.
  await bob.page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await stack.click();
  await expect(panel).toBeVisible();

  // Every width. A wide window: the panel docks beside the chat, which narrows; three marks in the header.
  const page = bob.page;
  const visibleMarks = () => stack.getByTestId("chat-identity-badge").evaluateAll(els => els.filter(e => (e as HTMLElement).offsetWidth > 0).length);
  const box = async (testId: string) => (await page.getByTestId(testId).first().boundingBox())!;
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(".contact-panel-backdrop")).toBeHidden();
  expect((await box("chat-identities")).x + (await box("chat-identities")).width).toBeCloseTo(1440, 0);
  expect(await visibleMarks()).toBe(3);
  await shot(bob, "w1440");
  // 1100: the column is too narrow to share; the panel lies over the chat, a backdrop behind it.
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(page.locator(".contact-panel-backdrop")).toBeVisible();
  expect(await visibleMarks()).toBe(3);
  await shot(bob, "w1100");
  // The chat list at its narrowest: one mark and "+2", the time untouched.
  const handle = await box("sidebar-resize");
  await page.mouse.move(handle.x + 1, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(0, handle.y + 100, { steps: 5 });
  await page.mouse.up();
  await expect(marks.getByTestId("contact-mark").nth(1)).toBeHidden();
  await expect(marks.locator("[data-narrow]")).toHaveText("+2");
  const name = await box("chat-row-time"), last = (await marks.boundingBox())!;
  expect(last.x + last.width).toBeLessThanOrEqual(name.x);
  await shot(bob, "sidebar-min");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await shot(bob, "sidebar-min-closed");
  // A phone: one mark and "+2" in the header, and the panel is a sheet from the bottom, the screen's width.
  await page.setViewportSize({ width: 390, height: 844 });
  await go(bob, bobsChat);
  await expect.poll(visibleMarks).toBe(1);
  await expect(stack.getByTestId("chat-identity-more-1")).toBeVisible();
  await expect(stack.getByTestId("chat-identity-more-1")).toHaveText("+2");
  await shot(bob, "phone-header");
  await stack.click();
  await expect(panel).toBeVisible();
  const sheet = await box("chat-identities");
  expect(sheet.width).toBeCloseTo(390, 0);
  expect(sheet.y + sheet.height).toBeCloseTo(844, 0);
  await shot(bob, "phone-panel");
});

test("a contact who shared no proof: the header still has their Ghostly mark, which opens the panel on their Ghostly card, by click or keyboard, on a phone too", { tag: ["@feature:proofs.badges"] }, async ({ peer }) => {
  test.setTimeout(3 * 60_000);
  const [alice, bob] = await Promise.all([peer("cn-alice"), peer("cn-bob")]);
  await pair(alice, bob);
  const page = bob.page;
  const stack = headerMarks(bob);
  const mark = stack.getByTestId("chat-identity-ghostly-mark");
  const panel = page.getByTestId("chat-identities");
  const NOTHING = /Their Ghostly identity\. Nothing else shared by .+ yet\.$/;

  // Nothing shared: one quiet mark, no proof's mark and no check, named for what it opens.
  await expect(mark).toBeVisible();
  await expect(stack).toHaveAttribute("data-count", "0");
  await expect(stack.getByTestId("chat-identity-badge")).toHaveCount(0);
  await expect(stack.locator("[data-testid^=chat-identity-check-]:visible")).toHaveCount(0);
  await expect(stack).toHaveAccessibleName(/^Identities with .+: Their Ghostly identity\./);
  await expect(stack).toHaveAttribute("aria-expanded", "false");
  await mark.hover();
  await expect(page.getByTestId("chat-identity-tip")).toHaveText(NOTHING);
  await shot(bob, "ghostly-header");

  // A click opens the panel on their Ghostly card, the only one they have.
  await stack.click();
  await expect(panel).toBeVisible();
  await expect(stack).toHaveAttribute("aria-expanded", "true");
  await expect(panel.getByTestId("chat-identity-ghostly")).toHaveAttribute("aria-checked", "true");
  await expect(theirCards(bob)).toHaveCount(0);
  await expect(panel.getByTestId("chat-identities-none")).toHaveText(/^Nothing else shared by .+ yet\.$/);
  await shot(bob, "ghostly-panel");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  // The keyboard: the mark is in the tab order, Enter opens it, Escape closes and gives the focus back.
  await page.mouse.move(0, 0);
  await stack.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(stack).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("chat-identity-ghostly")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(stack).toBeFocused();

  // A phone, and the longest name a chat takes: the name gives way, the mark stays whole beside it, clear of the
  // header's buttons, and opens the sheet on their Ghostly card.
  await page.setViewportSize({ width: 390, height: 844 });
  const name = page.getByTitle("Click to set a name");
  await name.click();
  await page.getByPlaceholder("Set a name...").fill("A contact with a very long nam");
  await page.getByPlaceholder("Set a name...").press("Enter");
  await expect(name).toHaveText("A contact with a very long nam");
  await expect(mark).toBeVisible();
  const box = async (l: ReturnType<typeof page.getByTestId>) => (await l.boundingBox())!;
  const [n, m] = [await box(name), await box(mark)];
  expect(await name.evaluate(e => e.scrollWidth > e.clientWidth), "the name is cut, not the mark").toBe(true);
  expect(n.width).toBeGreaterThan(40);
  expect(n.x + n.width).toBeLessThanOrEqual(m.x);
  const mw = await box(stack);
  expect(mw.x + mw.width).toBeLessThanOrEqual(390);
  for (const id of ["call-audio", "call-video", "chat-options"]) {
    const button = page.getByTestId(id);
    if (await button.isVisible()) expect(mw.x + mw.width, `the mark is clear of ${id}`).toBeLessThanOrEqual((await box(button)).x);
  }
  // Nothing lies over it.
  expect(await mark.evaluate(e => { const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
  await shot(bob, "ghostly-phone-header");
  await stack.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("chat-identity-ghostly")).toHaveAttribute("aria-checked", "true");
  expect((await box(panel)).width).toBeCloseTo(390, 0);
  await shot(bob, "ghostly-phone-panel");
});
