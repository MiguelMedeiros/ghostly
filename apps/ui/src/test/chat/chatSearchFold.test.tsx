import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { SEARCH_DEBOUNCE_MS } from "../../hooks/useChatSearch";
import { saveSession } from "../../lib/storage";
import { Chat } from "../../pages/Chat";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.search

/*
 * A search open in a chat reads that chat's messages folded (case and accents off). The chat changes all the time while
 * it is open: a message comes, one of mine is delivered or read, a reaction. Each change folded every message of the chat
 * again: 140 ms of one task for 5,000 messages of 2 KB, half a second for 2,000 of an agent's long answers. A text is
 * folded once while the search stays open; a new or edited one is folded as it comes. Counted by `foldText`'s calls.
 */

const counts = vi.hoisted(() => ({ fold: 0 }));

vi.mock("@ghostly/browser/shared/fold", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ghostly/browser/shared/fold")>();
  return { ...actual, foldText: (text: string) => { counts.fold++; return actual.foldText(text); } };
});

// The real sync (the setup stubs it out): messages come from the engine's history as they do in the app.
vi.unmock("@ghostly/browser/platform/sync");
vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const PEER = "peer".padEnd(52, "p");
const LINK = "link-1";
const NOW = Date.now();
const N = 150;
const row = (i: number, text = `message ${i}`): StoredMessage => ({ linkId: LINK, id: `peer_${i}`, text, sender: "peer", timestamp: NOW - (N - i) * 1_000 }) as StoredMessage;
const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
const tick = () => wait(MESSAGE_CHANGES_TICK_MS * 2);

async function searchChat(term: string) {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: NOW - N * 2_000 });
  const { engine, user } = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />, { route: "/chat/chat-1" });
  engine.on("ensureLink", () => ({ linkId: LINK })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
  act(() => engine.update({ links: [linkView({ id: LINK, peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as Partial<LinkView> as never)] }));
  engine.messages(LINK, Array.from({ length: N }, (_, i) => row(i, i % 50 ? `message ${i}` : `Café ${i}`)));
  await tick();
  await screen.findAllByText(`message ${N - 1}`);
  await user.keyboard("{Control>}f{/Control}");
  await user.type(await screen.findByTestId("chat-search-input"), term);
  await wait(SEARCH_DEBOUNCE_MS * 2);
  return engine;
}

describe("a search open in a chat as the chat changes", () => {
  it("folds only the message that came, not the chat again", async () => {
    const engine = await searchChat("cafe");
    expect(screen.getByTestId("chat-search-count")).toHaveTextContent("1 of 3");

    counts.fold = 0;
    for (let i = 0; i < 5; i++) {
      engine.emit({ kind: "message-changes", linkId: LINK, messages: [{ ...row(N + i), timestamp: NOW + i + 1 }], deleted: [] });
      await tick();
    }
    await screen.findAllByText(`message ${N + 4}`);
    // The five that came, and the words searched for: none of the 150 already there.
    expect(counts.fold).toBeLessThan(5 * 10);
    expect(counts.fold).toBeGreaterThan(0);
  });

  it("still finds a message that came, or was edited, while it was open", async () => {
    const engine = await searchChat("cafe");
    expect(screen.getByTestId("chat-search-count")).toHaveTextContent("1 of 3");

    engine.emit({ kind: "message-changes", linkId: LINK, messages: [{ ...row(N, "See you at the CAFÉ"), timestamp: NOW + 1 }], deleted: [] });
    await tick();
    expect(screen.getByTestId("chat-search-count")).toHaveTextContent("of 4");

    // An edit: the new words are found, the old ones no longer.
    engine.emit({ kind: "message-changes", linkId: LINK, messages: [{ ...row(100, "a tea instead"), edit: { seq: 1, at: NOW + 2, history: [] } } as StoredMessage], deleted: [] });
    await tick();
    await screen.findByText("a tea instead");
    expect(screen.getByTestId("chat-search-count")).toHaveTextContent("of 3");
  });
});
