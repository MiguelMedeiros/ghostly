import { expect, test, type Peer } from "../support/fixtures";

/**
 * The group's link, front and center: a new group opens on it (QR, address, Copy, Share and what
 * it does), the header's Share link brings it back, and opening it lands in the group waiting to be
 * let in, with nothing to decide.
 */
const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");

/** Records what the page copies and shares instead of touching the machine's clipboard or share sheet. */
async function captureSharing(peer: Peer, webShare: boolean): Promise<void> {
  await peer.page.evaluate(webShare => {
    const log = { copied: [] as string[], shared: [] as { title?: string; url?: string }[] };
    Object.assign(window, { qaSharing: log });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { log.copied.push(value); } } });
    Object.defineProperty(navigator, "share", { configurable: true, value: webShare ? async (data: { title?: string; url?: string }) => { log.shared.push(data); } : undefined });
  }, webShare);
}
const sharing = (peer: Peer) => peer.page.evaluate(() => (window as unknown as { qaSharing: { copied: string[]; shared: { title?: string; url?: string }[] } }).qaSharing);

test("a new group opens on its link; Copy, Share and the header's Share link; joining waits with nothing to decide", async ({ peer }) => {
  test.setTimeout(6 * 60_000);
  const alice = await peer("alice");
  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await expect(alice.page.getByTestId("new-group-dialog")).toContainText("You get a link to share");
  await alice.page.getByTestId("new-group-name").fill("Open door");
  await alice.page.getByTestId("new-group-create").click();

  // The screen a new group ends on: the link is the main thing, with a QR, and what it does.
  const dialog = alice.page.getByTestId("group-share-dialog");
  await expect(dialog).toContainText("Open door is ready");
  await expect(dialog.getByTestId("group-link-qr").locator("svg")).toBeVisible();
  const url = await dialog.getByTestId("group-link-url").inputValue();
  expect(url).toMatch(/#\/join\/group1\/[A-Za-z0-9_-]{22}\/[a-z0-9]{52}$/);
  await expect(dialog.getByTestId("group-link-note")).toContainText("Anyone who opens this link joins");

  // Copy copies the link; Share hands it to the Web Share API where there is one…
  await captureSharing(alice, true);
  await dialog.getByTestId("group-link-copy").click();
  await expect(dialog.getByTestId("group-link-copy")).toContainText("Copied");
  await dialog.getByTestId("group-link-share").click();
  await expect(dialog.getByTestId("group-link-share")).toContainText("Shared");
  expect(await sharing(alice)).toEqual({ copied: [url], shared: [{ title: "Join Open door on Ghostly", url }] });
  // …and copies it where there is none, so there is always something to paste.
  await captureSharing(alice, false);
  await dialog.getByTestId("group-link-share").click();
  await expect(dialog.getByTestId("group-link-copy")).toContainText("Copied");
  expect((await sharing(alice)).copied).toEqual([url]);

  await dialog.getByTestId("group-share-done").click();
  await expect(dialog).toHaveCount(0);
  await expect(alice.page.getByTestId("group-name")).toHaveText("Open door");

  // The header brings it back, and the members panel starts with it.
  await alice.page.getByTestId("group-share").click();
  await expect(alice.page.getByTestId("group-share-dialog").getByTestId("group-link-url")).toHaveValue(url);
  await alice.page.getByTestId("group-share-done").click();
  await alice.page.getByTestId("group-members").click();
  const panel = alice.page.getByTestId("group-members-dialog");
  await expect(panel.getByTestId("group-link-url")).toHaveValue(url);
  expect(await panel.getByTestId("group-link").evaluate(link => {
    const list = link.parentElement!.querySelector('[data-testid="group-member-list"]')!;
    return !!(link.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  // Turned off, the header's Share link turns it on again, as a new link.
  await panel.getByTestId("group-link-disable").click();
  await expect(panel.getByTestId("group-link")).toHaveAttribute("data-state", "off");
  await alice.page.keyboard.press("Escape");
  await alice.page.getByTestId("group-share").click();
  const fresh = await alice.page.getByTestId("group-share-dialog").getByTestId("group-link-url").inputValue();
  expect(fresh).not.toBe(url);
  await alice.page.getByTestId("group-share-done").click();

  // Bob, on a phone, opens it while Alice's app is closed: he lands in the group, waiting, with nothing to choose.
  const groupUrl = alice.page.url();
  await alice.page.close();
  const bob = await peer("bob", { mobile: true });
  await bob.page.goto(fresh);
  await expect(groupChat(bob)).toBeVisible({ timeout: 30_000 });
  const waiting = bob.page.getByTestId("group-joining");
  await expect(waiting).toContainText("Waiting to be let in");
  await expect(waiting).toContainText("happens on its own");
  await expect(bob.page.getByPlaceholder("Message…")).toHaveCount(0);
  await expect(bob.page.getByTestId("group-accept")).toHaveCount(0);
  await expect(bob.page.getByTestId("group-share")).toHaveCount(0);

  // Alice's app opens again: Bob is let in without doing anything, and can talk.
  alice.page = await alice.context.newPage();
  await alice.page.goto(groupUrl);
  await expect(groupChat(bob)).toHaveAttribute("data-status", "active", { timeout: 120_000 });
  await expect(bob.page.getByPlaceholder("Message…")).toBeEnabled({ timeout: 60_000 });
  // Only the admin hands out the link in this profile.
  await expect(bob.page.getByTestId("group-share")).toHaveCount(0);
});
