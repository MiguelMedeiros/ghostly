import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { BIG, BIG_SHA256 } from "../../apps/extension/test/atlas.mjs";
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
  // Bob's nickname came over: over his messages, plain, as the header names him (a "~" marks a member's own name in a group).
  await expect(chat(alice).getByTestId("message-nick").first()).toHaveText("Slimer");
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

  // What the DHT cannot carry fits once the data link is up. Words, not one unbroken run: a run of 80+ key-like
  // characters folds to one line with Show all (the blob in apps/ui/src/lib/parse/blob.ts), and its text is split there.
  const long = `long ${"👻".repeat(20)} ${"boo ".repeat(375)}end`;
  await say(alice, long);
  await expect(chat(bob).getByText(long)).toBeVisible();

  // The chat list shows the last message.
  await bob.page.goto("/#/");
  await expect(bob.page.getByText("Casper")).toBeVisible();
});

/**
 * Lets a test move a page's clock: `Date.now()` and `new Date()` read `window.clockOffset` ms ahead (or behind), 0
 * until the test sets it. The engine runs in the page, so from then on the peer dates everything it sends by that
 * clock, as a device whose clock is wrong does. Timers are left alone: nothing waits longer or shorter.
 */
function movableClock(): void {
  const Real = Date;
  const offset = () => (globalThis as { clockOffset?: number }).clockOffset ?? 0;
  class Shifted extends Real {
    constructor(...args: unknown[]) {
      if (args.length) super(...(args as [number]));
      else super(Real.now() + offset());
    }
    static now(): number { return Real.now() + offset(); }
  }
  (globalThis as { Date: DateConstructor }).Date = Shifted as unknown as DateConstructor;
}

test("a contact whose clock is two minutes ahead: the conversation reads in the order it happened", { tag: ["@feature:chat.order"] }, async ({ peer }) => {
  // Reported 2026-10-01: the contact's messages said "11:23 PM" at 11:21, and my replies were placed above them.
  const AHEAD = 2 * 60_000;
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob", { beforeOpen: async (context) => { await context.addInitScript(movableClock); } })]);
  await link(alice, bob);
  await connect(alice, bob);
  // Paired and live: from here Bob's clock runs two minutes ahead of Alice's. (A first pairing between clocks that
  // far apart is another matter: records dated ahead are refused.)
  await bob.page.evaluate((offset) => { (globalThis as { clockOffset?: number }).clockOffset = offset; }, AHEAD);
  expect(await bob.page.evaluate(() => Date.now()) - await alice.page.evaluate(() => Date.now())).toBeGreaterThan(AHEAD - 5_000);

  const talk = ["bob one", "alice answers one", "bob two", "bob three", "alice answers two", "bob four"];
  for (const line of talk) {
    const [from, to] = line.startsWith("bob") ? [bob, alice] : [alice, bob];
    await say(from, line);
    await expect(chat(to).getByText(line, { exact: true })).toBeVisible();
  }

  // What each side reads: the lines in the order they were said, on Alice's side (her contact's clock is ahead) and
  // on Bob's (his contact's clock is behind).
  const said = async (reader: typeof alice) => (await chat(reader).getByTestId("message-text").allTextContents()).filter((text) => talk.includes(text));
  // No bubble shows a time that has not come yet, by the reader's own clock.
  const latestShown = (reader: typeof alice) => chat(reader).getByTestId("message-time").evaluateAll((els) => Math.max(...els.map((el) => Number(el.getAttribute("data-at")))) - Date.now());
  for (const reader of [alice, bob]) {
    expect(await said(reader), `${reader.name} reads the conversation in order`).toEqual(talk);
    expect(await latestShown(reader), `${reader.name} sees no time in the future`).toBeLessThanOrEqual(0);
  }

  // Bob's lines show the time Alice got them, not his clock's two minutes later.
  const bobFour = chat(alice).locator("[data-message-row]").filter({ hasText: "bob four" }).getByTestId("message-time");
  expect(await bobFour.evaluate((el) => Date.now() - Number(el.getAttribute("data-at")))).toBeLessThan(60_000);

  // The same order after a reload, from what each side stored.
  for (const reader of [alice, bob]) {
    await reader.page.reload();
    await expect(chat(reader).getByText("bob four", { exact: true })).toBeVisible();
    expect(await said(reader), `${reader.name} reads the stored conversation in order`).toEqual(talk);
  }
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
  // The ghosts are kept for the app session; a search not seen yet asks, and hears nothing.
  await expect(alice.page.getByTitle("retro ghost")).toBeVisible();
  await alice.page.getByPlaceholder("Search GIFs").fill("banshee");
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

  // + → Document takes several files at once, and each goes as its own message. None of them reads as gone on its way
  // in: a file shown before its transfer said "No longer available" until it was all here (bug hunt r10).
  await bob.page.evaluate(() => {
    const seen: string[] = ((window as unknown as { goneSeen: string[] }).goneSeen = []);
    new MutationObserver(() => {
      for (const status of document.querySelectorAll("[data-testid=file-status]")) if (status.textContent === "No longer available") seen.push(status.closest("[data-testid=file-bubble]")?.textContent ?? "");
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  const several = [
    { name: "attic map.txt", mimeType: "text/plain", buffer: Buffer.from("the attic, at midnight") },
    { name: "cellar plan.csv", mimeType: "text/csv", buffer: Buffer.from("cellar,stairs\n") },
    { name: "stairs.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(300_000, 7) },
    { name: "hall.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(600_000, 9) },
  ];
  await alice.page.getByTestId("file-input").setInputFiles(several);
  for (const { name } of several) await expect(bob.page.getByTestId("file-bubble").filter({ hasText: name }).getByTestId("file-save")).toBeVisible();
  expect(await bob.page.evaluate(() => (window as unknown as { goneSeen: string[] }).goneSeen)).toEqual([]);
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
    // Drawn over the page, not inside the message's row (the list would cut it off).
    await expect(alice.page.getByTestId("message-delete-menu")).toBeVisible();
    await alice.page.getByTestId("message-delete-confirm").click();
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
