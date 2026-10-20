import { describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { loadSession, saveSession } from "../../lib/storage";
import { fakeEngine, linkView } from "../fakeEngine";

// covers: chat.paired.storage

/*
 * A message arriving in an open chat of thousands was mirrored into its session by a walk over the whole history: a
 * lookup, a reactions compare and a check per row, and the ids of every row collected again, for one row. The page's
 * change tick tells what changed since the list the mirror last went through: only those rows are looked at.
 */

// The real sync (the setup stubs it out).
vi.unmock("@ghostly/browser/platform/sync");

const NOW = Date.now();
const N = 1_000;

const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));

/** A paired chat of N messages, open, its whole history mirrored once; `reads` counts what reads its rows since. */
async function longChat(id: string) {
  const peer = id.repeat(52);
  const linkId = `link-${id}`;
  let reads = 0;
  const row = (i: number, patch: Partial<StoredMessage> = {}): StoredMessage =>
    ({ linkId, id: `peer_${i}`, text: `message ${i}`, sender: "peer", timestamp: NOW - (N - i) * 1_000, ...patch }) as StoredMessage;
  // Rows of the history that count each look at who sent them: every pass over a row reads that.
  const counted = (i: number): StoredMessage => {
    const { sender, ...rest } = row(i);
    return Object.defineProperty(rest, "sender", { enumerable: true, get: () => (reads++, sender) }) as StoredMessage;
  };
  saveSession({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: peer, encKeyB64: "enc", messages: [], createdAt: NOW - N * 2_000 });
  fakeEngine.update({ links: [linkView({ id: linkId, peerPubKeyZ32: peer, profile: "paired-chat/1" })] });
  const { startSessionSync } = await import("@ghostly/browser/platform/sync");
  startSessionSync();
  fakeEngine.messages(linkId, Array.from({ length: N }, (_, i) => counted(i)));
  await tick();
  expect(loadSession(id)!.messages).toHaveLength(N);
  reads = 0;
  return { linkId, peer, row, reads: () => reads };
}

/** What happens to chat `id`'s session from now on: its stored text written, parsed, and the page told to read it again. */
function watchSession(id: string) {
  const isChat = (text: unknown) => typeof text === "string" && text.startsWith(`{"id":"${id}"`);
  const parse = vi.spyOn(JSON, "parse");
  const write = vi.spyOn(localStorage, "setItem");
  let told = 0;
  const tell = () => told++;
  window.addEventListener("session-updated", tell);
  return {
    count: () => ({
      writes: write.mock.calls.filter(([, value]) => isChat(value)).length,
      parses: parse.mock.calls.filter(([text]) => isChat(text)).length,
      told,
    }),
    stop: () => { parse.mockRestore(); write.mockRestore(); window.removeEventListener("session-updated", tell); },
  };
}

describe("a message arriving in a long open chat", () => {
  it("is mirrored from that row alone, not from a walk over the history", async () => {
    const { linkId, row, reads } = await longChat("a");
    for (let i = 0; i < 3; i++) {
      fakeEngine.emit({ kind: "message-changes", linkId, messages: [row(N + i, { timestamp: NOW + i })], deleted: [] });
      // The engine's state too (the link's last message moved), before the tick ends.
      fakeEngine.update({});
      await tick();
    }
    expect(reads()).toBe(0);
    expect(loadSession("a")!.messages.map((m) => m.text).slice(-3)).toEqual([`message ${N}`, `message ${N + 1}`, `message ${N + 2}`]);
    expect(loadSession("a")!.messages).toHaveLength(N + 3);
  });

  it("a reaction to an old message, told with it, reaches the session's row", async () => {
    const { linkId, row, reads } = await longChat("b");
    const reactions = { peer: { e: "👍", n: 1, at: NOW } };
    fakeEngine.emit({ kind: "message-changes", linkId, messages: [row(10, { reactions })], deleted: [] });
    await tick();
    expect(reads()).toBe(0);
    const session = loadSession("b")!;
    expect(session.messages).toHaveLength(N);
    expect(session.messages[10]).toMatchObject({ id: "peer_10", reactions });
    expect(session.messages[11].reactions).toBeUndefined();
  });
});

describe("a reaction arriving in a long open chat", () => {
  const reactions = { peer: { e: "👍", n: 1, at: NOW } };
  const note = { at: NOW, by: "peer", emoji: "👍", snippet: "message 990", mine: false };

  it("costs what an edit does: the row and the chat list's note in one write, no walk over the history", async () => {
    const { linkId, peer, row, reads } = await longChat("c");
    const watch = watchSession("c");
    fakeEngine.emit({ kind: "message-changes", linkId, messages: [row(990, { reactions })], deleted: [] });
    // The engine's state with the chat's note, before the tick ends.
    fakeEngine.update({ links: [linkView({ id: linkId, peerPubKeyZ32: peer, profile: "paired-chat/1", lastReaction: note })] });
    await tick();
    fakeEngine.update({});
    await tick();
    const cost = watch.count();
    watch.stop();
    expect(reads()).toBe(0);
    expect(cost).toEqual({ writes: 1, parses: 1, told: 1 });
    const session = loadSession("c")!;
    expect(session.lastReaction).toEqual(note);
    expect(session.messages[990]).toMatchObject({ id: "peer_990", reactions });
  });

  it("its note, told after the row was mirrored, is written once and leaves the history mirrored", async () => {
    const { linkId, peer, row, reads } = await longChat("d");
    const watch = watchSession("d");
    fakeEngine.emit({ kind: "message-changes", linkId, messages: [row(990, { reactions })], deleted: [] });
    await tick();
    fakeEngine.update({ links: [linkView({ id: linkId, peerPubKeyZ32: peer, profile: "paired-chat/1", lastReaction: note })] });
    await tick();
    fakeEngine.update({});
    await tick();
    const cost = watch.count();
    watch.stop();
    expect(reads()).toBe(0);
    expect(cost).toEqual({ writes: 2, parses: 2, told: 2 });
    expect(loadSession("d")!.lastReaction).toEqual(note);
  });
});
