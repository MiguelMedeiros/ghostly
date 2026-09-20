import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { BIG, BIG_SHA256 } from "../../extension/test/atlas.mjs";
import { chat, connect, expect, GIF, link, say, test, type Peer } from "../support/fixtures";

async function setNickname(peer: Peer, nick: string): Promise<void> {
  await peer.page.goto("/#/settings");
  await peer.page.getByPlaceholder("Enter your nickname...").fill(nick);
  await peer.page.goto("/#/");
}

test("two people chat: through the relay first, then peer to peer", async ({ peer, relay }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await setNickname(alice, "Casper");
  await setNickname(bob, "Slimer");
  await link(alice, bob);

  await say(bob, "boo from bob");
  await expect(chat(alice).getByText("boo from bob")).toBeVisible();
  expect(relay.puts).toBeGreaterThan(0);
  const bubble = (await chat(alice).getByText("boo from bob").boundingBox())!;
  const pane = (await chat(alice).boundingBox())!;
  expect(bubble.x - pane.x, "bubbles keep their distance from the edge of the chat").toBeGreaterThanOrEqual(40);
  await expect(chat(alice).getByText("~Slimer").first()).toBeVisible();
  await expect(alice.page.getByTitle("Click to set a name")).toHaveText(/Slimer/);
  await expect(chat(alice).getByText("joined the chat").first()).toBeVisible();

  await say(alice, "boo from alice");
  await expect(chat(bob).getByText("boo from alice")).toBeVisible();

  for (const peer of [alice, bob]) await expect(peer.page.getByTestId("datalink-state").filter({ hasText: "Peer to peer" })).toBeVisible();
  const relayed = relay.puts;
  await say(bob, "boo over WebRTC");
  await expect(chat(alice).getByText("boo over WebRTC")).toBeVisible({ timeout: 10_000 });
  expect(relay.puts - relayed, "a message over the data link does not need the relay").toBeLessThan(2);
  await say(alice, "and back");
  await expect(chat(bob).getByText("and back")).toBeVisible();
  // Two ticks once the other side has it.
  await expect(chat(alice).locator(".msg-meta svg").last().locator("path")).toHaveCount(2);

  // What the DHT cannot carry fits once the data link is up.
  const long = `long ${"👻".repeat(20)} ${"x".repeat(1500)} end`;
  await say(alice, long);
  await expect(chat(bob).getByText(long)).toBeVisible();

  // The chat list shows the last message.
  await bob.page.goto("/#/");
  await expect(bob.page.getByText("Casper")).toBeVisible();
});

test("messages sent while the other side is away arrive later", async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  const url = bob.page.url();
  await bob.page.close();
  await say(alice, "are you there?");
  await say(alice, "still here");
  bob.page = await bob.context.newPage();
  await bob.page.goto(url);
  await expect(chat(bob).getByText("are you there?")).toBeVisible();
  await expect(chat(bob).getByText("still here")).toBeVisible();
});

test("emoji and GIFs", async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  await alice.page.getByTitle("Emoji").click();
  await alice.page.locator("em-emoji-picker").getByRole("searchbox").fill("ghost");
  await alice.page.locator("em-emoji-picker").getByRole("button", { name: "👻" }).first().click();
  await expect(alice.page.getByPlaceholder("Type a message")).toHaveValue("👻");
  await alice.page.getByPlaceholder("Type a message").press("Enter");
  await expect(chat(bob).getByText("👻", { exact: true })).toBeVisible();

  await alice.page.getByTitle("GIF").click();
  await alice.page.getByRole("button", { name: "Retro", exact: true }).click();
  await alice.page.getByTitle("retro ghost").click();
  const gif = bob.page.locator('img[src*="ghost.gif"]');
  await expect(gif).toBeVisible();
  expect(await gif.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
});

test("files, peer to peer, arrive intact", async ({ peer }, testInfo) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  const file = testInfo.outputPath("haunted house.bin");
  writeFileSync(file, BIG);
  await alice.page.getByTestId("file-input").setInputFiles(file);
  const bubble = bob.page.getByTestId("file-bubble").filter({ hasText: "haunted house.bin" });
  await expect(bubble.getByTestId("file-save")).toBeVisible();
  const download = bob.page.waitForEvent("download");
  await bubble.getByTestId("file-save").click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe("haunted house.bin");
  expect(createHash("sha256").update(readFileSync(await saved.path())).digest("hex")).toBe(BIG_SHA256);
  await expect(alice.page.getByTestId("file-bubble").getByTestId("file-status").filter({ hasText: "3.0 MB" })).toBeVisible();

  // Pictures show themselves.
  await bob.page.getByTestId("file-input").setInputFiles({ name: "ghost.gif", mimeType: "image/gif", buffer: GIF });
  await expect(alice.page.getByTestId("file-bubble").filter({ hasText: "ghost.gif" }).getByRole("img", { name: "ghost.gif" })).toBeVisible();
});

/** How many files this peer still holds the bytes of, straight out of its IndexedDB. */
function storedFiles(peer: Peer): Promise<number> {
  return peer.page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open("ghostly");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const count = open.result.transaction("files").objectStore("files").count();
          count.onsuccess = () => resolve(count.result);
          count.onerror = () => reject(count.error);
        };
      }),
  );
}

/** The row one message is in, delete button and all. */
const message = (peer: Peer, text: string) => chat(peer).locator(".group").filter({ hasText: text });

test("a deleted message is gone for good, and gone only here", async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  await say(bob, "forget this one");
  await expect(chat(alice).getByText("forget this one")).toBeVisible();
  await bob.page.getByTestId("file-input").setInputFiles({ name: "ghost.gif", mimeType: "image/gif", buffer: GIF });
  await expect(chat(alice).getByTestId("file-bubble").filter({ hasText: "ghost.gif" })).toBeVisible();
  expect(await storedFiles(alice)).toBe(1);

  for (const text of ["forget this one", "ghost.gif"]) {
    await message(alice, text).getByTestId("message-delete").click();
    await expect(message(alice, text).getByTestId("message-delete-menu")).toBeVisible();
    await message(alice, text).getByTestId("message-delete-confirm").click();
  }
  await expect(chat(alice).getByText("forget this one")).toHaveCount(0);
  await expect(chat(alice).getByTestId("file-bubble")).toHaveCount(0);
  // The bytes go with the message.
  await expect.poll(() => storedFiles(alice)).toBe(0);

  // Nothing was asked of the peer: it keeps what it sent.
  await expect(chat(bob).getByText("forget this one")).toBeVisible();
  await expect(chat(bob).getByTestId("file-bubble").filter({ hasText: "ghost.gif" })).toBeVisible();

  // The peer republishes what it sent for minutes after: none of it comes back.
  await alice.page.reload();
  await expect(chat(alice).getByText("hello from bob")).toBeVisible();
  await expect(chat(alice).getByText("forget this one")).toHaveCount(0);
  await expect(chat(alice).getByTestId("file-bubble")).toHaveCount(0);
  expect(await storedFiles(alice)).toBe(0);
});
