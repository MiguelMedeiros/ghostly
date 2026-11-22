import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, openProfilePage, test, type Peer } from "../support/fixtures";

/**
 * A group as a person makes one: New group with what it offers first (a community), its link opened by
 * someone who is nobody's contact, then a message each way and a file that arrives byte for byte.
 */
const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");
const wallpaper = (peer: Peer) => peer.page.locator(".chat-wallpaper");

async function setName(peer: Peer, name: string): Promise<void> {
  await openProfilePage(peer.page);
  await peer.page.getByTestId("account-nickname").fill(name);
  await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
  await peer.page.goBack();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

async function say(peer: Peer, text: string): Promise<void> {
  const box = groupChat(peer).getByPlaceholder("Message…");
  await expect(box).toBeEnabled({ timeout: 60_000 });
  await box.fill(text);
  await box.press("Enter");
  await expect(wallpaper(peer).getByText(text, { exact: true })).toBeVisible();
}

const PLAN = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 31 + (i >> 9)) & 0xff));

test("a new group, joined through its link: a message each way and a file that arrives intact", { tag: ["@journey", "@feature:groups.create", "@feature:groups.community.create", "@feature:groups.community.join", "@feature:groups.community.send", "@feature:groups.files", "@feature:groups.files.compose"] }, async ({ peer }) => {
  test.setTimeout(5 * 60_000);
  const [alice, bob] = await Promise.all([peer("group-files-alice"), peer("group-files-bob")]);
  await Promise.all([setName(alice, "Alice"), setName(bob, "Bob")]);

  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Haunted house");
  await alice.page.getByTestId("new-group-create").click();
  const share = alice.page.getByTestId("group-share-dialog");
  const url = await share.getByTestId("group-link-url").inputValue();
  await share.getByTestId("group-share-done").click();

  await bob.page.goto(url);
  await expect(groupChat(bob)).toHaveAttribute("data-status", "active", { timeout: 180_000 });
  await expect(alice.page.getByTestId("group-members")).toContainText("2 members", { timeout: 120_000 });

  await say(alice, "the attic at midnight");
  await expect(wallpaper(bob).getByText("the attic at midnight", { exact: true })).toBeVisible({ timeout: 90_000 });
  await say(bob, "bringing a lantern");
  await expect(wallpaper(alice).getByText("bringing a lantern", { exact: true })).toBeVisible({ timeout: 90_000 });

  // Under 8 MiB: it downloads by itself on the member's side.
  await groupChat(alice).getByTestId("file-input").setInputFiles({ name: "floor plan.bin", mimeType: "application/octet-stream", buffer: PLAN });
  const bubble = groupChat(bob).getByTestId("file-bubble").filter({ hasText: "floor plan.bin" });
  await expect(bubble.getByTestId("file-save")).toBeVisible({ timeout: 90_000 });
  const download = bob.page.waitForEvent("download");
  await bubble.getByTestId("file-save").click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe("floor plan.bin");
  expect(createHash("sha256").update(readFileSync(await saved.path())).digest("hex")).toBe(createHash("sha256").update(PLAN).digest("hex"));
});
