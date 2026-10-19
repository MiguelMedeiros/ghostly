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
});
