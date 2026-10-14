import { act } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { notifySessionsChanged } from "@ghostly/browser/platform/sync";
import { useChat } from "../../hooks/useChat";
import { addMessage, saveSession } from "../../lib/storage";
import type { ChatMessage, ChatParams, ChatSession } from "../../lib/types";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.send

/*
 * A paired chat keeps no copy of what it sends: its row comes from the engine's history. Right after the app opens with a
 * large profile the engine answers nothing until it has read every chat's history, and the text sent showed only then
 * (3.6 s after Enter on a desktop, 13.6 s at 4x CPU). It shows at once as sending, and the engine's row takes its place.
 */

const NOW = Date.now();
const key = "k".repeat(52);
const session: ChatSession = { id: "c", profile: "paired-chat/1", mySeedB64: "seed-c", peerPubKeyB64: key, encKeyB64: "enc",
  messages: [{ id: "peer_1", text: "hi there", sender: "peer", timestamp: NOW - 60_000 }], createdAt: NOW - 120_000 };
const params = { sessionId: "c", profile: "paired-chat/1", seedB64: "seed-c", peerPubKeyB64: key, encKeyB64: "enc" } as ChatParams;

let chat: ReturnType<typeof useChat> | undefined;
function ChatPage() {
  const state = useChat(params);
  useEffect(() => { chat = state; });
  return null;
}

/** The engine's `sendMessage`, held as the start reads hold it, and answered when the test says. */
function heldSend(engine: ReturnType<typeof renderApp>["engine"]) {
  let answer: (result: { error: string | null; refused?: boolean; messageId?: string }) => void = () => {};
  engine.on("ensureLink", () => ({ linkId: "c" }));
  engine.on("sendMessage", () => new Promise(resolve => { answer = resolve; }));
  engine.update({ links: [linkView({ id: "c", peerPubKeyZ32: key, profile: "paired-chat/1" })] });
  return (result: Parameters<typeof answer>[0]) => answer(result);
}

const texts = () => chat!.messages.map(m => [m.text, m.delivery]);

afterEach(() => { chat = undefined; });

describe("a text sent in a paired chat", () => {
  it("shows at once as sending while the engine has not answered, then as the engine's row, once", async () => {
    saveSession(session);
    const { engine } = renderApp(<ChatPage />);
    const answer = heldSend(engine);
    await act(async () => {});

    let sent!: Promise<string | null>;
    act(() => { sent = chat!.sendMessage("cold start hello"); });
    expect(texts()).toEqual([["hi there", undefined], ["cold start hello", "sending"]]);
    await act(async () => {});
    expect(texts()).toEqual([["hi there", undefined], ["cold start hello", "sending"]]);

    // The engine stores it (under its own id, at the timestamp it was given) and the mirror writes it into the session.
    const timestamp = engine.callsTo("sendMessage")[0]!.timestamp!;
    const row: ChatMessage = { id: "me_wire", text: "cold start hello", sender: "me", timestamp, delivery: "sent" };
    await act(async () => {
      addMessage("c", row);
      notifySessionsChanged();
      answer({ error: null, messageId: "me_wire" });
      expect(await sent).toBeNull();
    });
    expect(texts()).toEqual([["hi there", undefined], ["cold start hello", "sent"]]);
    expect(chat!.messages[1]!.id).toBe("me_wire");
  });

  it("drops the sending row of a text the engine refused", async () => {
    saveSession(session);
    const { engine } = renderApp(<ChatPage />);
    const answer = heldSend(engine);
    await act(async () => {});

    let sent!: Promise<string | null>;
    act(() => { sent = chat!.sendMessage("too long"); });
    expect(texts()).toContainEqual(["too long", "sending"]);
    await act(async () => {});
    await act(async () => {
      answer({ error: "Message exceeds 4096 UTF-8 bytes.", refused: true });
      expect(await sent).toBe("Message exceeds 4096 UTF-8 bytes.");
    });
    expect(texts()).toEqual([["hi there", undefined]]);
  });
});
