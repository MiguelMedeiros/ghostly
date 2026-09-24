// Private-group screenshots (WISP 9xx, group-mesh/1): Boo makes a group, invites Casper and Spooky
// from its contacts, and the three talk. Desktop from Boo's side, phone from Casper's.
import { test, expect } from "@playwright/test";
import { LocalRelay } from "../../../e2e/support/relay";
import { open, shot, setNickname, pair, avatar, toBottom, chat, type Peer } from "./helpers";

const GROUP = "Haunted house";
/** Who says what, in order; each line is awaited on every other member's screen. */
const GROUP_TALK: readonly (readonly [who: 0 | 1 | 2, text: string])[] = [
  [0, "who's up for the haunted house tonight?"],
  [1, "me 👻"],
  [2, "count me in. bring snacks"],
  [1, "and a flashlight. the stairs creak"],
  [0, "midnight at the old gate then 🕯️"],
];

/** Profile name and picture, through the real profile page (helpers' dressUp, for any peer). */
async function dress(p: Peer, bg: string, glyph: string, name: string) {
  await p.page.goto("/#/profile").catch(() => {});
  if (!await p.page.getByTestId("profile-page").isVisible()) await p.page.getByTestId("account-profile").click();
  await expect(p.page.getByTestId("profile-page")).toBeVisible();
  await p.page.getByTestId("profile-name").fill(name);
  await p.page.getByTestId("profile-name").press("Enter");
  await p.page.getByTestId("profile-avatar-input").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: await avatar(p, bg, glyph) });
  await expect(p.page.getByTestId("profile-avatar-remove")).toBeVisible();
  await p.page.goto("/#/");
  await expect(p.page.getByTitle("New Chat").first()).toBeVisible();
}

const home = async (p: Peer) => { await p.page.goto("/#/"); await expect(p.page.getByTitle("New Chat").first()).toBeVisible(); };

/** Three dressed peers; Boo is paired with Casper and with Spooky, who never meet outside the group. */
async function cast(browser: Parameters<typeof open>[0], relay: LocalRelay, baseURL: string, mobile: boolean) {
  const peers = await Promise.all(["Boo", "Casper", "Spooky"].map(n => open(browser, relay, baseURL, n, mobile)));
  const looks = [["#7c5cff", "👻"], ["#2bb6a3", "🕯️"], ["#e0773a", "🎃"]] as const;
  for (const [i, p] of peers.entries()) {
    await setNickname(p, p.name);
    await dress(p, looks[i][0], looks[i][1], p.name);
  }
  const [boo, casper, spooky] = peers;
  await pair(boo, casper);
  await home(boo);
  await pair(boo, spooky);
  return peers;
}

/** Boo creates the group, invites both contacts from the members panel; they accept from their chat list. */
async function formGroup(boo: Peer, members: Peer[]) {
  await home(boo);
  await boo.page.getByTestId("new-group").click();
  await boo.page.getByTestId("new-group-name").fill(GROUP);
  await boo.page.getByTestId("new-group-create").click();
  await expect(boo.page.getByTestId("group-name")).toHaveText(GROUP);
  for (const m of members) {
    await boo.page.getByTestId("group-members").click();
    const row = boo.page.getByTestId("group-invite-contact").filter({ hasText: m.name });
    await expect(row.getByTestId("group-invite")).toBeEnabled({ timeout: 60_000 });
    await row.getByTestId("group-invite").click();
    await expect(row).toContainText("Invited…");
    await boo.page.keyboard.press("Escape");
  }
  for (const m of members) {
    await home(m);
    const row = m.page.getByTestId("group-row").filter({ hasText: GROUP });
    await row.getByTestId("group-accept").click();
    await expect(row).toContainText(/\d+ members?/, { timeout: 60_000 });
    await row.click();
    await expect(m.page.getByTestId("group-chat")).toHaveAttribute("data-status", "active", { timeout: 60_000 });
  }
  for (const m of members) await expect(boo.page.getByTestId("group-event").filter({ hasText: `${m.name} joined` })).toBeVisible({ timeout: 60_000 });
  for (const p of [boo, ...members]) await expect(p.page.getByTestId("group-members")).toContainText("2 of 2 reachable", { timeout: 120_000 });
}

async function talk(peers: Peer[]) {
  for (const [who, text] of GROUP_TALK) {
    const box = peers[who].page.getByPlaceholder("Message…");
    await expect(box).toBeEnabled();
    await box.fill(text);
    await box.press("Enter");
    for (const p of peers) await expect(chat(p).getByText(text, { exact: true })).toBeVisible({ timeout: 90_000 });
  }
  // Sender names ride on the bubbles.
  await expect(chat(peers[0]).getByText("~Casper").first()).toBeVisible();
  await expect(chat(peers[0]).getByText("~Spooky").first()).toBeVisible();
}

test("desktop: a three-member private group, from the admin's side", async ({ browser, baseURL }) => {
  const relay = new LocalRelay();
  const [boo, casper, spooky] = await cast(browser, relay, baseURL!, false);
  await formGroup(boo, [casper, spooky]);
  await talk([boo, casper, spooky]);
  await toBottom(boo);
  await shot(boo, "groups.png");
  await boo.page.getByTestId("group-members").click();
  await expect(boo.page.getByTestId("group-member").filter({ hasText: "You" })).toHaveAttribute("data-role", "admin");
  await shot(boo, "x-groups-members.png");
  await boo.page.keyboard.press("Escape");
  await toBottom(casper);
  await shot(casper, "x-groups-casper.png");
  relay.close();
});

test("phone: the same group on Casper's phone", async ({ browser, baseURL }) => {
  const relay = new LocalRelay();
  const [boo, casper, spooky] = await cast(browser, relay, baseURL!, true);
  await formGroup(boo, [casper, spooky]);
  await talk([boo, casper, spooky]);
  await toBottom(casper);
  await shot(casper, "groups-mobile.png");
  await toBottom(boo);
  await shot(boo, "x-groups-mobile-boo.png");
  await home(boo);
  await shot(boo, "x-groups-mobile-list.png");
  relay.close();
});
