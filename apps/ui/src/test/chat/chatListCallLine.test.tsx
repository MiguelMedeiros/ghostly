import { act, screen, within } from "@testing-library/react";
import { Profiler, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { useChat } from "../../hooks/useChat";
import { saveSession } from "../../lib/storage";
import type { ChatMessage, ChatParams, ChatSession } from "../../lib/types";
import { renderApp } from "../render";

// covers: chats.list.rows

/*
 * A call line is written by the chat page itself (addSystemMessage), not by the engine. The chat list keeps its own
 * copy of each chat's last message, so the line must tell it at once: before, the list caught up only on its 3 s tick.
 */

const NOW = Date.now();
const key = "k".repeat(52);
const session: ChatSession = { id: "c", profile: "paired-chat/1", mySeedB64: "seed-c", peerPubKeyB64: key, encKeyB64: "enc", nick: "Cleo", nickSource: "profile",
  messages: [{ id: "m1", text: "see you soon", sender: "peer", timestamp: NOW - 60_000 }], createdAt: NOW - 120_000 };
const params: ChatParams = { sessionId: "c", profile: "paired-chat/1", seedB64: "seed-c", peerPubKeyB64: key, encKeyB64: "enc" } as ChatParams;
const callLine: ChatMessage = { id: "call_ended_1", text: "Audio call ended", sender: "system", timestamp: NOW, callEvent: { type: "call_ended", hasVideo: false, duration: 65_000 } };

let add: ((m: ChatMessage) => void) | undefined;
function ChatPage() {
  const { addSystemMessage } = useChat(params);
  useEffect(() => { add = addSystemMessage; }, [addSystemMessage]);
  return null;
}

afterEach(() => { vi.useRealTimers(); add = undefined; });

describe("a call line in the chat list", () => {
  it("shows as the chat's last message as soon as the chat page writes it, with one list render and no extra chat render", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    saveSession(session);
    const commits = { list: 0, chat: 0 };
    const { engine } = renderApp(
      <UpdateProvider>
        <Profiler id="list" onRender={() => { commits.list++; }}><Sidebar /></Profiler>
        <Profiler id="chat" onRender={() => { commits.chat++; }}><ChatPage /></Profiler>
      </UpdateProvider>,
    );
    engine.on("ensureLink", () => ({ linkId: "c" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const row = () => screen.getAllByTestId("chat-row").find(r => within(r).getByTestId("chat-row-name").textContent === "Cleo")!;
    expect(row()).toHaveTextContent("see you soon");

    const before = { ...commits };
    act(() => add!(callLine));
    const at = { list: commits.list - before.list, chat: commits.chat - before.chat, shown: row().textContent?.includes("Audio call ended") };
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    console.info(`call line: shown at once ${at.shown}; commits at once list ${at.list} chat ${at.chat}; after 3 s list ${commits.list - before.list} chat ${commits.chat - before.chat}`);
    // No timer had run: the list moved with the line itself, in one render of each.
    expect(at).toEqual({ list: 1, chat: 1, shown: true });
  });
});
