import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { Chat } from "../../pages/Chat";
import { loadSession, saveSession, setStorageProfile as setProfile } from "../../lib/storage";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.delete-message

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/*
 * Delete for everyone of a message of mine in a long 1:1 chat. The engine tells the page the row went before it answers,
 * but the page hears it at the end of its change tick: the chat deleted the row from its session first, and that write
 * had the mirror's tick walk the whole history and save the chat again. The removal is mirrored when the engine answers,
 * from what changed only: the chat is saved once, and the delete after it finds the row gone.
 */

// The real sync (the setup stubs it out).
vi.unmock("@ghostly/browser/platform/sync");

const NOW = 1_700_000_000_000;
const N = 1_000;
const PEER = "l".repeat(52);
const LINK = "link-l";

const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));

afterEach(() => { localStorage.clear(); setProfile(""); });

it("in a long chat, the removal is saved once: no second write of the chat, nor a whole pass after it", async () => {
  const row = (i: number): StoredMessage => ({ linkId: LINK, id: `peer_${i}`, text: `message ${i}`, sender: "peer", timestamp: NOW + i * 1_000 }) as StoredMessage;
  const mine = { linkId: LINK, id: "me_w1", ref: "w1", text: "wrong chat", sender: "me", timestamp: NOW + N * 1_000, delivery: "delivered", via: "datalink" } as StoredMessage;
  saveSession({ id: "chat-l", profile: "paired-chat/1", mySeedB64: "seed-l", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [], createdAt: NOW - 1_000 });
  fakeEngine.update({ links: [linkView({ id: LINK, peerPubKeyZ32: PEER, profile: "paired-chat/1", dataLink: "open" } as never)] });
  const { startSessionSync } = await import("@ghostly/browser/platform/sync");
  startSessionSync();
  fakeEngine.messages(LINK, [...Array.from({ length: N }, (_, i) => row(i)), mine]);
  await tick();
  expect(loadSession("chat-l")!.messages).toHaveLength(N + 1);

  const { user, engine } = renderApp(<Chat sessionId="chat-l" visible onCallChange={() => {}} callLayer={null} />);
  // As the engine does (engine/node.ts removeMessage): the row's change is told, then the call answered.
  engine.on("removeMessage", ({ messageId }) => {
    engine.emit({ kind: "message-changes", linkId: LINK, messages: [], deleted: [messageId] });
    return { error: null };
  });
  const bubble = (await screen.findByText("wrong chat")).closest<HTMLElement>("[data-message-id]")!;
  await user.click(within(bubble).getByTestId("message-options"));
  await user.click(screen.getByTestId("message-delete-everyone"));

  // Each time the chat is turned into its stored text (a save, written or not), from the confirm on.
  const stringify = JSON.stringify;
  let saves = 0;
  const spy = vi.spyOn(JSON, "stringify").mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
    const text = stringify(...args);
    if (typeof text === "string" && text.includes('"mySeedB64":"seed-l"')) saves++;
    return text;
  });
  try {
    await user.click(screen.getByTestId("message-delete-confirm"));
    await waitFor(() => expect(screen.queryByText("wrong chat")).not.toBeInTheDocument());
    await tick();
  } finally {
    spy.mockRestore();
  }
  expect(engine.callsTo("removeMessage")).toEqual([{ linkId: LINK, messageId: "me_w1" }]);
  expect(saves).toBe(1);
  const session = loadSession("chat-l")!;
  expect(session.messages).toHaveLength(N);
  expect(session.deletedIds).toContain("me_w1");
});
