import { describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { loadSession, saveSession, setEngineMessages } from "../../lib/storage";
import { fakeEngine, linkView } from "../fakeEngine";

// covers: chat.paired.storage

/*
 * A message arriving in an open chat was mirrored into its session twice: once by the engine's state (sent right after
 * the row), and again when the page's change tick told the same list. In a 5,000-message chat each pass is a walk over
 * the whole history and a save with nothing to write: 2-3x the main-thread time of a short chat per arrival. A list is
 * mirrored once, and a pass that changes nothing writes nothing.
 */

// The real sync (the setup stubs it out); its writes counted.
vi.unmock("@ghostly/browser/platform/sync");
vi.mock("../../lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/storage")>();
  return { ...actual, saveSession: vi.fn(actual.saveSession), setEngineMessages: vi.fn(actual.setEngineMessages) };
});

const NOW = Date.now();
const N = 1_000;

const passes = () => vi.mocked(setEngineMessages).mock.calls.length;
const saves = () => vi.mocked(saveSession).mock.calls.length;
const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));

/** A paired chat of N messages, open: its session, its link, and the engine's whole history mirrored once. */
async function longChat(id: string) {
  const peer = id.repeat(52);
  const linkId = `link-${id}`;
  const row = (i: number, patch: Partial<StoredMessage> = {}): StoredMessage =>
    ({ linkId, id: `peer_${i}`, text: `message ${i}`, sender: "peer", timestamp: NOW - (N - i) * 1_000, ...patch }) as StoredMessage;
  saveSession({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: peer, encKeyB64: "enc", messages: [], createdAt: NOW - N * 2_000 });
  fakeEngine.update({ links: [linkView({ id: linkId, peerPubKeyZ32: peer, profile: "paired-chat/1" })] });
  const { startSessionSync } = await import("@ghostly/browser/platform/sync");
  startSessionSync();
  fakeEngine.messages(linkId, Array.from({ length: N }, (_, i) => row(i)));
  await tick();
  expect(loadSession(id)!.messages).toHaveLength(N);
  return { linkId, row };
}

describe("a message arriving in an open chat", () => {
  it("is mirrored into its session once, when the engine's state lands before the page's change tick", async () => {
    const { linkId, row } = await longChat("a");
    for (let i = 0; i < 3; i++) {
      const before = passes();
      // The engine sends the row, then its state (the link's last message moved) within the tick.
      fakeEngine.emit({ kind: "message-changes", linkId, messages: [row(N + i, { timestamp: NOW + i })], deleted: [] });
      fakeEngine.update({});
      await tick();
      expect(passes() - before).toBe(1);
    }
    expect(loadSession("a")!.messages.map((m) => m.text).slice(-3)).toEqual([`message ${N}`, `message ${N + 1}`, `message ${N + 2}`]);
  });

  it("a change the mirror has nothing to write for saves nothing", async () => {
    const { linkId, row } = await longChat("b");
    const before = saves();
    // One of mine the chat itself put in its session (the engine's copy has no delivery): nothing to mirror.
    fakeEngine.emit({ kind: "message-changes", linkId, messages: [row(N, { id: "me_1", sender: "me", timestamp: NOW })], deleted: [] });
    await tick();
    expect(saves() - before).toBe(0);
  });
});
