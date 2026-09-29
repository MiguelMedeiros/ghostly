import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { SharePicker } from "../../pages/SharePicker";
import { groupChat } from "../../lib/chatMute";
import { incomingShare, receiveShare, resetIncomingShare, sendShareTo, shareText, takeShareFor, type IncomingShare } from "../../lib/incomingShare";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { engineState, fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.pwa.share-target

const share = (patch: Partial<IncomingShare> = {}): IncomingShare => ({ title: "", text: "", url: "", files: [], ...patch });
const file = (name = "ghost.txt") => new File(["boo"], name, { type: "text/plain" });

beforeEach(() => {
  resetIncomingShare();
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => resetIncomingShare());

describe("the text a share puts in the draft", () => {
  it("its text, and its link where the text does not carry it already", () => {
    expect(shareText(share({ text: "Look", url: "https://a.example" }))).toBe("Look\nhttps://a.example");
    expect(shareText(share({ text: "Look at https://a.example", url: "https://a.example" }))).toBe("Look at https://a.example");
    expect(shareText(share({ url: "https://a.example", title: "A page" }))).toBe("https://a.example");
    expect(shareText(share({ title: "Only a title" }))).toBe("Only a title");
    expect(shareText(share())).toBe("");
  });

  it("an empty share is dropped; a picked one waits for its chat's composer, once", () => {
    receiveShare(share());
    expect(incomingShare()).toBeNull();
    receiveShare(share({ text: "hi" }));
    sendShareTo("chat-1");
    expect(incomingShare()).toBeNull();
    expect(takeShareFor("chat-2")).toBeNull();
    expect(takeShareFor("chat-1")?.text).toBe("hi");
    expect(takeShareFor("chat-1")).toBeNull();
  });
});

describe("in the composer", () => {
  const onSend = vi.fn(async () => null);
  const onSendFile = vi.fn(async () => null);

  it("the text goes in the draft and the files on the attachment sheet, sending nothing", async () => {
    renderApp(<LockScreenProvider><MessageInput draftId="chat-1" onSend={onSend} onSendFile={onSendFile} /></LockScreenProvider>);
    act(() => {
      receiveShare(share({ text: "Look at this", url: "https://example.com/boo", files: [file()] }));
      sendShareTo("chat-1");
    });
    const sheet = await screen.findByTestId("attachment-sheet");
    expect(within(sheet).getByTestId("attachment-item")).toHaveTextContent("ghost.txt");
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>("Message…").value).toBe("Look at this\nhttps://example.com/boo");
    expect(onSend).not.toHaveBeenCalled();
    expect(onSendFile).not.toHaveBeenCalled();
  });

  it("another chat's composer leaves it alone", () => {
    renderApp(<LockScreenProvider><MessageInput draftId="chat-2" onSend={onSend} onSendFile={onSendFile} /></LockScreenProvider>);
    act(() => {
      receiveShare(share({ text: "for chat 1" }));
      sendShareTo("chat-1");
    });
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>("Message…").value).toBe("");
    expect(takeShareFor("chat-1")?.text).toBe("for chat 1");
  });
});

describe("the Share to… picker", () => {
  function Where() {
    return <p data-testid="where">{useLocation().pathname}</p>;
  }
  const picker = () => renderApp(<Routes><Route path="/shared" element={<SharePicker />} /><Route path="*" element={<Where />} /></Routes>, { route: "/shared" });

  beforeEach(() => {
    saveSession({ id: "chat1", mySeedB64: "s", peerPubKeyB64: "peerkey", encKeyB64: "e", nick: "Ana", createdAt: 1, messages: [] } as unknown as ChatSession);
    fakeEngine.setState(engineState({ groups: [groupView({ id: "g1", name: "Friends" })] }));
  });

  it("lists the chats and the groups for text; picking one hands it over and opens the chat", async () => {
    receiveShare(share({ text: "hello" }));
    const { user } = picker();
    expect(screen.getByTestId("share-text")).toHaveTextContent("hello");
    expect(screen.getAllByTestId("share-chat")).toHaveLength(1);
    expect(screen.getByTestId("share-group")).toHaveTextContent("Friends");
    await user.click(screen.getByTestId("share-group"));
    expect(takeShareFor(groupChat("g1"))?.text).toBe("hello");
    expect(screen.getByTestId("where")).toHaveTextContent("/group/g1");
  });

  it("says the share came from outside, and picks no chat by itself, not even the only one", async () => {
    receiveShare(share({ text: "from a website", files: [file()] }));
    const { user } = picker();
    expect(screen.getByTestId("share-from")).toHaveTextContent("From another app or website. Nothing is sent until you send it.");
    expect(screen.getAllByTestId("share-chat")).toHaveLength(1);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(screen.queryByTestId("where")).toBeNull();
    expect(incomingShare()?.text).toBe("from a website");
    expect(takeShareFor("chat1")).toBeNull();
    await user.click(screen.getByTestId("share-chat"));
    expect(screen.getByTestId("where")).toHaveTextContent("/chat/chat1");
  });

  it("files go to 1:1 chats only: groups do not take files yet", () => {
    receiveShare(share({ files: [file("a.png"), file("b.png")] }));
    picker();
    expect(screen.getByTestId("share-files")).toHaveTextContent("2 files");
    expect(screen.queryByTestId("share-group")).toBeNull();
    expect(screen.getByTestId("share-chat")).toHaveTextContent("Ana");
  });

  it("Cancel drops the share and goes home", async () => {
    receiveShare(share({ text: "never mind" }));
    const { user } = picker();
    await user.click(screen.getByTestId("share-cancel"));
    expect(incomingShare()).toBeNull();
    expect(screen.getByTestId("where")).toHaveTextContent("/");
  });

  it("with nothing shared, it says so once it has waited", () => {
    vi.useFakeTimers();
    try {
      picker();
      expect(screen.getByTestId("share-none")).toHaveTextContent("Getting what was shared...");
      act(() => { vi.advanceTimersByTime(6000); });
      expect(screen.getByTestId("share-none")).toHaveTextContent("Nothing was shared, or it was already picked up.");
    } finally {
      vi.useRealTimers();
    }
  });
});
