import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { downloadName } from "../../lib/fileDownload";
import { servicesPlatform, type FileTransferState } from "../../lib/platform";
import type { ChatMessage } from "../../lib/types";
import { voiceToMp3 } from "../../lib/voiceMp3";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// The conversion needs Web Audio and a worker (neither is in happy-dom): its encoder has its own tests
// (voice/mp3Encode.test.ts) and e2e/web/voice-download.spec.ts converts a real recording.
vi.mock("../../lib/voiceMp3", () => ({ voiceToMp3: vi.fn() }));

// covers: files.download

const peaks = Array.from({ length: 64 }, (_, i) => (i * 37) % 256);
const at = new Date(2026, 8, 27, 14, 1, 30).getTime();

const voice = (patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1", text: "🎤 Voice message (0:03)", sender: "peer", timestamp: at,
  file: { id: "chat1-in-voice", name: "Voice message.webm", size: 4, mime: "audio/webm", voice: { duration: 3_000, peaks } },
  ...patch,
});
const document_ = (patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m2", text: "report.pdf", sender: "peer", timestamp: at,
  file: { id: "chat1-in-doc", name: "report.pdf", size: 4, mime: "application/pdf" }, ...patch,
});

function show(message: ChatMessage, transfer: FileTransferState | null = null) {
  fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: transfer && message.file ? { [message.file.id]: transfer } : {} });
  return renderApp(<MessageBubble message={message} peerPubKey="peer" onDelete={() => {}} />);
}

async function menu(user: ReturnType<typeof show>["user"]): Promise<string[]> {
  await user.click(screen.getByTestId("message-options"));
  return [...screen.getByTestId("message-menu").querySelectorAll("[data-menu-item]")].map((row) => row.getAttribute("data-testid") ?? "");
}

let clicked: { href: string; download: string }[] = [];

beforeEach(() => {
  clicked = [];
  vi.spyOn(servicesPlatform!, "getFile").mockImplementation(async () => new Blob(["opus"], { type: "audio/webm" }));
  vi.mocked(voiceToMp3).mockReset().mockResolvedValue(new Blob(["mp3"], { type: "audio/mpeg" }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, download: this.download });
  });
  URL.createObjectURL = vi.fn(() => "blob:ghostly/voice");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (servicesPlatform as { saveFile?: unknown }).saveFile;
  delete (servicesPlatform as { saveBlob?: unknown }).saveBlob;
});

