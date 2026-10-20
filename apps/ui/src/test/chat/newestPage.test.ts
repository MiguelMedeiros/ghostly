import { describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { engine, MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { loadSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";

// covers: chat.paired.storage

/*
 * A page can get a chat's newest page from the engine instead of its whole history (the extension's pages: every
 * history went across as JSON to each tab opened). A page that just loaded holds a long chat's last messages only, and
 * how many it left out (`older`). The newest page puts what came in, and the chat still says it left older ones out:
 * mirrored as a whole history, the chat would forget them. When the page does not reach back past what the chat holds,
 * the page asks the engine for the whole history, once, and mirrors it when it comes.
 */

// The real sync (the setup stubs it out).
vi.unmock("@ghostly/browser/platform/sync");

const NOW = Date.now();
const N = 2_000;
const KEPT = 200;
const PAGE = 400;

const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));

/** A paired chat of N messages, as a page that just loaded finds it: its last KEPT stored, the rest left out (`older`). */
async function reloadedChat(id: string) {
  const peer = id.repeat(52);
  const linkId = `link-${id}`;
  const row = (i: number): StoredMessage => ({ linkId, id: `peer_${i}`, text: `message ${i}`, sender: "peer", timestamp: NOW - (N - i) * 1_000, via: "datalink" });
  const stored: ChatSession = {
    id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: peer, encKeyB64: "enc", createdAt: NOW - N * 2_000,
    messages: Array.from({ length: KEPT }, (_, k) => { const m = row(N - KEPT + k); return { id: m.id, text: m.text, sender: "peer", timestamp: m.timestamp }; }),
    older: N - KEPT,
  };
  localStorage.setItem(`ghostly_${id}`, JSON.stringify(stored));
  fakeEngine.update({ links: [linkView({ id: linkId, peerPubKeyZ32: peer, profile: "paired-chat/1" })] });
  const { startSessionSync } = await import("@ghostly/browser/platform/sync");
  startSessionSync();
  return { linkId, row, history: (n: number) => Array.from({ length: n }, (_, i) => row(i)) };
}

const storedCopy = (id: string) => JSON.parse(localStorage.getItem(`ghostly_${id}`)!) as ChatSession;

describe("a chat's newest page from the engine", () => {
  it("puts in what came, keeps saying how many older messages the chat left out, and asks for nothing more", async () => {
    const { linkId, history } = await reloadedChat("a");
    // Three came while no page was open: the page reaches back past the chat's last KEPT.
    fakeEngine.newestPage(linkId, history(N + 3).slice(-PAGE));
    await tick();
    expect(engine.whole(linkId)).toBe(false);
    const copy = storedCopy("a");
    expect(copy.messages[copy.messages.length - 1].text).toBe(`message ${N + 2}`);
    expect(copy.older! + copy.messages.length).toBe(N + 3);
    expect(loadSession("a")!.older).toBeGreaterThan(0);
    expect(fakeEngine.historyAsks).toEqual([]);
  });

  it("asks for the whole history once when it does not reach back past the chat's messages, and mirrors it whole", async () => {
    const { linkId, history } = await reloadedChat("b");
    // More came than the page holds: the chat's oldest stored messages are older than the page.
    const all = history(N + 300);
    fakeEngine.newestPage(linkId, all.slice(-PAGE));
    await tick();
    fakeEngine.newestPage(linkId, all.slice(-PAGE));
    await tick();
    expect(fakeEngine.historyAsks).toEqual([linkId]);

    fakeEngine.messages(linkId, all);
    await tick();
    expect(engine.whole(linkId)).toBe(true);
    const chat = loadSession("b")!;
    expect(chat.older).toBeUndefined();
    expect(chat.messages).toHaveLength(N + 300);
    expect(chat.messages[chat.messages.length - 1].text).toBe(`message ${N + 299}`);
  });

  it("is asked whole for a chat a reader holds, when its newest page comes after, and not once let go", async () => {
    const { linkId, history } = await reloadedChat("c");
    const release = engine.keepWhole(linkId);
    // Nothing to ask for yet: no list of it is here.
    expect(fakeEngine.historyAsks).toEqual([]);
    fakeEngine.newestPage(linkId, history(N).slice(-PAGE));
    await tick();
    expect(fakeEngine.historyAsks).toEqual([linkId]);
    fakeEngine.messages(linkId, history(N));
    await tick();
    release();
    // Its newest page again (a page that connects again): nobody holds it, and it reaches back, so nothing is asked.
    fakeEngine.newestPage(linkId, history(N).slice(-PAGE));
    await tick();
    expect(fakeEngine.historyAsks).toEqual([linkId]);
  });
});
