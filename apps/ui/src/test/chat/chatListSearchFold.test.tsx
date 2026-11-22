import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { saveSession } from "../../lib/storage";
import type { ChatMessage, ChatSession } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chats.list.search

/*
 * A search in the chat list reads every chat's messages. The engine sends a new state every few hundred milliseconds,
 * and the list draws again on each: a message's text is folded for the search once, not again on every state that
 * changes no message. Folded at every draw, 100k messages took ~100 ms of each state. Counted by `foldText`'s calls.
 */

const counts = vi.hoisted(() => ({ fold: 0 }));

vi.mock("../../lib/chatSearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/chatSearch")>();
  return { ...actual, foldText: (text: string) => { counts.fold++; return actual.foldText(text); } };
});

const NOW = Date.now();
const MESSAGES = 200;
const key = (c: string) => c.repeat(52);
const message = (id: string, i: number, text = `${id} message ${i}`): ChatMessage => ({ id: `m-${i}`, text, sender: "peer", timestamp: NOW - (MESSAGES - i) * 1_000 });
const chat = (id: string, nick: string, messages: ChatMessage[]): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: key(id), encKeyB64: "enc", messages, createdAt: NOW, lastSyncAt: NOW, nick });
const many = (id: string) => Array.from({ length: MESSAGES }, (_, i) => message(id, i));
const links = [linkView({ id: "link-a", peerPubKeyZ32: key("a") }), linkView({ id: "link-b", peerPubKeyZ32: key("b") })];
const sameStateAgain = () => act(() => { fakeEngine.setState(structuredClone(fakeEngine.state)); });

describe("the chat list's search over the messages", () => {
  beforeEach(() => {
    saveSession(chat("a", "Alice", many("a")));
    saveSession(chat("b", "Bob", many("b")));
    fakeEngine.update({ links });
  });

  it("folds each message once, not again on every engine state", async () => {
    const { user } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    await user.type(screen.getByPlaceholderText("Search chats..."), "zz");
    expect(screen.queryAllByTestId("chat-row")).toHaveLength(0);
    counts.fold = 0;
    for (let i = 0; i < 5; i++) sameStateAgain();
    // The query and each chat's names, at most, per draw: none of the 400 messages.
    expect(counts.fold).toBeLessThan(5 * 20);
  });

  it("still finds a chat by a message, and by one that came while searching", async () => {
    const { user } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    await user.type(screen.getByPlaceholderText("Search chats..."), "cafe");
    expect(screen.queryAllByTestId("chat-row")).toHaveLength(0);
    saveSession(chat("b", "Bob", [...many("b"), message("b", MESSAGES, "See you at the Café")]));
    await act(async () => { window.dispatchEvent(new Event("session-updated")); });
    expect(screen.getAllByTestId("chat-row")).toHaveLength(1);
    expect(screen.getByTestId("chat-row")).toHaveTextContent("Bob");
  });

  it("reads a message as the search inside the chat does: as it shows, a file by its name, no payment lines", async () => {
    const voice: ChatMessage = { ...message("b", 3, "📎 Voice message 2026.webm"), file: { id: "f", name: "Voice message 2026.webm", size: 1, mime: "audio/webm", voice: { durationMs: 1_000, peaks: [] } as never } };
    const pdf: ChatMessage = { ...message("b", 4, "here is the plan"), file: { id: "g", name: "report.pdf", size: 1, mime: "application/pdf" } };
    saveSession(chat("a", "Alice", [message("a", 1, "*hello* world"), message("a", 2, "read [the plan](https://ghostly.tools/p) now")]));
    saveSession(chat("b", "Bob", [{ ...message("b", 1, "Payment of 21 sats"), paymentId: "p1" }, voice, pdf]));
    const { user } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    const box = screen.getByPlaceholderText("Search chats...");
    const rows = async (query: string) => {
      await user.clear(box);
      await user.type(box, query);
      return screen.queryAllByTestId("chat-row").map((row) => (row.textContent?.includes("Alice") ? "Alice" : "Bob"));
    };
    expect(await rows("hello world")).toEqual(["Alice"]);
    expect(await rows("the plan now")).toEqual(["Alice"]);
    expect(await rows("ghostly.tools/p")).toEqual(["Alice"]);
    expect(await rows("*hello*")).toEqual([]);
    expect(await rows("Payment of")).toEqual([]);
    expect(await rows("report.pdf")).toEqual(["Bob"]);
    expect(await rows("here is the plan")).toEqual([]);
    expect(await rows("voice message")).toEqual(["Bob"]);
  });
});
