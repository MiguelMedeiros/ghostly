import { chat, expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/** A small JPEG in one color, as a phone photo would be before the app redraws it. */
async function photo(peer: Peer, color: string): Promise<Buffer> {
  const bytes = await peer.page.evaluate((color) => {
    const canvas = document.createElement("canvas");
    canvas.width = 200; canvas.height = 200;
    const context = canvas.getContext("2d")!;
    context.fillStyle = color; context.fillRect(0, 0, 200, 200);
    return Array.from(atob(canvas.toDataURL("image/jpeg", 0.9).split(",")[1]), (c) => c.charCodeAt(0));
  }, color);
  return Buffer.from(bytes);
}

/** The Profile page is beside the chat list; what is set there applies to this profile only. */
async function onProfile(peer: Peer, work: () => Promise<void>): Promise<void> {
  if (!await peer.page.getByTestId("profile-page").isVisible()) await peer.page.getByTestId("account-profile").click();
  await work();
  await peer.page.goBack();
}

async function setPicture(peer: Peer, color: string): Promise<void> {
  const had = await peer.page.getByTestId("profile-avatar-remove").isVisible();
  const before = had ? await peer.page.getByTestId("account-profile").locator("img").getAttribute("src") : null;
  await peer.page.getByTestId("profile-avatar-input").setInputFiles({ name: "me.jpg", mimeType: "image/jpeg", buffer: await photo(peer, color) });
  await expect(peer.page.getByTestId("account-profile").locator("img")).not.toHaveAttribute("src", before ?? "none");
}

/** The contact's own name as the chat keeps it, under whatever name the chat was given here. */
const contactNick = (peer: Peer) => peer.page.evaluate(() => Object.entries(localStorage)
  .flatMap(([key, value]) => { try { return key.startsWith("ghostly_") ? [JSON.parse(value)] : []; } catch { return []; } })
  .find((session) => session && Array.isArray(session.messages))?.nick as string | undefined);
const header = (peer: Peer) => peer.page.getByTitle("Click to set a name");
const row = (peer: Peer) => peer.page.getByTestId("sidebar");

test("a contact's name and picture arrive by themselves when pairing, follow changes made while away, and a name given here wins", { tag: ["@feature:chat.paired.nickname-sync", "@feature:profiles.picture", "@feature:chats.list.unnamed-contact"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await onProfile(alice, async () => {
    await alice.page.getByTestId("account-nickname").fill("Alice Liddell");
    await setPicture(alice, "#d33");
  });

  // Paired, and nobody wrote anything: Bob's list and header show Alice, picture included, by themselves.
  await pair(alice, bob);
  await expect(header(bob)).toHaveText("Alice Liddell", { timeout: 15_000 });
  await expect(row(bob).getByText("Alice Liddell", { exact: true })).toBeVisible();
  await expect(bob.page.getByTestId("chat-avatar")).toBeVisible({ timeout: 15_000 });
  await expect(bob.page.getByTestId("chat-row-avatar")).toBeVisible();
  const first = await bob.page.getByTestId("chat-avatar").getAttribute("src");

  // Bob never set a name: Alice sees a steady "Contact · <start of his key>" and a pattern of his key, not "Anonymous".
  await expect(header(alice)).toHaveText(/^Contact · \S{6}$/);
  await expect(row(alice).getByText(/^Contact · \S{6}$/)).toBeVisible();
  await expect(row(alice).getByTestId("identicon")).toBeVisible();
  await expect(row(alice).getByText("Anonymous")).toHaveCount(0);

  // Bob goes away; Alice changes both meanwhile; Bob comes back to the new ones.
  const url = bob.page.url();
  await bob.page.close();
  await onProfile(alice, async () => {
    await alice.page.getByTestId("account-nickname").fill("Alice L.");
    await setPicture(alice, "#33d");
  });
  bob.page = await bob.context.newPage();
  await bob.page.goto(url);
  await expect(header(bob)).toHaveText("Alice L.", { timeout: 60_000 });
  await expect(row(bob).getByText("Alice L.", { exact: true })).toBeVisible();
  await expect(bob.page.getByTestId("chat-avatar")).not.toHaveAttribute("src", first!, { timeout: 30_000 });

  // Both online: a rename shows up at once, in the header and the list.
  await onProfile(alice, () => alice.page.getByTestId("account-nickname").fill("Alice Live"));
  await expect(header(bob)).toHaveText("Alice Live", { timeout: 15_000 });
  await expect(row(bob).getByText("Alice Live", { exact: true })).toBeVisible();

  // A name Bob gives the chat stays, whatever Alice calls herself next.
  await header(bob).click();
  await bob.page.getByPlaceholder("Set a name...").fill("My friend");
  await bob.page.getByPlaceholder("Set a name...").press("Enter");
  await expect(header(bob)).toHaveText("My friend");
  await onProfile(alice, () => alice.page.getByTestId("account-nickname").fill("Alice Three"));
  // Bob's app did hear the new name…
  await expect.poll(() => contactNick(bob), { timeout: 15_000 }).toBe("Alice Three");
  // …and still shows his.
  await expect(header(bob)).toHaveText("My friend");
  await expect(row(bob).getByText("My friend", { exact: true })).toBeVisible();
  await expect(row(bob).getByText("Alice Three", { exact: true })).toHaveCount(0);
  await expect(chat(bob)).toBeVisible();
});

test("a profile that stops sharing its name and picture is shown as a contact with no name, and shown again once it shares", { tag: ["@feature:profiles.share", "@feature:chats.list.unnamed-contact"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await onProfile(alice, async () => {
    await alice.page.getByTestId("account-nickname").fill("Private Alice");
    await setPicture(alice, "#3a3");
    await expect(alice.page.getByTestId("profile-share")).toHaveAttribute("aria-checked", "true");
  });
  await pair(alice, bob);
  await expect(header(bob)).toHaveText("Private Alice", { timeout: 15_000 });
  await expect(bob.page.getByTestId("chat-avatar")).toBeVisible({ timeout: 15_000 });

  await onProfile(alice, () => alice.page.getByTestId("profile-share").click());
  await expect(header(bob)).toHaveText(/^Contact · \S{6}$/, { timeout: 15_000 });
  await expect(bob.page.getByTestId("chat-avatar")).toHaveCount(0);
  await expect(row(bob).getByText("Private Alice")).toHaveCount(0);

  // The choice stays with the profile across a reload.
  await alice.page.reload();
  await onProfile(alice, async () => {
    await expect(alice.page.getByTestId("profile-share")).toHaveAttribute("aria-checked", "false");
    await alice.page.getByTestId("profile-share").click();
  });
  await expect(header(bob)).toHaveText("Private Alice", { timeout: 60_000 });
  await expect(bob.page.getByTestId("chat-avatar")).toBeVisible();
});
