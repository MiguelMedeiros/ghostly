import { act, createEvent, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { guardFileDrops, pastedFiles, pastedImageName, PLATFORM_PASTE_MAX } from "../../lib/pastedFiles";
import { fakeEngine } from "../fakeEngine";
import type { ClipboardFile } from "@ghostly/browser/host";
import { renderApp } from "../render";

// covers: app.composer.paste-files

const SEED = "legal winner thank year wave sausage worth useful legal winner thank yellow";

const onSend = vi.fn<(text: string) => Promise<string | null>>();
const onSendFile = vi.fn<(file: File) => Promise<string | null>>();

type Props = Partial<Parameters<typeof MessageInput>[0]>;
/** A 1:1 chat's composer inside the chat's column, which takes dropped files. */
function composer(props: Props = {}) {
  return renderApp(<LockScreenProvider><div data-file-drop data-testid="column"><p data-testid="messages">messages</p>
    <MessageInput onSend={onSend} onSendFile={onSendFile} {...props} /></div></LockScreenProvider>);
}

const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");
const sheet = () => screen.queryByTestId("attachment-sheet");

/** What a clipboard or a drag hands the page: jsdom-likes have no DataTransfer to build one with. */
function transfer({ files = [], text = "", html = "" }: { files?: File[]; text?: string; html?: string }) {
  return {
    files, types: [...(files.length ? ["Files"] : []), ...(text ? ["text/plain"] : []), ...(html ? ["text/html"] : [])],
    items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    getData: (type: string) => type === "text/plain" ? text : type === "text/html" ? html : "",
    dropEffect: "none",
  };
}

/** Pastes into `target`; true when the page left the paste to the field (nothing intercepted). */
function paste(target: Element | Document, data: Parameters<typeof transfer>[0]): boolean {
  return fireEvent.paste(target, { clipboardData: transfer(data) });
}

const png = (name = "image.png", bytes = [137, 80, 78, 71]) => new File([new Uint8Array(bytes)], name, { type: "image/png" });

beforeEach(() => {
  onSend.mockReset().mockResolvedValue(null);
  onSendFile.mockReset().mockResolvedValue(null);
  URL.createObjectURL = vi.fn(() => "blob:picture");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.useRealTimers());

describe("a pasted picture or file", () => {
  it("opens the sheet with its picture and a caption; Send sends the file, then the caption", async () => {
    const { user } = composer();
    expect(paste(field(), { files: [png()] })).toBe(false);
    const open = await screen.findByTestId("attachment-sheet");
    expect(within(open).getByTestId("attachment-image")).toHaveAttribute("src", "blob:picture");
    expect(within(open).getByTestId("attachment-name").textContent).toMatch(/^Pasted image \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.png · 4 B$/);
    // The caption has the keys: typing goes there straight away, and Enter sends.
    expect(within(open).getByTestId("attachment-caption")).toHaveFocus();
    await user.keyboard("boo, a ghost{Enter}");

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("boo, a ghost"));
    expect(onSendFile).toHaveBeenCalledTimes(1);
    const [sent] = onSendFile.mock.calls[0];
    expect(sent.name).toMatch(/^Pasted image .*\.png$/);
    expect(sent.type).toBe("image/png");
    expect([...new Uint8Array(await sent.arrayBuffer())]).toEqual([137, 80, 78, 71]);
    expect(onSendFile.mock.invocationCallOrder[0]).toBeLessThan(onSend.mock.invocationCallOrder[0]);
    expect(sheet()).toBeNull();
    // Back to writing.
    await waitFor(() => expect(field()).toHaveFocus());
  });

  it("several files are several attachments, each under its own name, and one can be taken out", async () => {
    const { user } = composer();
    const notes = new File(["boo"], "notes.pdf", { type: "application/pdf" });
    paste(field(), { files: [notes, png("haunt.png"), new File(["x"], "list.txt", { type: "text/plain" })] });
    const open = await screen.findByTestId("attachment-sheet");
    expect(within(open).getAllByTestId("attachment-item")).toHaveLength(3);
    expect(within(open).getByText("notes.pdf")).toBeInTheDocument();
    await user.click(within(open).getByRole("button", { name: "Remove list.txt" }));
    // Another paste adds to what is waiting.
    paste(within(open).getByTestId("attachment-caption"), { files: [png()] });
    expect(within(open).getAllByTestId("attachment-item")).toHaveLength(3);
    await user.click(within(open).getByTestId("attachment-send"));
    await waitFor(() => expect(onSendFile).toHaveBeenCalledTimes(3));
    expect(onSendFile.mock.calls.map(([file]) => file.name)).toEqual(["notes.pdf", "haunt.png", expect.stringMatching(/^Pasted image /)]);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("the first file that cannot go stops the rest and says why; the caption is not sent", async () => {
    onSendFile.mockResolvedValueOnce("That file is too large (max 100.0 MB).");
    const { user } = composer();
    paste(field(), { files: [png("a.png"), png("b.png")] });
    await user.type(await screen.findByTestId("attachment-caption"), "look");
    await user.click(screen.getByTestId("attachment-send"));
    expect(await screen.findByRole("alert")).toHaveTextContent("That file is too large (max 100.0 MB).");
    expect(onSendFile).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("Cancel and Escape send nothing", async () => {
    const { user } = composer();
    paste(field(), { files: [png()] });
    await user.click(await screen.findByTestId("attachment-cancel"));
    expect(sheet()).toBeNull();
    paste(field(), { files: [png()] });
    await screen.findByTestId("attachment-sheet");
    await user.keyboard("{Escape}");
    expect(sheet()).toBeNull();
    expect(onSendFile).not.toHaveBeenCalled();
  });

  it("a caption that looks like a secret asks first, as the draft does", async () => {
    const { user } = composer();
    paste(field(), { files: [png()] });
    await user.type(await screen.findByTestId("attachment-caption"), SEED);
    await user.click(screen.getByTestId("attachment-send"));
    await waitFor(() => expect(onSendFile).toHaveBeenCalledTimes(1));
    await screen.findByTestId("secret-guard");
    expect(onSend).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("secret-guard-send"));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(SEED));
  });

  it("where files cannot go now, the paste says why; where they have no place, it is left alone", async () => {
    composer({ fileUnavailable: "Update both peers to send files" });
    expect(paste(field(), { files: [png()] })).toBe(false);
    expect(await screen.findByRole("alert")).toHaveTextContent("Update both peers to send files");
    expect(sheet()).toBeNull();
  });

  it("a composer with no files and nothing to say about it never takes a paste", () => {
    composer({ onSendFile: undefined });
    expect(paste(field(), { files: [png()] })).toBe(true);
    expect(sheet()).toBeNull();
  });

  it("a group's composer has no files: a picture pasted or a file dropped there is told so, not ignored", async () => {
    composer({ onSendFile: undefined, fileUnavailable: "Files are not part of groups yet" });
    expect(paste(field(), { files: [png()] })).toBe(false);
    expect(await screen.findByRole("alert")).toHaveTextContent("Files are not part of groups yet");
    expect(sheet()).toBeNull();
  });

  it("a file dropped on a group is told so too, with no veil inviting the drop", async () => {
    composer({ onSendFile: undefined, fileUnavailable: "Files are not part of groups yet" });
    const column = screen.getByTestId("column"), data = transfer({ files: [png()] });
    fireEvent.dragEnter(column, { dataTransfer: data });
    expect(screen.queryByTestId("file-drop-overlay")).toBeNull();
    const drop = createEvent.drop(column, { dataTransfer: data });
    fireEvent(column, drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(await screen.findByRole("alert")).toHaveTextContent("Files are not part of groups yet");
  });

  it("behind the lock screen, a paste opens nothing", () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}"),
      lockScreen: { enabled: true, passwordHash: "hash", timeout: 5 } }));
    let locked = false;
    function Lock() { locked = useLockScreen().isLocked; return null; }
    renderApp(<LockScreenProvider><Lock /><MessageInput onSend={onSend} onSendFile={onSendFile} /></LockScreenProvider>);
    try {
      // Locked from the start (a lock with a password), the composer mounted under it: nothing opens.
      expect(locked).toBe(true);
      expect(paste(field(), { files: [png()] })).toBe(true);
      expect(sheet()).toBeNull();
      expect(paste(document.body, { files: [png()] })).toBe(true);
      expect(sheet()).toBeNull();
      expect(onSendFile).not.toHaveBeenCalled();
    } finally { localStorage.removeItem("ghostly_app_settings"); }
  });

  it("a paste with nothing focused (the messages clicked last) still brings the picture", async () => {
    composer();
    act(() => field().blur());
    expect(paste(screen.getByTestId("messages"), { files: [png()] })).toBe(false);
    expect(await screen.findByTestId("attachment-sheet")).toBeInTheDocument();
  });
});