describe("Download in a message's menu", () => {
  it("comes first for a voice message, then Download as MP3, before Details and Delete", async () => {
    const { user } = show(voice());
    expect(await menu(user)).toEqual(["message-download", "message-download-mp3", "message-details", "message-delete"]);
    expect(screen.getByTestId("message-download")).toHaveTextContent(/^Download$/);
    expect(screen.getByTestId("message-download")).toBeEnabled();
    expect(screen.getByTestId("message-download-mp3")).toHaveTextContent(/^Download as MP3$/);
    expect(screen.getByTestId("message-download-mp3")).toBeEnabled();
  });

  it("offers MP3 only for a voice message", async () => {
    const { user } = show(document_());
    expect(await menu(user)).toEqual(["message-download", "message-details", "message-delete"]);
  });

  it("is there for any file, and not for a text", async () => {
    const file = show(document_());
    expect(await menu(file.user)).toContain("message-download");
    file.unmount();
    const text = show({ id: "m3", text: "hello", sender: "peer", timestamp: at });
    expect(await menu(text.user)).not.toContain("message-download");
  });

  it.each([
    ["still arriving", { state: "transferring", transferred: 1, size: 4 } as FileTransferState, "Not received yet", "arriving"],
    ["failed", { state: "failed", transferred: 1, size: 4, error: "Lost" } as FileTransferState, "Did not arrive", "failed"],
  ])("is greyed with the reason while a received file is %s", async (_, transfer, reason, state) => {
    const { user } = show(voice(), transfer);
    await menu(user);
    const item = screen.getByTestId("message-download");
    expect(item).toBeDisabled();
    expect(item).toHaveTextContent(reason);
    expect(item).toHaveAttribute("data-download-state", state);
  });

  it("is ready for a file sent from here while it is still going", async () => {
    const { user } = show(voice({ sender: "me", file: { ...voice().file!, id: "chat1-out-voice" } }), { state: "transferring", transferred: 1, size: 4 });
    await menu(user);
    expect(screen.getByTestId("message-download")).toBeEnabled();
  });

  it("waits while a large file sent from here is still being copied into storage", async () => {
    const { user } = show(voice({ sender: "me", file: { ...voice().file!, id: "chat1-out-big" } }), { state: "transferring", stage: "preparing", transferred: 1, size: 4 });
    await menu(user);
    expect(screen.getByTestId("message-download")).toBeDisabled();
    expect(screen.getByTestId("message-download")).toHaveTextContent("Still being prepared");
  });

  it("waits right after a start, until the transfers are restored, for a received file", async () => {
    fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: {}, transfersRestored: false });
    const { user } = renderApp(<MessageBubble message={document_()} peerPubKey="peer" onDelete={() => {}} />);
    await menu(user);
    const item = screen.getByTestId("message-download");
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute("data-download-state", "restoring");
    act(() => fakeEngine.update({ transfersRestored: true }));
    expect(screen.getByTestId("message-download")).toBeEnabled();
    expect(screen.getByTestId("message-download")).toHaveAttribute("data-download-state", "ready");
  });

  it("downloads a voice message on the web under a readable name, and closes the menu", async () => {
    const { user } = show(voice());
    await menu(user);
    await user.click(screen.getByTestId("message-download"));
    await waitFor(() => expect(clicked).toEqual([{ href: "blob:ghostly/voice", download: "Ghostly voice 2026-09-27 14.01.30.webm" }]));
    expect(servicesPlatform!.getFile).toHaveBeenCalledWith("chat1-in-voice");
    expect(screen.queryByTestId("message-menu")).not.toBeInTheDocument();
  });

  it("hands out a file that is not a picture or sound as bytes, never as a page", async () => {
    vi.mocked(servicesPlatform!.getFile).mockResolvedValue(new Blob(["<html>"], { type: "text/html" }));
    const { user } = show(document_());
    await menu(user);
    await user.click(screen.getByTestId("message-download"));
    await waitFor(() => expect(clicked).toHaveLength(1));
    // The file's own bubble made a URL for its preview first; the download's is the last one.
    const calls = vi.mocked(URL.createObjectURL).mock.calls;
    expect((calls[calls.length - 1]![0] as Blob).type).toBe("application/octet-stream");
    expect(clicked[0]!.download).toBe("report.pdf");
  });

  it("saves through the system's dialog where there is one (Desktop), with the same name", async () => {
    const saveFile = vi.fn(async () => true);
    Object.assign(servicesPlatform!, { saveFile });
    const { user } = show(voice());
    await menu(user);
    await user.click(screen.getByTestId("message-download"));
    await waitFor(() => expect(saveFile).toHaveBeenCalledWith("chat1-in-voice", "Ghostly voice 2026-09-27 14.01.30.webm"));
    expect(clicked).toEqual([]);
    expect(screen.queryByTestId("message-menu")).not.toBeInTheDocument();
  });

  it("says so when the bytes are gone from this device", async () => {
    vi.mocked(servicesPlatform!.getFile).mockResolvedValue(null);
    const { user } = show(voice());
    await menu(user);
    await user.click(screen.getByTestId("message-download"));
    await waitFor(() => expect(screen.getByTestId("message-download")).toBeDisabled());
    expect(screen.getByTestId("message-download")).toHaveTextContent("Not on this device");
    expect(clicked).toEqual([]);
  });

  it("converts a voice message to MP3 and downloads it on the web under the same name, as .mp3", async () => {
    const { user } = show(voice());
    await menu(user);
    await user.click(screen.getByTestId("message-download-mp3"));
    await waitFor(() => expect(clicked).toEqual([{ href: "blob:ghostly/voice", download: "Ghostly voice 2026-09-27 14.01.30.mp3" }]));
    expect(vi.mocked(voiceToMp3).mock.calls[0]![0].type).toBe("audio/webm");
    const calls = vi.mocked(URL.createObjectURL).mock.calls;
    expect((calls[calls.length - 1]![0] as Blob).type).toBe("audio/mpeg");
    expect(screen.queryByTestId("message-menu")).not.toBeInTheDocument();
  });

  it("says it is converting while it does, and why when it cannot", async () => {
    let fail!: (error: Error) => void;
    vi.mocked(voiceToMp3).mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    const { user } = show(voice());
    await menu(user);
    await user.click(screen.getByTestId("message-download-mp3"));
    const item = screen.getByTestId("message-download-mp3");
    await waitFor(() => expect(item).toHaveTextContent("Converting…"));
    expect(item).toBeDisabled();
    // The original stays at hand meanwhile.
    expect(screen.getByTestId("message-download")).toBeEnabled();
    fail(new Error("This device cannot decode the recording"));
    await waitFor(() => expect(item).toHaveTextContent("Could not convert"));
    expect(item).toHaveAttribute("data-download-state", "unconverted");
    expect(clicked).toEqual([]);
  });

  it("saves the MP3 through the system's dialog where there is one (Desktop)", async () => {
    const saveBlob = vi.fn(async () => true);
    Object.assign(servicesPlatform!, { saveBlob });
    const { user } = show(voice());
    await menu(user);
    await user.click(screen.getByTestId("message-download-mp3"));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledWith(expect.any(Blob), "Ghostly voice 2026-09-27 14.01.30.mp3"));
    expect(clicked).toEqual([]);
    expect(screen.queryByTestId("message-menu")).not.toBeInTheDocument();
  });

  it("never lets a received name reach the disk as a path or with hidden characters", () => {
    const tricky = document_({ file: { id: "x", name: "../../etc/invoice‮fdp.exe", size: 1, mime: "application/pdf" } });
    expect(downloadName(tricky.file!, at)).toBe("etcinvoicefdp.exe");
  });
});
