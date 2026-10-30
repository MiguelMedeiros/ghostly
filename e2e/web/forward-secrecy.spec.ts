import { copyInvite, pasteInvite } from "../support/clipboard";
import { test, expect, chat, chooseDhtOnly, delivered, say, type Peer } from "../support/fixtures";
import type { LocalRelay } from "../support/relay";
import { parseRelayPayload } from "@ghostly/core";

/**
 * Forward secrecy for a chat's stored paths (WISP 4xx, `ratchet/1`), in a DHT-only chat so every text goes on the floor:
 * two apps that have it seal their envelopes with the ratchet (`_dr` records) and say On in Tech Info; an app from before
 * (played with `ghostly-test-no-ratchet`) gets plain envelopes (`_dm`), both ways, as today; and a reader back after
 * envelopes it never saw (each retry of a text takes a key of its own) steps over them and opens the newest.
 */

const NO_RATCHET = () => localStorage.setItem("ghostly-test-no-ratchet", "1");

/** An app from before forward secrecy: no ratchet/1 in its record, no ratchet, from its first start. */
async function olderApp(peer: Peer) {
  await peer.page.addInitScript(NO_RATCHET);
  await peer.page.evaluate(NO_RATCHET);
  await peer.page.reload();
}

async function pairOnDht(a: Peer, b: Peer) {
  await a.page.getByTitle("New Chat").click();
  await chooseDhtOnly(a.page);
  await expect.poll(() => copyInvite(a.page)).toMatch(/^https:\/\/ghostly\.tools\/#ghostly1/);
  const invite = await copyInvite(a.page);
  await b.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
  await pasteInvite(b.page, invite);
  for (const p of [a, b]) await expect(p.page.getByPlaceholder("Message…")).toBeEnabled();
}

/** How many of the relay's packets carry a ratcheted envelope (`_dr`) and a plain one after the pin (`_dm` with `_dmk`). */
function sealed(relay: LocalRelay) {
  const labels = [...relay.packets.entries()].map(([key, packet]) => {
    try { return parseRelayPayload(key, new Uint8Array(packet)).records.map(r => r.label); } catch { return []; }
  });
  return { ratcheted: labels.filter(l => l.includes("_dr")).length, plain: labels.filter(l => l.includes("_dm") && l.includes("_dmk")).length };
}

/** The Forward secrecy row of the chat's Tech Info: its state (on, starting, unsupported, stopped). */
async function forwardSecrecy(peer: Peer): Promise<string | null> {
  await peer.page.getByTestId("chat-options").click();
  await peer.page.getByTestId("chat-tech-info").click();
  const row = peer.page.getByTestId("tech-forward-secrecy");
  await expect(row).toBeVisible();
  const state = await row.getAttribute("data-state");
  await peer.page.keyboard.press("Escape");
  await expect(row).toHaveCount(0);
  return state;
}

/**
 * Writes back and forth until both say On (WISP 4xx: on once the turn has passed both ways in the session both settled
 * on, which takes a few texts and can take a few more when both started a session at once), at most `rounds` times.
 */
async function untilOn(a: Peer, b: Peer, rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    if ((await forwardSecrecy(a)) === "on" && (await forwardSecrecy(b)) === "on") return;
    await exchange(a, b, [`turn ${i}`, `turn ${i} back`]);
  }
  expect(await forwardSecrecy(a)).toBe("on");
  expect(await forwardSecrecy(b)).toBe("on");
}

