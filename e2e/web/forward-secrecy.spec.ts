import { copyInvite, pasteInvite } from "../support/clipboard";
import { test, expect, chat, chooseDhtOnly, delivered, say, type Peer } from "../support/fixtures";
import type { LocalRelay } from "../support/relay";
import { parseRelayPayload } from "@ghostly/core";
import { linkTrace, watchLink } from "../support/callTrace";
import { writeFileSync } from "node:fs";

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
  for (const p of [a, b]) await watchLink({ kind: "web", page: p.page } as never);
  await pairOnDht(a, b);
  try { await exchange(a, b, ["hello, with fresh keys 👻", "and back", "and once more"]); }
  catch (error) {
    writeFileSync(`/tmp/fs-trace-${Date.now()}.txt`, `A\n${await linkTrace({ kind: "web", page: a.page } as never)}\nB\n${await linkTrace({ kind: "web", page: b.page } as never)}`);
    throw error;
  }
  // Every mailbox holds a ratcheted envelope now; none of either side is plain after the pin.
  await expect.poll(() => sealed(relay).ratcheted).toBeGreaterThanOrEqual(2);
  expect(sealed(relay).plain).toBe(0);
  expect([...relay.packets.values()].every(packet => !packet.includes(Buffer.from("fresh keys")))).toBe(true);
  await expect.poll(() => forwardSecrecy(a), { timeout: 30_000 }).toBe("on");
  await expect.poll(() => forwardSecrecy(b), { timeout: 30_000 }).toBe("on");
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

test("a reader back after envelopes it never saw steps over their keys and opens the newest, once", { tag: ["@feature:chat.ratchet", "@feature:chat.dht.offline"] }, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const a = await peer("fs-writer"), b = await peer("fs-away");
  await pairOnDht(a, b);
  await exchange(a, b, ["before", "the turn passes"]);
  const returnTo = b.page.url();
  await b.page.goto("about:blank");
  // The text goes out at once and again after 4, 8 and 16 s: each a new envelope, a new key, replacing the last.
  await say(a, "while you were away");
  await a.page.waitForTimeout(20_000);
  await b.page.goto(returnTo);
  await expect(chat(b).getByText("while you were away", { exact: true })).toHaveCount(1, { timeout: 60_000 });
  await expect(delivered(chat(a)).last()).toBeVisible({ timeout: 60_000 });
  await say(b, "got it");
  await expect(chat(a).getByText("got it", { exact: true })).toBeVisible({ timeout: 60_000 });
});
