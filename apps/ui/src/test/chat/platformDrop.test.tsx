import { act, createEvent, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { followPlatformDrags, guardFileDrops, resetPlatformDrags } from "../../lib/pastedFiles";
import type { ClipboardFile } from "@ghostly/browser/host";
import { renderApp } from "../render";

// covers: app.composer.paste-files

/*
 * Files dragged in from a file manager on Linux: WebKitGTK shows the page `text/uri-list` (and its own `text/html`),
 * never a File, and an empty `getData`. The desktop app says when such a drag of files is over the window and holds
 * the files of its drop; the composer takes it as files: the veil, then the sheet. The address never reaches the draft.
 */

const onSend = vi.fn<(text: string) => Promise<string | null>>();
const onSendFile = vi.fn<(file: File) => Promise<string | null>>();

function column(extra: Partial<Parameters<typeof MessageInput>[0]> = {}) {
  return <LockScreenProvider><div data-file-drop data-testid="column"><p data-testid="messages">messages</p>
    <MessageInput onSend={onSend} onSendFile={onSendFile} {...extra} /></div></LockScreenProvider>;
}

function composer() {
  return renderApp(column());
}

const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");

/** A file manager's drag as WebKitGTK shows it to the page. */
const named = () => ({ dataTransfer: { files: [], items: [], types: ["text/uri-list", "text/html"], getData: () => "", dropEffect: "none" } });

/** What the desktop host hands over for a drop: a file Rust holds, read back by token. */
function held(name: string, text: string): ClipboardFile {
  const bytes = new TextEncoder().encode(text);
  return { name, size: bytes.length, mime: null, read: vi.fn(async (offset: number, length: number) => bytes.slice(offset, offset + length)), done: vi.fn() };
}

let read: ReturnType<typeof vi.fn<() => Promise<ClipboardFile[]>>>;
let over: (on: boolean) => void;

beforeEach(() => {
  onSend.mockReset().mockResolvedValue(null);
  onSendFile.mockReset().mockResolvedValue(null);
  read = vi.fn(async () => [held("relatório final.txt", "olá")]);
  over = followPlatformDrags(read);
});
afterEach(() => resetPlatformDrags());

describe("files dragged in from another app that the webview names by address only", () => {
  it("over the chat: the veil; dropped on the messages: the sheet with the files the platform read", async () => {
    const { user } = composer();
    const column = screen.getByTestId("column");
    // The page may hear the drag enter before the platform says what it carries: its next move shows the veil.
    fireEvent.dragEnter(column, named());
    act(() => over(true));
    const moved = createEvent.dragOver(screen.getByTestId("messages"), named());
    fireEvent(screen.getByTestId("messages"), moved);
    expect(moved.defaultPrevented).toBe(true);
    expect((moved as DragEvent).dataTransfer?.dropEffect).toBe("copy");
    expect(screen.getByTestId("file-drop-overlay")).toHaveTextContent("Drop to send");

    expect(fireEvent.drop(screen.getByTestId("messages"), named())).toBe(false);
    expect(screen.queryByTestId("file-drop-overlay")).toBeNull();
    const open = await screen.findByTestId("attachment-sheet");
    expect(within(open).getByText("relatório final.txt")).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(1);
    await user.click(within(open).getByTestId("attachment-send"));
    await waitFor(() => expect(onSendFile).toHaveBeenCalledTimes(1));
    const [sent] = onSendFile.mock.calls[0];
    expect([sent.name, sent.type, await sent.text()]).toEqual(["relatório final.txt", "text/plain", "olá"]);
  });

  it("dropped on the message field: the sheet, and never the file's address in the draft", async () => {
    composer();
    act(() => over(true));
    fireEvent.dragEnter(field(), named());
    expect(fireEvent.dragOver(field(), named())).toBe(false);
    expect(fireEvent.drop(field(), named())).toBe(false);
    expect(await screen.findByTestId("attachment-sheet")).toBeInTheDocument();
    expect(field().value).toBe("");
  });

  it("a drop with no file to send (a folder) says so; the next drag is a link again once the drop is over", async () => {
    read.mockResolvedValueOnce([]);
    composer();
    act(() => over(true));
    expect(fireEvent.drop(screen.getByTestId("messages"), named())).toBe(false);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not add those files. Send them with + → Document.");
    expect(screen.queryByTestId("attachment-sheet")).toBeNull();
    // The platform says nothing more of a drop: the page forgets it once the drop's handlers ran.
    await act(() => new Promise((done) => setTimeout(done)));
    expect(fireEvent.drop(field(), named())).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("a read that ends after an edit began says its files could not be added, not nothing", async () => {
    let end!: () => void;
    read.mockImplementationOnce(() => new Promise((done) => { end = () => done([held("relatório final.txt", "olá")]); }));
    const { rerender } = composer();
    act(() => over(true));
    expect(fireEvent.drop(screen.getByTestId("messages"), named())).toBe(false);
    rerender(column({ edit: { key: "m1", text: "boo", snippet: "boo", onSave: vi.fn(async () => null), onClose: vi.fn() } }));
    await act(async () => end());
    expect(await screen.findByRole("alert")).toHaveTextContent("What you dropped could not be added just now. Drop it again when you are done here.");
    expect(screen.queryByTestId("attachment-sheet")).toBeNull();
  });

  it("a link dragged in (the platform says no files) is left as before: no veil, its text into the field", () => {
    composer();
    act(() => over(false));
    fireEvent.dragEnter(screen.getByTestId("column"), named());
    expect(fireEvent.dragOver(screen.getByTestId("column"), named())).toBe(true);
    expect(screen.queryByTestId("file-drop-overlay")).toBeNull();
    expect(fireEvent.drop(field(), named())).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it("dropped on any other text field, the files' addresses are refused, not typed in", () => {
    const stop = guardFileDrops(window);
    const search = document.body.appendChild(document.createElement("input"));
    try {
      over(true);
      const moved = createEvent.dragOver(search, named());
      fireEvent(search, moved);
      expect(moved.defaultPrevented).toBe(true);
      expect((moved as DragEvent).dataTransfer?.dropEffect).toBe("none");
      expect(fireEvent.drop(search, named())).toBe(false);
      // A link is a field's text, as before.
      over(false);
      expect(fireEvent.drop(search, named())).toBe(true);
    } finally { search.remove(); stop(); }
  });
});
