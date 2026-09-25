import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { BIG, BIG_SHA256 } from "../../extension/test/atlas.mjs";
import type { Route } from "@playwright/test";
import { chat, connect, expect, GIF, link, linkLegacy, say, test, type Peer } from "../support/fixtures";
import { openExpressions } from "../support/composer";

async function setNickname(peer: Peer, nick: string): Promise<void> {
  await peer.page.goto("/#/settings");
  await peer.page.getByPlaceholder("Enter your nickname...").fill(nick);
  await peer.page.goto("/#/");
}

test("two people chat: relay discovery, then peer-to-peer messages", { tag: ["@feature:chat.paired.pair", "@feature:chat.paired.send", "@feature:chat.paired.receipts", "@feature:chat.paired.nickname-sync", "@feature:chat.paired.status", "@feature:transport.webrtc"] }, async ({ peer, relay }) => {
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

  // A paired chat states the direct connection in the pairing banner, not in the strip.
  for (const peer of [alice, bob]) await expect(
    peer.page.getByTestId("datalink-state").filter({ hasText: "Peer to peer" })
      .or(peer.page.locator("[data-testid=connection-options][aria-label*=\"Connected · WebRTC\"]")),
  ).toBeVisible();
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

test("compatibility chat delivers through the relay while the other side is away", { tag: ["@feature:chat.legacy.send"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await linkLegacy(alice, bob);
  await connect(alice, bob);
  const url = bob.page.url();
  await bob.page.close();
  // Once Alice's side sees the direct link gone, text goes through the relay. (A legacy chat sends
  // over the data link while it looks open; what goes out in the moment before it closes is lost.)
  await expect(alice.page.getByTestId("datalink-state").filter({ hasText: "Peer to peer" })).toHaveCount(0, { timeout: 30_000 });
  await say(alice, "are you there?");
  await say(alice, "still here");
  bob.page = await bob.context.newPage();
  await bob.page.goto(url);
  await expect(chat(bob).getByText("are you there?")).toBeVisible();
  await expect(chat(bob).getByText("still here")).toBeVisible();
});

test("emoji and GIFs", { tag: ["@feature:chat.paired.emoji", "@feature:chat.paired.gifs", "@feature:chat.paired.gifs.categories"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  // One panel, emoji first: search, pick, and it goes into the message.
  const panel = await openExpressions(alice.page, "emoji");
  await panel.getByTestId("expression-search").fill("ghost");
  await panel.getByTestId("emoji-section-search").getByRole("button", { name: "👻" }).first().click();
  await expect(alice.page.getByPlaceholder("Message…")).toHaveValue("👻");
  await alice.page.getByPlaceholder("Message…").press("Enter");
  await expect(chat(bob).getByText("👻", { exact: true })).toBeVisible();

  // The switch at the bottom: GIFs, ghosts first; one click sends it and closes the panel.
  await openExpressions(alice.page, "gif");
  await expect(alice.page.getByRole("button", { name: "Giphy", exact: true })).toHaveCount(0);
  await expect(alice.page.getByTestId("gif-category-ghosts")).toHaveAttribute("aria-pressed", "true");
  await expect(alice.page.getByTitle("retro ghost")).toBeVisible();
  // Each category icon is a search of its own, and the grid changes with it.
  const perSearch = (route: Route) => {
    const q = new URL(route.request().url()).searchParams.get("q")!;
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify([1, 2].map((i) => ({ gif: `http://geocities.com/${q.replace(/\s/g, "_")}/${i}.gif`, checksum: `${q}-${i}`, url_text: `${q} ${i}` }))) });
  };
  await alice.context.route("https://gifcities.archive.org/**", perSearch);
  for (const [id, q] of [["retro", "computer"], ["yes", "thumbs up"], ["animals", "cat"]] as const) {
    await alice.page.getByTestId(`gif-category-${id}`).click();
    await expect(alice.page.getByTestId(`gif-category-${id}`)).toHaveAttribute("aria-pressed", "true");
    await expect(alice.page.getByTestId("gif-grid")).toHaveAttribute("data-query", q);
    await expect(alice.page.getByTitle(`${q} 1`)).toBeVisible();
    await expect(alice.page.getByTestId("gif-result")).toHaveCount(2);
    await expect(alice.page.getByTitle("retro ghost")).toHaveCount(0);
  }
  await alice.context.unroute("https://gifcities.archive.org/**", perSearch);
  // Back to the ghosts, seen already: at once.
  await alice.page.getByTestId("gif-category-ghosts").click();
  await alice.page.getByTitle("retro ghost").click();
  await expect(alice.page.getByTestId("expression-panel")).toHaveCount(0);
  const gif = bob.page.locator('img[src*="ghost.gif"]');
  await expect(gif).toBeVisible();
  expect(await gif.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);

  // A phone: the same panel is a sheet, and it opens on GIFs, the segment used last.
  await alice.page.setViewportSize({width:390,height:844});
  await alice.page.getByTestId("composer-expressions").click();
  const sheet = alice.page.getByTestId("expression-panel");
  await expect(sheet).toHaveAttribute("data-tab", "gif");
  await expect(sheet).toHaveClass(/\bsheet\b/);
  await expect(alice.page.getByText("GifCities · Internet Archive")).toBeVisible();
  await alice.page.getByPlaceholder("Search GIFs").fill("ghost");
  await expect(alice.page.getByTitle("retro ghost")).toBeVisible();
  await alice.page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await alice.page.getByTestId("composer-expressions").click();
  await alice.page.locator(".sheet-backdrop").click({position:{x:10,y:10}});
  await expect(sheet).toHaveCount(0);
  await alice.context.route("https://gifcities.archive.org/**",route=>route.fulfill({status:503,body:"Unavailable"}));
  await alice.page.getByTestId("composer-expressions").click();
  await expect(alice.page.getByText("GIF search is unavailable.")).toBeVisible();
  await alice.page.keyboard.press("Escape");
});

test("files, peer to peer, arrive intact", { tag: ["@feature:files.paired.send", "@feature:files.paired.images"] }, async ({ peer }, testInfo) => {
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

test("a deleted message is gone for good, and gone only here", { tag: ["@feature:chat.paired.delete-message"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  await say(bob, "forget this one");
  await expect(chat(alice).getByText("forget this one")).toBeVisible();
  await bob.page.getByTestId("file-input").setInputFiles({ name: "ghost.gif", mimeType: "image/gif", buffer: GIF });
  await expect(chat(alice).getByTestId("file-bubble").filter({ hasText: "ghost.gif" })).toBeVisible();
  expect(await storedFiles(alice)).toBe(1);

  for (const text of ["forget this one", "ghost.gif"]) {
    await message(alice, text).getByTestId("message-options").click();
    await alice.page.getByTestId("message-delete").click();
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