/** What the desktop host holds for a paste, read back a few bytes at a time as Rust hands them. */
function held(name: string | null, bytes: number[], mime: string | null = null): ClipboardFile {
  return { name, size: bytes.length, mime, read: vi.fn(async (offset: number, length: number) => new Uint8Array(bytes.slice(offset, offset + Math.min(length, 3)))) };
}

describe("a paste the webview showed nothing of (the desktop app reads the clipboard itself)", () => {
  afterEach(() => { fakeEngine.readClipboardFiles = undefined; });

  it("a picture only the platform could see opens the sheet and sends as a PNG", async () => {
    fakeEngine.readClipboardFiles = vi.fn(async () => [held(null, [137, 80, 78, 71, 13, 10, 26, 10], "image/png")]);
    const { user } = composer();
    expect(paste(field(), {})).toBe(false);
    const open = await screen.findByTestId("attachment-sheet");
    expect(within(open).getByTestId("attachment-name").textContent).toMatch(/^Pasted image .*\.png · 8 B$/);
    await user.click(within(open).getByTestId("attachment-send"));
    await waitFor(() => expect(onSendFile).toHaveBeenCalledTimes(1));
    const [sent] = onSendFile.mock.calls[0];
    expect(sent.type).toBe("image/png");
    expect([...new Uint8Array(await sent.arrayBuffer())]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it("files copied in a file manager keep their names and get their types", async () => {
    fakeEngine.readClipboardFiles = vi.fn(async () => [held("scan.pdf", [37, 80, 68, 70]), held("notes", [1])]);
    const { user } = composer();
    paste(field(), {});
    await user.click(await screen.findByTestId("attachment-send"));
    await waitFor(() => expect(onSendFile).toHaveBeenCalledTimes(2));
    expect(onSendFile.mock.calls.map(([f]) => [f.name, f.type, f.size])).toEqual([["scan.pdf", "application/pdf", 4], ["notes", "", 1]]);
  });

  it("text, or files the paste already showed, never ask the platform", async () => {
    fakeEngine.readClipboardFiles = vi.fn(async () => []);
    composer();
    expect(paste(field(), { text: "words" })).toBe(true);
    paste(field(), { files: [png()] });
    await screen.findByTestId("attachment-sheet");
    expect(fakeEngine.readClipboardFiles).not.toHaveBeenCalled();
  });

  it("nothing on the clipboard is nothing; too large says where to send it from", async () => {
    fakeEngine.readClipboardFiles = vi.fn(async () => []);
    composer();
    paste(field(), {});
    await waitFor(() => expect(fakeEngine.readClipboardFiles).toHaveBeenCalledTimes(1));
    expect(sheet()).toBeNull();
    const huge: ClipboardFile = { name: "film.mkv", size: PLATFORM_PASTE_MAX + 1, mime: null, read: vi.fn() };
    fakeEngine.readClipboardFiles = vi.fn(async () => [huge]);
    paste(field(), {});
    expect(await screen.findByRole("alert")).toHaveTextContent("That is too large to paste. Send it with + → Document.");
    expect(huge.read).not.toHaveBeenCalled();
  });

  it("the web app has no such read: an empty paste is left alone", () => {
    composer();
    expect(paste(field(), {})).toBe(true);
  });
});

describe("pasted text", () => {
  it("is left to the field, exactly as before", () => {
    composer();
    expect(paste(field(), { text: "just words" })).toBe(true);
    expect(sheet()).toBeNull();
  });

  it("a rich copy (cells, a document's paragraph) is text, even with a picture of itself", () => {
    composer();
    expect(paste(field(), { files: [png()], text: "Q3 totals", html: "<table><tr><td>Q3 totals</td></tr></table>" })).toBe(true);
    expect(sheet()).toBeNull();
    expect(onSendFile).not.toHaveBeenCalled();
  });
});

describe("dropping files on the chat", () => {
  it("shows where to drop them over the column, then opens the sheet with them", async () => {
    const { user } = composer();
    const column = screen.getByTestId("column");
    const files = [new File(["boo"], "ghost story.pdf", { type: "application/pdf" })];
    fireEvent.dragEnter(column, { dataTransfer: transfer({ files }) });
    // Moving over a child element keeps the veil up.
    fireEvent.dragEnter(screen.getByTestId("messages"), { dataTransfer: transfer({ files }) });
    fireEvent.dragLeave(column, { dataTransfer: transfer({ files }) });
    const veil = screen.getByTestId("file-drop-overlay");
    expect(column).toContainElement(veil);
    expect(veil).toHaveTextContent("Drop to send");
    const over = createEvent.dragOver(column, { dataTransfer: transfer({ files }) });
    fireEvent(column, over);
    expect(over.defaultPrevented).toBe(true);

    expect(fireEvent.drop(screen.getByTestId("messages"), { dataTransfer: transfer({ files }) })).toBe(false);
    expect(screen.queryByTestId("file-drop-overlay")).toBeNull();
    const open = await screen.findByTestId("attachment-sheet");
    expect(within(open).getByText("ghost story.pdf")).toBeInTheDocument();
    await user.click(within(open).getByTestId("attachment-send"));
    await waitFor(() => expect(onSendFile.mock.calls.map(([file]) => file.name)).toEqual(["ghost story.pdf"]));
  });

  it("the veil goes when the drag leaves the column or ends somewhere else", () => {
    composer();
    const column = screen.getByTestId("column");
    const data = () => ({ dataTransfer: transfer({ files: [png()] }) });
    fireEvent.dragEnter(column, data());
    fireEvent.dragEnter(screen.getByTestId("messages"), data());
    // Out to the page beside the chat (this DOM's DragEvent drops `relatedTarget` from its init: set it as a browser does).
    const out = createEvent.dragLeave(screen.getByTestId("messages"), data());
    Object.defineProperty(out, "relatedTarget", { value: document.body });
    fireEvent(screen.getByTestId("messages"), out);
    expect(screen.queryByTestId("file-drop-overlay")).toBeNull();
    fireEvent.dragEnter(column, data());
    expect(screen.getByTestId("file-drop-overlay")).toBeInTheDocument();
    fireEvent(window, new Event("dragend"));
    expect(screen.queryByTestId("file-drop-overlay")).toBeNull();
    expect(sheet()).toBeNull();
  });

  it("text dragged about is not a drop of files", () => {
    composer();
    fireEvent.dragEnter(screen.getByTestId("column"), { dataTransfer: transfer({ text: "words" }) });
    expect(screen.queryByTestId("file-drop-overlay")).toBeNull();
  });
});

describe("pastedFiles and the names of pasted pictures", () => {
  it("names a picture after the moment it was pasted, in local time", () => {
    const at = new Date(2026, 8, 27, 14, 52, 10);
    expect(pastedImageName("image/png", at)).toBe("Pasted image 2026-09-27 14.52.10.png");
    expect(pastedImageName("image/jpeg", at)).toBe("Pasted image 2026-09-27 14.52.10.jpg");
    const [named] = pastedFiles(transfer({ files: [png("image.png")] }) as unknown as DataTransfer, at)!;
    expect(named.name).toBe("Pasted image 2026-09-27 14.52.10.png");
    // A copied file keeps its own name, a picture included.
    expect(pastedFiles(transfer({ files: [png("scan.png")] }) as unknown as DataTransfer, at)![0].name).toBe("scan.png");
    expect(pastedFiles(transfer({ text: "words" }) as unknown as DataTransfer)).toBeNull();
  });

  it("a file dropped where nothing takes it does not open in place of the app", () => {
    const stop = guardFileDrops(window);
    try {
      const over = createEvent.dragOver(document.body, { dataTransfer: transfer({ files: [png()] }) });
      fireEvent(document.body, over);
      expect(over.defaultPrevented).toBe(true);
      expect(fireEvent.drop(document.body, { dataTransfer: transfer({ files: [png()] }) })).toBe(false);
      // Text dragged into a field is none of its business, and a file field takes its own drop.
      expect(fireEvent.drop(document.body, { dataTransfer: transfer({ text: "words" }) })).toBe(true);
      const input = document.body.appendChild(Object.assign(document.createElement("input"), { type: "file" }));
      expect(fireEvent.drop(input, { dataTransfer: transfer({ files: [png()] }) })).toBe(true);
      input.remove();
    } finally { stop(); }
  });
});