async function exchange(a: Peer, b: Peer, texts: string[]) {
  for (const [i, text] of texts.entries()) {
    const [from, to] = i % 2 ? [b, a] : [a, b];
    await say(from, text);
    await expect(chat(to).getByText(text, { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(delivered(chat(from)).last()).toBeVisible({ timeout: 60_000 });
  }
}

test("two apps with ratchet/1 seal the DHT floor with keys used once, and say Forward secrecy On", { tag: ["@feature:chat.ratchet", "@feature:chat.ratchet.ui", "@feature:chat.dht.send"] }, async ({ peer, relay }) => {
  test.setTimeout(4 * 60_000);
  const a = await peer("fs-first"), b = await peer("fs-second");
  await pairOnDht(a, b);
  // Four turns: whichever side starts, each has then stepped on a key of the other's with one of its own.
  await exchange(a, b, ["hello, with fresh keys 👻", "and back", "and once more", "and back again"]);
  // Both mailboxes in use hold a ratcheted envelope now (the invite's, left behind once both moved, keep their last plain one).
  await expect.poll(() => sealed(relay).ratcheted).toBeGreaterThanOrEqual(2);
  await untilOn(a, b);
});

test("an app without it gets plain envelopes both ways, and Tech Info says the contact's app does not support it", { tag: ["@feature:chat.ratchet", "@feature:chat.ratchet.ui", "@feature:chat.dht.send"] }, async ({ peer, relay }) => {
  test.setTimeout(4 * 60_000);
  const a = await peer("fs-new"), b = await peer("fs-old");
  await olderApp(b);
  await pairOnDht(a, b);
  await exchange(a, b, ["to an older app", "from an older app", "still plain"]);
  expect(sealed(relay).ratcheted).toBe(0);
  expect(sealed(relay).plain).toBeGreaterThanOrEqual(2);
  await expect.poll(() => forwardSecrecy(a), { timeout: 30_000 }).toBe("unsupported");
});

/** The ratcheted envelopes in the relay's packets now: the base64 of each `_dr` record. */
function ratchetedRecords(relay: LocalRelay): string[] {
  return [...relay.packets.entries()].flatMap(([key, packet]) => {
    try { return parseRelayPayload(key, new Uint8Array(packet)).records.filter(r => r.label === "_dr").map(r => r.value); } catch { return []; }
  });
}

test("a reader back after envelopes it never saw steps over their keys and opens the newest, once", { tag: ["@feature:chat.ratchet", "@feature:chat.dht.offline"] }, async ({ peer, relay }) => {
  test.setTimeout(4 * 60_000);
  const a = await peer("fs-writer"), b = await peer("fs-away");
  await pairOnDht(a, b);
  await exchange(a, b, ["before", "the turn passes"]);
  await expect.poll(() => ratchetedRecords(relay).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  const returnTo = b.page.url();
  await b.page.goto("about:blank");
  // The text goes out at once and again after a few seconds, twice or more while b is away: each a new envelope sealed
  // with a new key, replacing the last in a's mailbox, so b never sees the ones between.
  const before = new Set(ratchetedRecords(relay));
  const seen = new Set<string>();
  await say(a, "while you were away");
  await expect.poll(() => { for (const r of ratchetedRecords(relay)) if (!before.has(r)) seen.add(r); return seen.size; }, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await b.page.goto(returnTo);
  await expect(chat(b).getByText("while you were away", { exact: true })).toHaveCount(1, { timeout: 60_000 });
  await expect(delivered(chat(a)).last()).toBeVisible({ timeout: 60_000 });
  await say(b, "got it");
  await expect(chat(a).getByText("got it", { exact: true })).toBeVisible({ timeout: 60_000 });
});

test("a chat that started with an older app goes forward secret once that app is updated", { tag: ["@feature:chat.ratchet", "@feature:chat.ratchet.ui"] }, async ({ peer, relay }) => {
  test.setTimeout(5 * 60_000);
  const a = await peer("fs-stays"), b = await peer("fs-updates");
  // b plays an app from before until it is "updated" (the flag below), on every load.
  const OLD_UNTIL_UPDATED = () => {
    if (localStorage.getItem("qa-updated") === "1") localStorage.removeItem("ghostly-test-no-ratchet");
    else localStorage.setItem("ghostly-test-no-ratchet", "1");
  };
  await b.page.addInitScript(OLD_UNTIL_UPDATED);
  await b.page.evaluate(OLD_UNTIL_UPDATED);
  await b.page.reload();
  await pairOnDht(a, b);
  await exchange(a, b, ["plain at first", "from the older app"]);
  expect(sealed(relay).ratcheted).toBe(0);
  await expect.poll(() => forwardSecrecy(a), { timeout: 30_000 }).toBe("unsupported");
  // The update: the same chat, the same keys, an app that now says ratchet/1.
  await b.page.evaluate(() => localStorage.setItem("qa-updated", "1"));
  await b.page.reload();
  await expect(b.page.getByPlaceholder("Message…")).toBeEnabled();
  await exchange(a, b, ["after the update", "now with fresh keys", "once more", "and back"]);
  await expect.poll(() => sealed(relay).ratcheted, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
  await untilOn(a, b);
  for (const p of [a, b]) await expect(chat(p).getByText("plain at first", { exact: true })).toHaveCount(1);
});
