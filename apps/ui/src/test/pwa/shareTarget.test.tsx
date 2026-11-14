import { act, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { SharePicker } from "../../pages/SharePicker";
import { SEARCH_STATUS_SETTLE_MS } from "../../components/ui/SearchStatus";
import { groupChat } from "../../lib/chatMute";
import { incomingShare, receiveShare, resetIncomingShare, sendShareTo, sharePreview, shareText, takeShareFor, type IncomingShare } from "../../lib/incomingShare";
import { saveSession, setSessionDraft } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import type { Language } from "../../lib/settings";
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

  it("the picker previews the start of a long text, never half a character, and the draft gets it whole", () => {
    expect(sharePreview(share({ text: "Look", url: "https://a.example" }))).toBe("Look\nhttps://a.example");
    // A pair astride the preview's end is left out whole.
    const text = `${"a".repeat(2047)}👻${"b".repeat(100_000)}`;
    expect(sharePreview(share({ text }))).toBe(`${"a".repeat(2047)}…`);
    expect(sharePreview(share({ text: `${"a".repeat(2046)}👻${"b".repeat(10)}` }))).toBe(`${"a".repeat(2046)}👻…`);
    expect(shareText(share({ text })).length).toBe(102_049);
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

  it("an empty share never clears the one that waits", () => {
    receiveShare(share({ text: "newer text" }));
    receiveShare(share());
    expect(incomingShare()?.text).toBe("newer text");
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

  it("closing the sheet puts the focus in the message field, where the shared text is, though nothing had it as the sheet opened", async () => {
    const { user } = renderApp(<LockScreenProvider><MessageInput draftId="chat-1" onSend={onSend} onSendFile={onSendFile} /></LockScreenProvider>);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    act(() => {
      receiveShare(share({ text: "Look at this", files: [file("a.txt"), file("b.txt"), file("c.txt")] }));
      sendShareTo("chat-1");
    });
    await screen.findByTestId("attachment-sheet");
    // The sheet opens once the share's files are read, outside act(): its effects (the focus into the caption, the
    // Escape it answers) may run a task after it is in the page.
    await waitFor(() => expect(screen.getByTestId("attachment-caption")).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("attachment-sheet")).toBeNull();
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>("Message…")).toHaveFocus();
  });

  it("files not read yet (the Android app's) are read when the composer takes them, not before", async () => {
    const read = vi.fn(async () => [file("photo.jpg")]);
    renderApp(<LockScreenProvider><MessageInput draftId="chat-1" onSend={onSend} onSendFile={onSendFile} /></LockScreenProvider>);
    act(() => receiveShare(share({ files: [{ name: "photo.jpg", size: 3, type: "image/jpeg" }], read })));
    expect(read).not.toHaveBeenCalled();
    act(() => sendShareTo("chat-1"));
    const sheet = await screen.findByTestId("attachment-sheet");
    expect(within(sheet).getByTestId("attachment-item")).toHaveTextContent("photo.jpg");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("a share whose files cannot be read any more says so", async () => {
    renderApp(<LockScreenProvider><MessageInput draftId="chat-1" onSend={onSend} onSendFile={onSendFile} /></LockScreenProvider>);
    act(() => {
      receiveShare(share({ files: [{ name: "photo.jpg", size: 3, type: "image/jpeg" }], read: () => Promise.reject(new Error("Nothing pasted under that token")) }));
      sendShareTo("chat-1");
    });
    expect(await screen.findByText(/Nothing pasted under that token/)).toBeInTheDocument();
    expect(screen.queryByTestId("attachment-sheet")).toBeNull();
  });

  it("a text longer than the field takes goes whole as a text file on the sheet, the draft left as it was", async () => {
    const long = "a".repeat(19_999) + "Z";
    renderApp(<LockScreenProvider><MessageInput draftId="chat-1" onSend={onSend} onSendFile={onSendFile} maxLength={16_384} textBytes={16_384} /></LockScreenProvider>);
    act(() => {
      receiveShare(share({ text: long, files: [file()] }));
      sendShareTo("chat-1");
    });
    const sheet = await screen.findByTestId("attachment-sheet");
    const items = within(sheet).getAllByTestId("attachment-item");
    expect(items.map((item) => item.textContent)).toEqual([expect.stringContaining("Shared text.txt"), expect.stringContaining("ghost.txt")]);
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>("Message…").value).toBe("");
  });

  it.each([["Japanese", "日本語".repeat(2_000)], ["emoji", "👻".repeat(5_000)]])("a %s text under the field's length but over the message's bytes goes as a text file too", async (_, text) => {
    renderApp(<LockScreenProvider><MessageInput draftId="chat-1" onSend={onSend} onSendFile={onSendFile} maxLength={16_384} textBytes={16_384} /></LockScreenProvider>);
    act(() => {
      receiveShare(share({ text }));
      sendShareTo("chat-1");
    });
    const sheet = await screen.findByTestId("attachment-sheet");
    expect(within(sheet).getByTestId("attachment-item")).toHaveTextContent("Shared text.txt");
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>("Message…").value).toBe("");
  });

  it("a text that fits alone but not after the draft goes as a text file, the draft left as it was", async () => {
    setSessionDraft("chat-joined", "a".repeat(10_000));
    renderApp(<LockScreenProvider><MessageInput draftId="chat-joined" onSend={onSend} onSendFile={onSendFile} maxLength={16_384} textBytes={16_384} /></LockScreenProvider>);
    act(() => {
      receiveShare(share({ text: "b".repeat(10_000) }));
      sendShareTo("chat-joined");
    });
    const sheet = await screen.findByTestId("attachment-sheet");
    expect(within(sheet).getByTestId("attachment-item")).toHaveTextContent("Shared text.txt");
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>("Message…").value).toBe("a".repeat(10_000));
  });

  it("a draft over the cap, where files cannot go, takes every edit that shortens it and none that grows it", async () => {
    const { user } = renderApp(<LockScreenProvider><MessageInput draftId="chat-1" onSend={onSend} maxLength={16_384} textBytes={16_384} /></LockScreenProvider>);
    act(() => {
      receiveShare(share({ text: "a".repeat(16_499) + "Z" }));
      sendShareTo("chat-1");
    });
    const field = screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");
    expect(field.value).toHaveLength(16_500);
    await user.click(field);
    field.setSelectionRange(field.value.length, field.value.length);
    await user.keyboard("{Backspace}");
    expect(field.value).toHaveLength(16_499);
    expect(field.value.endsWith("Z")).toBe(false);
    await user.keyboard("b");
    expect(field.value).toHaveLength(16_499);
    field.setSelectionRange(0, 3_000);
    await user.keyboard("{Backspace}");
    expect(field.value).toHaveLength(13_499);
    await user.keyboard("b");
    expect(field.value).toHaveLength(13_500);
  });

  it("two shares picked for one chat: both texts go in the draft and every file on the sheet, in their order", async () => {
    act(() => {
      receiveShare(share({ text: "one", files: [file("a.txt")] }), { queue: true });
      receiveShare(share({ text: "two", files: [file("b.txt")] }), { queue: true });
      sendShareTo("chat-1");
      sendShareTo("chat-1");
    });
    renderApp(<LockScreenProvider><MessageInput draftId="chat-1" onSend={onSend} onSendFile={onSendFile} /></LockScreenProvider>);
    const sheet = await screen.findByTestId("attachment-sheet");
    expect(within(sheet).getAllByTestId("attachment-item").map((item) => item.textContent)).toEqual([expect.stringContaining("a.txt"), expect.stringContaining("b.txt")]);
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>("Message…").value).toBe("one\ntwo");
    expect(takeShareFor("chat-1")).toBeNull();
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

describe("in a composer editing one of my messages", () => {
  const onSend = vi.fn(async () => null);
  const onSendFile = vi.fn(async () => null);
  const onSave = vi.fn(async (_text: string) => null);
  beforeEach(() => { onSave.mockClear(); onSend.mockClear(); });

  /** A chat's composer (or a group's, which takes no files) with an edit of `m1` open and "my draft" set aside. */
  function Editing({ draftId = "chat-1", group = false }: { draftId?: string; group?: boolean }) {
    const [editing, setEditing] = useState(true);
    return <LockScreenProvider>
      <MessageInput draftId={draftId} onSend={onSend} onSendFile={group ? undefined : onSendFile} maxLength={16_384} textBytes={16_384}
        edit={editing ? { key: "m1", text: "my old words", snippet: "my old words", onSave, onClose: () => setEditing(false) } : undefined} />
    </LockScreenProvider>;
  }
  const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");
  const deliver = (chat: string, patch: Partial<IncomingShare>) => act(() => {
    receiveShare(share(patch));
    sendShareTo(chat);
  });

  it("a shared text leaves the edit alone; Enter saves the edit without it, and it goes in the draft that comes back", async () => {
    setSessionDraft("chat-1", "my draft");
    const { user } = renderApp(<Editing />);
    expect(field().value).toBe("my old words");
    deliver("chat-1", { text: "SHARED TEXT" });
    expect(field().value).toBe("my old words");
    await user.click(field());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("composer-edit")).toBeNull());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toBe("my old words");
    expect(field().value).toBe("my draft\nSHARED TEXT");
    expect(onSend).not.toHaveBeenCalled();
    expect(takeShareFor("chat-1")).toBeNull();
  });

  it("Escape (the edit left) keeps it: the draft comes back with the shared text in it", async () => {
    setSessionDraft("chat-1", "my draft");
    const { user } = renderApp(<Editing />);
    deliver("chat-1", { text: "SHARED TEXT" });
    expect(field().value).toBe("my old words");
    await user.click(field());
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("composer-edit")).toBeNull();
    expect(field().value).toBe("my draft\nSHARED TEXT");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shared files are left waiting, never dropped, and go on the sheet once the edit ends", async () => {
    const { user } = renderApp(<Editing />);
    deliver("chat-1", { text: "Look", files: [file()] });
    expect(field().value).toBe("my old words");
    expect(screen.queryByTestId("attachment-sheet")).toBeNull();
    await user.click(field());
    await user.keyboard("{Escape}");
    const sheet = await screen.findByTestId("attachment-sheet");
    expect(within(sheet).getByTestId("attachment-item")).toHaveTextContent("ghost.txt");
    expect(field().value).toBe("Look");
    expect(onSendFile).not.toHaveBeenCalled();
  });

  it("the same files shared again while they wait for the edit go on the sheet once; other files join them", async () => {
    const { user } = renderApp(<Editing />);
    deliver("chat-1", { text: "Look", files: [file()] });
    deliver("chat-1", { text: "Look", files: [file()] });
    deliver("chat-1", { files: [file("other.txt")] });
    await user.click(field());
    await user.keyboard("{Escape}");
    const sheet = await screen.findByTestId("attachment-sheet");
    expect(within(sheet).getAllByTestId("attachment-item").map((item) => item.textContent)).toEqual([expect.stringContaining("ghost.txt"), expect.stringContaining("other.txt")]);
    expect(field().value).toBe("Look");
  });

  it("files still being read as an edit begins wait for it to end, never dropped", async () => {
    let done!: (files: File[]) => void;
    const read = vi.fn(() => new Promise<File[]>((resolve) => { done = resolve; }));
    function Later() {
      const [editing, setEditing] = useState(false);
      return <LockScreenProvider>
        <button onClick={() => setEditing(true)}>edit it</button>
        <MessageInput draftId="chat-1" onSend={onSend} onSendFile={onSendFile}
          edit={editing ? { key: "m1", text: "my old words", snippet: "my old words", onSave, onClose: () => setEditing(false) } : undefined} />
      </LockScreenProvider>;
    }
    const { user } = renderApp(<Later />);
    deliver("chat-1", { files: [{ name: "photo.jpg", size: 3, type: "image/jpeg" }], read });
    expect(read).toHaveBeenCalledTimes(1);
    await user.click(screen.getByText("edit it"));
    expect(field().value).toBe("my old words");
    await act(async () => done([file("photo.jpg")]));
    expect(screen.queryByTestId("attachment-sheet")).toBeNull();
    expect(screen.getByTestId("composer-share-waits")).toBeInTheDocument();
    await user.click(field());
    await user.keyboard("{Escape}");
    const sheet = await screen.findByTestId("attachment-sheet");
    expect(within(sheet).getByTestId("attachment-item")).toHaveTextContent("photo.jpg");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("a group's composer: the same, the edit saved without the shared text and the text in the draft after", async () => {
    setSessionDraft("group:g1", "my draft");
    const { user } = renderApp(<Editing draftId="group:g1" group />);
    deliver("group:g1", { text: "SHARED TEXT" });
    expect(field().value).toBe("my old words");
    await user.click(field());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("composer-edit")).toBeNull());
    expect(onSave.mock.calls[0]![0]).toBe("my old words");
    expect(field().value).toBe("my draft\nSHARED TEXT");
  });
});

describe("the Share to… picker", () => {
  function Where() {
    return <p data-testid="where">{useLocation().pathname}</p>;
  }
  const picker = () => renderApp(<Routes><Route path="/shared" element={<SharePicker />} /><Route path="*" element={<Where />} /></Routes>, { route: "/shared" });
  /** A share shown is said before a press acts on it: the clock moved past that. */
  const settled = () => vi.setSystemTime(Date.now() + SEARCH_STATUS_SETTLE_MS);
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    saveSession({ id: "chat1", mySeedB64: "s", peerPubKeyB64: "peerkey", encKeyB64: "e", nick: "Ana", createdAt: 1, messages: [] } as unknown as ChatSession);
    fakeEngine.setState(engineState({ groups: [groupView({ id: "g1", name: "Friends" })] }));
  });

  it("lists the chats and the groups for text; picking one hands it over and opens the chat", async () => {
    receiveShare(share({ text: "hello" }));
    const { user } = picker();
    settled();
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
    settled();
    await user.click(screen.getByTestId("share-chat"));
    expect(screen.getByTestId("where")).toHaveTextContent("/chat/chat1");
  });

  it("a share the picker opens on by itself is not acted on before it is seen: a tap meant for the screen it replaced picks nothing", async () => {
    vi.setSystemTime(Date.now());
    receiveShare(share({ text: "website text", files: [file("invoice.pdf")] }), { queue: true });
    const { user } = picker();
    await user.click(screen.getByTestId("share-chat"));
    await user.click(screen.getByTestId("share-cancel"));
    expect(screen.queryByTestId("where")).toBeNull();
    expect(incomingShare()?.text).toBe("website text");
    expect(takeShareFor("chat1")).toBeNull();
    // Said to a screen reader as the next share is.
    await waitFor(() => expect(screen.getByTestId("share-next")).toHaveTextContent("From another app or website. Nothing is sent until you send it. invoice.pdf website text"));
    settled();
    await user.click(screen.getByTestId("share-chat"));
    expect(screen.getByTestId("where")).toHaveTextContent("/chat/chat1");
    expect(takeShareFor("chat1")?.files.map((f) => f.name)).toEqual(["invoice.pdf"]);
  });

  it("a share that reaches the picker while it waits for one gets the same pause from when it shows", async () => {
    vi.setSystemTime(Date.now());
    const { user } = picker();
    expect(screen.getByTestId("share-none")).toBeInTheDocument();
    settled();
    act(() => receiveShare(share({ text: "website text" }), { queue: true }));
    await user.click(screen.getByTestId("share-chat"));
    expect(screen.queryByTestId("where")).toBeNull();
    expect(incomingShare()?.text).toBe("website text");
    settled();
    await user.click(screen.getByTestId("share-chat"));
    expect(screen.getByTestId("where")).toHaveTextContent("/chat/chat1");
  });

  it("files go to groups too (WISP 503): picking one hands them to its composer", async () => {
    receiveShare(share({ files: [file("a.png"), file("b.png")] }));
    const { user } = picker();
    settled();
    expect(screen.getByTestId("share-files")).toHaveTextContent("2 files");
    expect(screen.getByTestId("share-chat")).toHaveTextContent("Ana");
    await user.click(screen.getByTestId("share-group"));
    expect(takeShareFor(groupChat("g1"))?.files.map((f) => f.name)).toEqual(["a.png", "b.png"]);
    expect(screen.getByTestId("where")).toHaveTextContent("/group/g1");
  });

  it("shows the shared text and file name in their own direction, so in Arabic an English text keeps its '!' at its end", () => {
    receiveShare(share({ text: "Look at this, it's great!", files: [file("Quarterly report (final draft).pdf")] }));
    picker();
    expect(screen.getByTestId("share-text")).toHaveAttribute("dir", "auto");
    expect(screen.getByTestId("share-files")).toHaveTextContent("Quarterly report (final draft).pdf");
    expect(screen.getByTestId("share-files")).toHaveAttribute("dir", "auto");
  });

  it("wraps a long one-word file name inside its card, so its end and extension stay on screen", () => {
    const name = "IMG_20261013_021233_holiday_beach_sunset_camera_backup_final_version_2.jpg";
    receiveShare(share({ files: [file(name)] }));
    picker();
    expect(screen.getByTestId("share-files")).toHaveTextContent(name);
    expect(screen.getByTestId("share-files").className).toContain("[overflow-wrap:anywhere]");
  });

  it("finds a chat by name as Forward does, the arrow keys going from the search to the chats found; the next share lists them all again", async () => {
    // Thirty contacts spoken to lately: Ana, spoken to never, is past a phone's screen.
    for (let i = 0; i < 30; i++) {
      saveSession({ id: `c${i}`, mySeedB64: "s", peerPubKeyB64: `peer${i}`, encKeyB64: "e", nick: `Contact ${i + 1}`, createdAt: 1,
        messages: [{ id: "x", text: "hi", sender: "peer", timestamp: 10_000 - i }] } as unknown as ChatSession);
    }
    receiveShare(share({ text: "one" }), { queue: true });
    receiveShare(share({ text: "two" }), { queue: true });
    const { user } = picker();
    settled();
    const search = screen.getByTestId("share-search");
    expect(search).toHaveAccessibleName("Search chats");
    // Not on the search by itself: the picker may open on its own, and a phone's keyboard would cover the list.
    expect(search).not.toHaveFocus();
    expect(screen.getAllByTestId("share-chat")).toHaveLength(31);
    await user.click(search);
    await user.keyboard("zz");
    expect(screen.queryByTestId("share-chat")).toBeNull();
    expect(screen.getByTestId("share-no-match")).toHaveTextContent("No chat by that name");
    await user.clear(search);
    await user.keyboard("aN");
    expect(screen.getAllByTestId("share-chat").map((row) => row.querySelector("bdi")?.textContent)).toEqual(["Ana"]);
    await user.keyboard("{ArrowDown}");
    expect(screen.getByTestId("share-chat")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("share-text")).toHaveTextContent("two");
    expect(screen.getByTestId("share-search")).toHaveValue("");
    expect(screen.getAllByTestId("share-chat")).toHaveLength(31);
    expect(takeShareFor("chat1")?.text).toBe("one");
  });

  it("Cancel drops the share and goes home", async () => {
    receiveShare(share({ text: "never mind" }));
    const { user } = picker();
    settled();
    await user.click(screen.getByTestId("share-cancel"));
    expect(incomingShare()).toBeNull();
    expect(screen.getByTestId("where")).toHaveTextContent("/");
  });

  it("two shares waiting: picking a chat for the first shows the second, and the last one picked opens its chat", async () => {
    receiveShare(share({ text: "one" }), { queue: true });
    receiveShare(share({ text: "two", files: [file("photo.jpg")] }), { queue: true });
    const { user } = picker();
    settled();
    expect(screen.getByTestId("share-text")).toHaveTextContent("one");
    await user.click(screen.getByTestId("share-chat"));
    // Still the picker, now on the share that waited behind: none is left where nothing shows it.
    expect(screen.queryByTestId("where")).toBeNull();
    expect(screen.getByTestId("share-files")).toHaveTextContent("photo.jpg");
    expect(screen.getByTestId("share-text")).toHaveTextContent("two");
    settled();
    await user.click(screen.getByTestId("share-group"));
    expect(screen.getByTestId("where")).toHaveTextContent("/group/g1");
    // Each waits for the composer of the chat picked for it.
    expect(takeShareFor("chat1")?.text).toBe("one");
    expect(takeShareFor(groupChat("g1"))?.files.map((f) => f.name)).toEqual(["photo.jpg"]);
  });

  it("two shares waiting: a chat picked with Enter moves the focus to the heading and says the next share; Enter or a double tap again acts on nothing", async () => {
    receiveShare(share({ text: "first text" }), { queue: true });
    receiveShare(share({ text: "second unseen", files: [file("photo.jpg")] }), { queue: true });
    const { user } = picker();
    settled();
    const ana = screen.getByTestId("share-chat");
    ana.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("share-text")).toHaveTextContent("second unseen");
    // The focus left the row just pressed: a second Enter (a key held down, or pressed again because nothing seemed to
    // happen) lands on the heading, not on the share nobody saw yet.
    expect(document.activeElement).toBe(within(screen.getByTestId("share-picker")).getByRole("heading", { level: 1 }));
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("where")).toBeNull();
    expect(incomingShare()?.text).toBe("second unseen");
    // A press on the row itself before the new share is said (a double tap) does nothing either.
    await user.click(ana);
    expect(screen.queryByTestId("where")).toBeNull();
    expect(incomingShare()?.text).toBe("second unseen");
    // Said to a screen reader, from the words on the card.
    await waitFor(() => expect(screen.getByTestId("share-next")).toHaveTextContent("From another app or website. Nothing is sent until you send it. photo.jpg second unseen"));
    expect(screen.getByTestId("share-next")).toHaveAttribute("aria-live", "polite");
    settled();
    await user.click(ana);
    expect(screen.getByTestId("where")).toHaveTextContent("/chat/chat1");
    expect(shareText(takeShareFor("chat1")!)).toBe("first text\nsecond unseen");
  });

  it("two shares waiting: Cancel shows the next one the same way, and a double tap on it never drops the next unseen", async () => {
    receiveShare(share({ text: "never mind" }), { queue: true });
    receiveShare(share({ text: "second unseen" }), { queue: true });
    const { user } = picker();
    settled();
    await user.click(screen.getByTestId("share-cancel"));
    expect(screen.getByTestId("share-text")).toHaveTextContent("second unseen");
    expect(document.activeElement).toBe(within(screen.getByTestId("share-picker")).getByRole("heading", { level: 1 }));
    await user.keyboard("{Enter}");
    expect(incomingShare()?.text).toBe("second unseen");
    // The second tap of a double tap lands on Cancel again: it puts nothing aside.
    await user.click(screen.getByTestId("share-cancel"));
    expect(screen.queryByTestId("where")).toBeNull();
    expect(incomingShare()?.text).toBe("second unseen");
    await waitFor(() => expect(screen.getByTestId("share-next")).toHaveTextContent("From another app or website. Nothing is sent until you send it. second unseen"));
    settled();
    await user.click(screen.getByTestId("share-cancel"));
    expect(incomingShare()).toBeNull();
    expect(screen.getByTestId("where")).toHaveTextContent("/");
  });

  it("the same chat picked for two shares gets both, in their order", async () => {
    receiveShare(share({ text: "one", files: [file("a.txt")] }), { queue: true });
    receiveShare(share({ text: "two", url: "https://b.example", files: [file("b.txt")] }), { queue: true });
    const { user } = picker();
    settled();
    await user.click(screen.getByTestId("share-chat"));
    settled();
    await user.click(screen.getByTestId("share-chat"));
    expect(screen.getByTestId("where")).toHaveTextContent("/chat/chat1");
    const both = takeShareFor("chat1")!;
    expect(shareText(both)).toBe("one\ntwo\nhttps://b.example");
    expect(both.files.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
    expect(takeShareFor("chat1")).toBeNull();
  });

  it("names the files too large to share and how to send them; with nothing else, offers no chat", () => {
    receiveShare(share({ files: [file("a.png")], leftOut: ["VID_1.mp4"] }));
    const { unmount } = picker();
    expect(screen.getByTestId("share-files")).toHaveTextContent("a.png");
    expect(screen.getByTestId("share-left-out-title")).toHaveTextContent("Too large to share here: \u2068VID_1.mp4\u2069");
    expect(screen.getByTestId("share-left-out-next")).toHaveTextContent("Open a chat and send it with + → Document.");
    expect(screen.getByTestId("share-chat")).toHaveTextContent("Ana");
    unmount();

    // Only names, with no share waiting: said alone.
    resetIncomingShare();
    receiveShare(share({ leftOut: ["VID_1.mp4", "VID_2.mp4"] }));
    picker();
    expect(screen.queryByTestId("share-none")).toBeNull();
    expect(screen.getByTestId("share-left-out-title")).toHaveTextContent("Too large to share here: \u2068VID_1.mp4\u2069, \u2068VID_2.mp4\u2069");
    expect(screen.queryByTestId("share-summary")).toBeNull();
    expect(screen.queryByTestId("share-chat")).toBeNull();
    expect(screen.getByTestId("share-cancel")).toBeInTheDocument();
  });

  it("names the files it could not read apart from those too large, also when that was all of a later share", () => {
    receiveShare(share({ text: "look", leftOut: ["VID_1.mp4"], unread: ["IMG_2.jpg"] }));
    // A later share whose only file could not be read: named with the share that waits, which stays.
    receiveShare(share({ unread: ["IMG_3.jpg"] }));
    picker();
    expect(screen.getByTestId("share-text")).toHaveTextContent("look");
    expect(screen.getByTestId("share-left-out-title")).toHaveTextContent("Too large to share here: \u2068VID_1.mp4\u2069");
    expect(screen.getByTestId("share-unread-title")).toHaveTextContent("Couldn't read: \u2068IMG_2.jpg\u2069, \u2068IMG_3.jpg\u2069");
    expect(screen.getByTestId("share-unread-next")).toHaveTextContent("Share it again from its app, or open a chat and send it with + → Document.");
    expect(screen.getByTestId("share-chat")).toHaveTextContent("Ana");
  });

  it("names the files past the count cap on a line of its own, with how to send them", () => {
    const files = Array.from({ length: 32 }, (_, i) => file(`IMG_${i + 1}.jpg`));
    receiveShare(share({ files, pastLimit: ["IMG_33.jpg", "IMG_34.jpg"] }));
    picker();
    expect(screen.getByTestId("share-files")).toHaveTextContent("32 files");
    expect(screen.getByTestId("share-past-limit-title")).toHaveTextContent("Only the first 32 files came in. Left out: \u2068IMG_33.jpg\u2069, \u2068IMG_34.jpg\u2069");
    expect(screen.getByTestId("share-past-limit-next")).toHaveTextContent("Share the rest again, or open a chat and send them with + → Document.");
    // Not said as too large: that is not why they were left out.
    expect(screen.queryByTestId("share-left-out")).toBeNull();
    expect(screen.getByTestId("share-chat")).toHaveTextContent("Ana");
  });

  it("names the files past the count cap also when that was all of a later share, with the share that waits", () => {
    receiveShare(share({ text: "look" }));
    receiveShare(share({ pastLimit: ["IMG_33.jpg"] }));
    picker();
    expect(screen.getByTestId("share-text")).toHaveTextContent("look");
    expect(screen.getByTestId("share-past-limit-title")).toHaveTextContent("Only the first 32 files came in. Left out: \u2068IMG_33.jpg\u2069");
  });

  it("a share too large to read (the web app's, over 64 MB): says so without a name, and how to send it", () => {
    vi.useFakeTimers();
    try {
      receiveShare(share({ leftOut: [""] }));
      picker();
      act(() => { vi.advanceTimersByTime(6000); });
      expect(screen.queryByTestId("share-none")).toBeNull();
      expect(screen.getByTestId("share-left-out-title").textContent).toBe("Too large to share here");
      expect(screen.getByTestId("share-left-out-next")).toHaveTextContent("Open a chat and send it with + → Document.");
      expect(screen.queryByTestId("share-chat")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the files the device had no room to copy as such, not as unread, also when that was all of a later share", () => {
    receiveShare(share({ text: "look", noRoom: ["VID_1.mp4"] }));
    receiveShare(share({ noRoom: ["VID_2.mp4"] }));
    picker();
    expect(screen.getByTestId("share-text")).toHaveTextContent("look");
    expect(screen.getByTestId("share-no-room-title")).toHaveTextContent("No room on this device for: \u2068VID_1.mp4\u2069, \u2068VID_2.mp4\u2069");
    expect(screen.getByTestId("share-no-room-next")).toHaveTextContent("Free some space, then share it again.");
    expect(screen.queryByTestId("share-unread")).toBeNull();
  });

  it("lists the left-out files as the language does, each name isolated: Arabic keeps a name's own order, Japanese and Chinese join with 、", () => {
    const isolated = (names: string[], join: string) => names.map((name) => `⁨${name}⁩`).join(join);
    const cases: [Language, string, string, string, string][] = [
      ["ar", " و", "تعذّرت قراءة: ", "أكبر من أن يُشارك هنا: ", "لا توجد مساحة على هذا الجهاز لـ: "],
      ["ja", "、", "読み込めませんでした: ", "大きすぎてここでは共有できません: ", "この端末に空き容量がありません: "],
      ["zh", "、", "无法读取:", "太大,无法在这里分享:", "此设备空间不足,无法保存:"],
    ];
    for (const [language, join, unread, tooLarge, noRoom] of cases) {
      resetIncomingShare();
      receiveShare(share({ text: "look", unread: ["صورة.jpg", "report.pdf"], leftOut: ["VID_1.mp4", "فيديو.mp4"], noRoom: ["ملف.txt", "a.txt"], pastLimit: ["IMG_33.jpg", "صورة.png"] }));
      const { unmount } = renderApp(<SharePicker />, { route: "/shared", language });
      expect(screen.getByTestId("share-unread-title").textContent).toBe(unread + isolated(["صورة.jpg", "report.pdf"], join));
      expect(screen.getByTestId("share-left-out-title").textContent).toBe(tooLarge + isolated(["VID_1.mp4", "فيديو.mp4"], join));
      expect(screen.getByTestId("share-no-room-title").textContent).toBe(noRoom + isolated(["ملف.txt", "a.txt"], join));
      expect(screen.getByTestId("share-past-limit-title").textContent).toMatch(new RegExp(`${isolated(["IMG_33.jpg", "صورة.png"], join).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
      unmount();
    }
  });

  it("a share past the three that can wait is never dropped without a word: the share shown says how many were not kept", async () => {
    for (const text of ["one", "two", "three", "four", "five"]) receiveShare(share({ text }), { queue: true });
    const { user } = picker();
    settled();
    expect(screen.getByTestId("share-text")).toHaveTextContent("one");
    expect(screen.getByTestId("share-dropped-title")).toHaveTextContent("2 more shares couldn't be kept: 3 were already waiting.");
    expect(screen.getByTestId("share-dropped-next")).toHaveTextContent("Send or cancel the ones waiting, then share the rest again.");
    // Said once, with the share it came beside: the next one shown is the next share, nothing more.
    await user.click(screen.getByTestId("share-cancel"));
    expect(screen.getByTestId("share-text")).toHaveTextContent("two");
    expect(screen.queryByTestId("share-dropped")).toBeNull();
  });

  it("shares the web app's worker could not keep before any reached the page are said too, one alone in its own words", () => {
    // The worker held three already: a fourth was not kept, and it says so with the last it hands over.
    receiveShare(share({ text: "one" }), { queue: true });
    receiveShare(share({ text: "two", dropped: 1 }), { queue: true });
    picker();
    expect(screen.getByTestId("share-text")).toHaveTextContent("one");
    expect(screen.getByTestId("share-dropped-title")).toHaveTextContent("1 more share couldn't be kept: 3 were already waiting.");
    expect(incomingShare()?.dropped).toBe(1);
  });

  it("with nothing shared, it says so once it has waited", () => {
    vi.useFakeTimers();
    try {
      picker();
      expect(screen.getByTestId("share-none")).toHaveTextContent("Getting what was shared…");
      expect(screen.getByTestId("share-next")).toBeEmptyDOMElement();
      act(() => { vi.advanceTimersByTime(6000); });
      expect(screen.getByTestId("share-none")).toHaveTextContent("Nothing was shared, or it was already picked up.");
      // Said to a screen reader too: the line changed on its own, with no press to bring anyone to it.
      act(() => { vi.advanceTimersByTime(SEARCH_STATUS_SETTLE_MS); });
      expect(screen.getByTestId("share-next")).toHaveTextContent("Nothing was shared, or it was already picked up.");
    } finally {
      vi.useRealTimers();
    }
  });
});
