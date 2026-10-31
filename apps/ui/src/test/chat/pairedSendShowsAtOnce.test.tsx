import { act } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notifySessionsChanged } from "@ghostly/browser/platform/sync";
import { useChat } from "../../hooks/useChat";
import { addMessage, saveSession } from "../../lib/storage";

/** While `reads` is on, every field read of a row the chat is handed counts. Each list is wrapped once. */
const { reads } = vi.hoisted(() => ({ reads: { on: false, n: 0 } }));
vi.mock("../../lib/storage", async importOriginal => {
  const storage = await importOriginal<typeof import("../../lib/storage")>();
  const wrapped = new WeakMap<object, object>();
  const counted = (rows: ChatMessage[]) => rows.map(m => new Proxy(m, { get(target, key, receiver) { if (reads.on) reads.n++; return Reflect.get(target, key, receiver); } }));
  return {
    ...storage,
    loadShownSession: (id: string) => {
      const shown = storage.loadShownSession(id);
      if (!shown) return shown;
      if (!wrapped.has(shown)) wrapped.set(shown, { ...shown, messages: counted(shown.messages) });
      return wrapped.get(shown) as typeof shown;
    },
  };
});
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

afterEach(() => { chat = undefined; reads.on = false; });

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

  it("reads a long chat's history once per list for all the texts still sending, not once per text", async () => {
    const history: ChatMessage[] = Array.from({ length: 2_000 }, (_, i) => ({ id: `peer_${i}`, text: `m${i}`, sender: "peer", timestamp: NOW - 3_000_000 + i * 1_000 }));
    saveSession({ ...session, messages: history });
    const { engine } = renderApp(<ChatPage />);
    heldSend(engine);
    await act(async () => {});
    // Ten texts sent with no pause, none stored by the engine yet.
    vi.spyOn(Date, "now").mockImplementation(() => NOW + engine.callsTo("sendMessage").length);
    for (let i = 0; i < 10; i++) {
      act(() => { void chat!.sendMessage(`quick ${i}`); });
      await act(async () => {});
    }
    vi.mocked(Date.now).mockRestore();
    expect(chat!.messages.filter(m => m.delivery === "sending")).toHaveLength(10);

    // The engine stores the first; the peer's answer comes in the same list.
    const timestamp = engine.callsTo("sendMessage")[0]!.timestamp!;
    reads.n = 0;
    reads.on = true;
    await act(async () => {
      addMessage("c", { id: "me_wire", text: "quick 0", sender: "me", timestamp, delivery: "sent" });
      addMessage("c", { id: "peer_new", text: "ok", sender: "peer", timestamp: NOW + 100 });
      notifySessionsChanged();
    });
    reads.on = false;
    // A walk per text still sending read 43 fields a row here; one walk, and the sort that puts them in place, read 6.
    expect(reads.n / history.length).toBeLessThan(8);
    expect(chat!.messages.filter(m => m.delivery === "sending")).toHaveLength(9);
    expect(chat!.messages.slice(-11).map(m => m.text)).toEqual(["quick 0", ...Array.from({ length: 9 }, (_, i) => `quick ${i + 1}`), "ok"]);
    expect(chat!.messages.find(m => m.text === "quick 0")).toMatchObject({ id: "me_wire", delivery: "sent" });
  });
});
