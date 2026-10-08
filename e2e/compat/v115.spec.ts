import { chat, delivered, expect, openProfilePage, say, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";
import { oldPeer } from "./release";

/**
 * The current app and a real v1.1.5, the last release: what a contact who has not updated yet still does with it.
 * A chat pairs from either side's invite, and texts go both ways with two ticks on each. In a private group
 * (group-mesh/1, WISP 902) each side catches the other up: the 1.1.5 member, back after its app was closed, gets what a
 * current author sent meanwhile from a third, current member; and a current member back gets a current author's text
 * from the 1.1.5 member, who held it.
 */

/** A sent text's row, with its delivery mark. */
const row = (peer: Peer, text: string) => chat(peer).locator("[data-message-row]").filter({ hasText: text });

for (const host of ["current", "1.1.5"] as const) {
  test(`a chat from the ${host} app's invite goes both ways with v1.1.5, each text delivered`, {
    tag: ["@feature:chat.compat.v115", "@feature:chat.paired.pair", "@feature:chat.paired.receipts"],
  }, async ({ browser, relay, peer }) => {
    const [nina, olga] = await Promise.all([peer("nina"), oldPeer(browser, relay, "1.1.5", "olga")]);
    if (host === "current") await pair(nina, olga);
    else await pair(olga, nina);

    await say(nina, "hello from the current app");
    await expect(chat(olga).getByText("hello from the current app", { exact: true })).toBeVisible();
    await expect(delivered(row(nina, "hello from the current app"))).toBeVisible({ timeout: 60_000 });
    await say(olga, "hello from 1.1.5");
    await expect(chat(nina).getByText("hello from 1.1.5", { exact: true })).toBeVisible();
    await expect(delivered(row(olga, "hello from 1.1.5"))).toBeVisible({ timeout: 60_000 });
    for (const p of [nina, olga]) await expect(delivered(chat(p), "failed")).toHaveCount(0);
  });
}

const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");
const sees = (peer: Peer, text: string) => expect(chat(peer).getByText(text, { exact: true })).toBeVisible({ timeout: 120_000 });
const reachable = (peer: Peer, n: number, of: number) => expect(peer.page.getByTestId("group-members")).toContainText(`${n} of ${of} reachable`, { timeout: 150_000 });

async function setName(peer: Peer, name: string): Promise<void> {
  await openProfilePage(peer.page);
  await peer.page.getByTestId("account-nickname").fill(name);
  await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
  await peer.page.goBack();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

async function post(peer: Peer, text: string): Promise<void> {
  const box = peer.page.getByPlaceholder("Message…");
  await expect(box).toBeEnabled({ timeout: 60_000 });
  await box.fill(text);
  await box.press("Enter");
  await expect(chat(peer).getByText(text, { exact: true })).toBeVisible();
}

/** Closes the peer's app, then opens it again on `url`: the same profile, a new page. */
async function reopen(peer: Peer, url: string): Promise<void> {
  peer.page = await peer.context.newPage();
  await peer.page.goto(url);
  await expect(groupChat(peer)).toBeVisible();
}

test("in a group with v1.1.5, each side catches up the other: 1.1.5 back gets a text from a current member, and the other way", {
  tag: ["@feature:chat.compat.v115", "@feature:groups.catch-up", "@feature:groups.link.join"],
}, async ({ browser, relay, peer }) => {
  test.setTimeout(10 * 60_000);
  const [alice, bob, olga] = await Promise.all([peer("alice"), peer("bob"), oldPeer(browser, relay, "1.1.5", "olga")]);
  await Promise.all([setName(alice, "Alice"), setName(bob, "Bob"), setName(olga, "Olga")]);

  // Alice, on the current app, makes a private group; Bob (current) and Olga (1.1.5) open its link, each in its own app.
  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Status");
  await alice.page.getByTestId("new-group-kind-mesh").click();
  await alice.page.getByTestId("new-group-create").click();
  const shareDialog = alice.page.getByTestId("group-share-dialog");
  await expect(shareDialog.getByTestId("group-link-url")).toHaveValue(/#\/join\/group1\//);
  const link = new URL(await shareDialog.getByTestId("group-link-url").inputValue());
  await shareDialog.getByTestId("group-share-done").click();
  for (const p of [bob, olga]) {
    await p.page.goto(`/${link.hash}`);
    await expect(groupChat(p)).toHaveAttribute("data-status", "active", { timeout: 120_000 });
  }
  for (const p of [alice, bob, olga]) await reachable(p, 2, 2);
  await post(alice, "everyone here");
  for (const p of [bob, olga]) await sees(p, "everyone here");
  const groupHash = new URL(olga.page.url()).hash;

  // Olga (1.1.5) closes her app. Bob posts, then closes his too.
  await olga.page.close();
  await reachable(alice, 1, 2);
  await post(bob, "status while olga is away");
  await sees(alice, "status while olga is away");
  await bob.page.close();
  await reachable(alice, 0, 2);

  // Olga is back: Alice hands Bob's text on to 1.1.5, signed by Bob and named as his.
  await reopen(olga, `/${groupHash}`);
  await sees(olga, "status while olga is away");
  await expect(chat(olga).getByText("~Bob")).toBeVisible();
  await reachable(olga, 1, 2);

  // The other way: Bob is still away. Alice posts, Olga has it, Alice closes; Bob back gets it from 1.1.5.
  await post(alice, "status while bob is away");
  await sees(olga, "status while bob is away");
  await alice.page.close();
  await reachable(olga, 0, 2);
  await reopen(bob, `/${groupHash}`);
  await sees(bob, "status while bob is away");
  await expect(chat(bob).getByText("~Alice").first()).toBeVisible();
  await reachable(bob, 1, 2);
});
