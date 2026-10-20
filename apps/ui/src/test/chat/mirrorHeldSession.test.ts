import { describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { loadSession, saveSession } from "../../lib/storage";
import { fakeEngine, linkView } from "../fakeEngine";

// covers: chat.paired.storage

/*
 * A message arriving in an open chat was added to its session by reading the session again (a parse of its stored copy
 * and a merge with the thousands of messages it leaves out), right after the mirror had read it to find the message
 * new. The mirror hands the session it holds: the chat is read once per arrival, by the sync, not twice.
 */

// The real sync (the setup stubs it out).
vi.unmock("@ghostly/browser/platform/sync");

const NOW = Date.now();
const N = 1_000;

const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));

describe("a message arriving in a long open chat", () => {
  it("is added to the session the mirror holds, without reading the chat again", async () => {
    const peer = "h".repeat(52);
    const linkId = "link-h";
    const row = (i: number, patch: Partial<StoredMessage> = {}): StoredMessage =>
      ({ linkId, id: `peer_${i}`, text: `message ${i}`, sender: "peer", timestamp: NOW - (N - i) * 1_000, ...patch }) as StoredMessage;
    saveSession({ id: "h", profile: "paired-chat/1", mySeedB64: "seed-h", peerPubKeyB64: peer, encKeyB64: "enc", messages: [], createdAt: NOW - N * 2_000 });
    fakeEngine.update({ links: [linkView({ id: linkId, peerPubKeyZ32: peer, profile: "paired-chat/1" })] });
    const { startSessionSync } = await import("@ghostly/browser/platform/sync");
    startSessionSync();
    fakeEngine.messages(linkId, Array.from({ length: N }, (_, i) => row(i)));
    await tick();

    // Each read of the chat's stored copy, from here on.
    const parse = JSON.parse;
    let reads = 0;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      if (typeof text === "string" && text.includes('"mySeedB64":"seed-h"')) reads++;
      return parse(text, reviver);
    });
    try {
      for (let i = 0; i < 3; i++) {
        fakeEngine.emit({ kind: "message-changes", linkId, messages: [row(N + i, { timestamp: NOW + i })], deleted: [] });
        await tick();
      }
    } finally {
      spy.mockRestore();
    }
    // Once per arrival: the sync's own read of the chats (its reconcile, on `session-updated`), which the next mirror reuses.
    expect(reads).toBe(3);
    const session = loadSession("h")!;
    expect(session.messages).toHaveLength(N + 3);
    expect(session.messages.slice(-3).map((m) => m.text)).toEqual([`message ${N}`, `message ${N + 1}`, `message ${N + 2}`]);
  });
});
