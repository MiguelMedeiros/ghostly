import { chat, delivered, expect, openProfilePage, say, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";
import { latestRelease, oldPeer } from "./release";

/**
 * The current app and a real older release: what a contact who has not updated yet still does with it. v1.1.5, and the
 * newest release, read from the tags: the common case, a contact who updates a day later.
 * A chat pairs from either side's invite, and texts go both ways with two ticks on each. In a private group
 * (group-mesh/1, WISP 902) each side catches the other up: the old member, back after its app was closed, gets what a
 * current author sent meanwhile from a third, current member; and a current member back gets a current author's text
 * from the old member, who held it.
 */

const RELEASES = [
  { release: "1.1.5", tag: ["@feature:chat.compat.v115"] },
  { release: latestRelease, tag: ["@feature:chat.compat.latest"] },
];

/** A sent text's row, with its delivery mark. */
const row = (peer: Peer, text: string) => chat(peer).locator("[data-message-row]").filter({ hasText: text });

for (const { release, tag } of RELEASES) {
  for (const host of ["current", release]) {
    test(`a chat from the ${host} app's invite goes both ways with v${release}, each text delivered`, {
      tag: [...tag, "@feature:chat.paired.pair", "@feature:chat.paired.receipts"],
    }, async ({ browser, relay, peer }) => {
      const [nina, olga] = await Promise.all([peer("nina"), oldPeer(browser, relay, release, "olga")]);
      if (host === "current") await pair(nina, olga);
      else await pair(olga, nina);

      await say(nina, "hello from the current app");
      await expect(chat(olga).getByText("hello from the current app", { exact: true })).toBeVisible();
      await expect(delivered(row(nina, "hello from the current app"))).toBeVisible({ timeout: 60_000 });
      await say(olga, `hello from ${release}`);
      await expect(chat(nina).getByText(`hello from ${release}`, { exact: true })).toBeVisible();
      await expect(delivered(row(olga, `hello from ${release}`))).toBeVisible({ timeout: 60_000 });
      for (const p of [nina, olga]) await expect(delivered(chat(p), "failed")).toHaveCount(0);
    });
  }
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

for (const { release, tag } of RELEASES) {
  test(`in a group with v${release}, each side catches up the other: ${release} back gets a text from a current member, and the other way`, {
    tag: [...tag, "@feature:groups.catch-up", "@feature:groups.link.join"],
  }, async ({ browser, relay, peer }) => {
    test.setTimeout(10 * 60_000);
    const [alice, bob, olga] = await Promise.all([peer("alice"), peer("bob"), oldPeer(browser, relay, release, "olga")]);
    await Promise.all([setName(alice, "Alice"), setName(bob, "Bob"), setName(olga, "Olga")]);

    // Alice, on the current app, makes a private group; Bob (current) and Olga (old) open its link, each in its own app.
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

    // Olga (old) closes her app. Bob posts, then closes his too.
    await olga.page.close();
    await reachable(alice, 1, 2);
    await post(bob, "status while olga is away");
    await sees(alice, "status while olga is away");
    await bob.page.close();
    await reachable(alice, 0, 2);

    // Olga is back: Alice hands Bob's text on to the old app, signed by Bob and named as his.
    await reopen(olga, `/${groupHash}`);
    await sees(olga, "status while olga is away");
    await expect(chat(olga).getByText("~Bob")).toBeVisible();
    await reachable(olga, 1, 2);

    // The other way: Bob is still away. Alice posts, Olga has it, Alice closes; Bob back gets it from the old app.
    await post(alice, "status while bob is away");
    await sees(olga, "status while bob is away");
    await alice.page.close();
    await reachable(olga, 0, 2);
    await reopen(bob, `/${groupHash}`);
    await sees(bob, "status while bob is away");
    await expect(chat(bob).getByText("~Alice").first()).toBeVisible();
    await reachable(bob, 1, 2);
  });
}
