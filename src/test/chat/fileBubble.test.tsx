import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileBubble } from "../../components/FileBubble";
import { fileStatus, timeLeft } from "../../lib/fileStatus";
import { servicesPlatform, type FileTransferState } from "../../lib/platform";
import type { ChatFile } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: files.large.offer, files.large.resume, files.size-label, files.large.resend, files.large.request

const GB = 1024 ** 3;
// The root tsconfig has no Array.at.
const last = <T,>(list: T[]): T | undefined => list[list.length - 1];
const file = (patch: Partial<ChatFile> = {}): ChatFile => ({ id: "chat1-in-abc", name: "movie.mkv", size: 4.2 * GB, mime: "video/x-matroska", ...patch });
const show = (transfer: FileTransferState | null, patch: Partial<ChatFile> = {}) => {
  fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: transfer ? { [file(patch).id]: transfer } : {} });
  return renderApp(<FileBubble file={file(patch)} peerName="Ana" />);
};

beforeEach(() => {
  vi.spyOn(servicesPlatform!, "getFile").mockResolvedValue(null);
  fakeEngine.on("fileAction", () => undefined);
});

describe("what a file's status line says", () => {
  const f = file();
  const t = (patch: Partial<FileTransferState>): FileTransferState => ({ state: "transferring", transferred: 0.62 * f.size, size: f.size, ...patch });
  it.each([
    ["moving, with speed and time left", t({ rate: 12 * 1024 ** 2 }), "62% of 4.2 GB · 12.0 MB/s · 2 min left"],
    ["moving, no speed yet", t({}), "62% of 4.2 GB"],
    ["no connection", t({ stage: "waiting" }), "Waiting for connection · 62% done"],
    ["no connection, nothing moved", t({ stage: "waiting", transferred: 0 }), "Waiting for connection · 4.2 GB"],
    ["sent, the contact decides", t({ stage: "asking", direction: "out", transferred: 0 }), "Waiting for Ana to accept · 4.2 GB"],
    ["received, this person decides", t({ stage: "asking", direction: "in", transferred: 0 }), "4.2 GB · waiting for your answer"],
    ["sent, the contact's turn", t({ stage: "queued", direction: "out" }), "Queued by Ana · 62% done"],
    ["paused here", t({ stage: "paused", pausedBy: "me" }), "Paused · 62% of 4.2 GB"],
    ["paused by the contact", t({ stage: "paused", pausedBy: "peer" }), "Paused by Ana · 62% of 4.2 GB"],
    ["checking", t({ stage: "verifying" }), "Checking the file… 4.2 GB"],
    ["copying before the offer", t({ stage: "preparing" }), "Preparing… 62% of 4.2 GB"],
    ["declined", { state: "failed", transferred: 0, size: f.size, error: "Declined by your contact" } as FileTransferState, "Declined"],
    ["cancelled", { state: "failed", transferred: 0, size: f.size, error: "Cancelled by the sender" } as FileTransferState, "Cancelled"],
    ["broken off, arriving here", { state: "failed", direction: "in", transferred: 0, size: f.size, error: "Connection lost" } as FileTransferState, "Did not arrive"],
    ["broken off, sent from here", { state: "failed", direction: "out", transferred: 0, size: f.size, error: "Connection lost" } as FileTransferState, "Not sent"],
    ["stuck", t({ stalled: true, rate: 12 * 1024 ** 2 }), "Not moving · 62% of 4.2 GB"],
    ["stuck, no connection: the connection is the reason", t({ stalled: true, stage: "waiting" }), "Waiting for connection · 62% done"],
  ])("%s", (_, transfer, text) => {
    expect(fileStatus(f, transfer, "Ana", false)).toBe(text);
  });
  it("a contact with no name is \"your contact\", in lower case mid-sentence", () => {
    expect(fileStatus(f, t({ stage: "paused", pausedBy: "peer" }), undefined, false)).toBe("Paused by your contact · 62% of 4.2 GB");
    expect(fileStatus(f, t({ stage: "asking", direction: "out", transferred: 0 }), undefined, false)).toBe("Waiting for your contact to accept · 4.2 GB");
    expect(fileStatus(f, t({ stage: "queued", direction: "out" }), undefined, false)).toBe("Queued by your contact · 62% done");
  });
  it("time left reads in minutes and hours", () => {
    expect(timeLeft(30)).toBe("less than a minute left");
    expect(timeLeft(125 * 60)).toBe("2 h 5 min left");
    expect(timeLeft(Infinity)).toBe("");
  });
});

describe("FileBubble: files/3", () => {
  it("an offer asks the person, with the room here, and answers through the engine", async () => {
    show({ state: "transferring", stage: "asking", direction: "in", transferred: 0, size: 4.2 * GB, room: 12 * GB });
    expect(screen.getByTestId("file-offer")).toHaveTextContent("Ana wants to send movie.mkv (4.2 GB).");
    expect(screen.getByTestId("file-room")).toHaveTextContent("12.0 GB free on this device");
    expect(screen.queryByTestId("file-progress")).toBeNull();
    fireEvent.click(screen.getByTestId("file-accept"));
    await waitFor(() => expect(fakeEngine.callsTo("fileAction")).toEqual([{ linkId: "chat1", fileId: "chat1-in-abc", action: "accept" }]));
    fireEvent.click(screen.getByTestId("file-decline"));
    await waitFor(() => expect(last(fakeEngine.callsTo("fileAction"))?.action).toBe("decline"));
  });

  it("a contact with no name: \"your contact\" mid-sentence, \"Your contact\" to start one", () => {
    fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: { "chat1-out-p": { state: "transferring", stage: "paused", pausedBy: "peer", direction: "out", transferred: GB, size: 4.2 * GB } } });
    const sent = renderApp(<FileBubble file={file({ id: "chat1-out-p" })} />);
    expect(screen.getByTestId("file-status")).toHaveTextContent("Paused by your contact · 23% of 4.2 GB");
    sent.unmount();
    fakeEngine.update({ transfers: { "chat1-in-abc": { state: "transferring", stage: "asking", direction: "in", transferred: 0, size: 4.2 * GB } } });
    renderApp(<FileBubble file={file()} />);
    expect(screen.getByTestId("file-offer")).toHaveTextContent("Your contact wants to send movie.mkv (4.2 GB).");
  });

  it("an offer larger than the room here cannot be accepted", () => {
    show({ state: "transferring", stage: "asking", direction: "in", transferred: 0, size: 4.2 * GB, room: 1 * GB });
    expect(screen.getByTestId("file-room")).toHaveTextContent("Not enough space: 1.0 GB free on this device");
    expect(screen.getByTestId("file-accept")).toBeDisabled();
  });

  it("a moving transfer pauses and cancels; paused here it resumes; paused by the contact it does not", async () => {
    const view = show({ state: "transferring", direction: "out", transferred: GB, size: 4.2 * GB, rate: 1024 ** 2 }, { id: "chat1-out-xyz" });
    fireEvent.click(screen.getByTestId("file-pause"));
    await waitFor(() => expect(last(fakeEngine.callsTo("fileAction"))).toEqual({ linkId: "chat1", fileId: "chat1-out-xyz", action: "pause" }));
    act(() => fakeEngine.update({ transfers: { "chat1-out-xyz": { state: "transferring", stage: "paused", pausedBy: "me", direction: "out", transferred: GB, size: 4.2 * GB } } }));
    expect(screen.queryByTestId("file-pause")).toBeNull();
    fireEvent.click(screen.getByTestId("file-resume"));
    await waitFor(() => expect(last(fakeEngine.callsTo("fileAction"))?.action).toBe("resume"));
    act(() => fakeEngine.update({ transfers: { "chat1-out-xyz": { state: "transferring", stage: "paused", pausedBy: "peer", direction: "out", transferred: GB, size: 4.2 * GB } } }));
    expect(screen.queryByTestId("file-resume")).toBeNull();
    fireEvent.click(screen.getByTestId("file-cancel"));
    await waitFor(() => expect(last(fakeEngine.callsTo("fileAction"))?.action).toBe("cancel"));
    view.unmount();
  });

  it("a stuck file sent from here offers Send again, a stuck one arriving here Ask again; a moving one neither", async () => {
    const sending = show({ state: "transferring", direction: "out", transferred: GB, size: 4.2 * GB, stalled: true }, { id: "chat1-out-stuck" });
    expect(screen.getByTestId("file-status")).toHaveTextContent("Not moving · 23% of 4.2 GB");
    expect(screen.queryByTestId("file-request")).toBeNull();
    expect(screen.getByTestId("file-resend")).toHaveAttribute("title", "Offers it again. It goes on from what your contact already has.");
    // A quiet ↻ in the icon's place, not a link under the bubble.
    expect(screen.getByTestId("file-resend")).toHaveAttribute("data-tone", "neutral");
    expect(screen.getByTestId("file-resend")).toHaveAccessibleName("Send again");
    fireEvent.click(screen.getByTestId("file-resend"));
    await waitFor(() => expect(last(fakeEngine.callsTo("fileAction"))).toEqual({ linkId: "chat1", fileId: "chat1-out-stuck", action: "resend" }));
    // Moving again: the button goes.
    act(() => fakeEngine.update({ transfers: { "chat1-out-stuck": { state: "transferring", direction: "out", transferred: 2 * GB, size: 4.2 * GB } } }));
    expect(screen.queryByTestId("file-resend")).toBeNull();
    sending.unmount();

    show({ state: "transferring", stage: "waiting", direction: "in", transferred: GB, size: 4.2 * GB, stalled: true });
    expect(screen.queryByTestId("file-resend")).toBeNull();
    fireEvent.click(screen.getByTestId("file-request"));
    await waitFor(() => expect(last(fakeEngine.callsTo("fileAction"))).toEqual({ linkId: "chat1", fileId: "chat1-in-abc", action: "request" }));
  });

  it("an offer or a pause is waiting for a person, not stuck: no Send again or Ask again", () => {
    const offer = show({ state: "transferring", stage: "asking", direction: "in", transferred: 0, size: 4.2 * GB });
    expect(screen.queryByTestId("file-request")).toBeNull();
    offer.unmount();
    show({ state: "transferring", stage: "paused", pausedBy: "peer", direction: "out", transferred: GB, size: 4.2 * GB }, { id: "chat1-out-p" });
    expect(screen.queryByTestId("file-resend")).toBeNull();
  });

  it("a declined or cancelled file cannot be sent again; a failed one can, from a round button where its icon was", async () => {
    let answer!: () => void;
    const retryFile = vi.spyOn(servicesPlatform!, "retryFile").mockImplementation(() => new Promise<void>((resolve) => { answer = resolve; }));
    const declined = show({ state: "failed", direction: "out", transferred: 0, size: 10, error: "Declined by your contact" }, { id: "chat1-out-1" });
    expect(screen.queryByTestId("file-retry")).toBeNull();
    expect(screen.getByTestId("file-status")).toHaveTextContent(/^Declined$/);
    declined.unmount();
    show({ state: "failed", direction: "out", transferred: 0, size: 10, error: "The file arrived damaged", retry: true }, { id: "chat1-out-2" });
    // Two words in the bubble; the engine's own behind the ⓘ.
    expect(screen.getByTestId("file-status")).toHaveTextContent(/^Not sent$/);
    expect(screen.queryByText("The file arrived damaged")).toBeNull();
    fireEvent.click(screen.getByTestId("file-why"));
    expect(screen.getByTestId("file-why-text")).toHaveTextContent("The file arrived damaged");
    const button = screen.getByTestId("file-retry");
    expect(button).toHaveAccessibleName("Send again");
    expect(button).toHaveAttribute("data-tone", "danger");
    fireEvent.click(button);
    expect(retryFile).toHaveBeenCalledWith("chat1-out-2");
    // The ring turns until the transfer moves.
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector("[data-busy]")).not.toBeNull();
    await act(async () => { answer(); });
    act(() => fakeEngine.update({ transfers: { "chat1-out-2": { state: "transferring", direction: "out", transferred: 2, size: 10 } } }));
    expect(screen.queryByTestId("file-retry")).toBeNull();
    expect(screen.getByTestId("file-progress")).toBeInTheDocument();
  });

  it("a resend that fails says why behind the ⓘ, and the button can be pressed again", async () => {
    vi.spyOn(servicesPlatform!, "retryFile").mockRejectedValue(new Error("No connection to your contact"));
    show({ state: "failed", direction: "out", transferred: 0, size: 10, error: "Connection lost", retry: true }, { id: "chat1-out-3" });
    fireEvent.click(screen.getByTestId("file-retry"));
    await waitFor(() => expect(screen.getByTestId("file-retry")).not.toHaveAttribute("aria-busy"));
    fireEvent.click(screen.getByTestId("file-why"));
    expect(screen.getByTestId("file-why-text")).toHaveTextContent("No connection to your contact");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a picture sent from here shows at once, and keeps its image while the transfer starts, moves and ends", async () => {
    const created: string[] = [], revoked: string[] = [];
    const { createObjectURL, revokeObjectURL } = URL;
    URL.createObjectURL = () => { const url = `blob:picture-${created.length}`; created.push(url); return url; };
    URL.revokeObjectURL = (url: string) => { revoked.push(url); };
    vi.mocked(servicesPlatform!.getFile).mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    try {
      const id = "chat1-out-pasted";
      const picture = { id, name: "Pasted image.png", size: 3, mime: "image/png" };
      // Already sending when the bubble appears: the sender's bytes are here, so the picture does not wait.
      fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: { [id]: { state: "transferring", direction: "out", transferred: 0, size: 3 } } });
      const view = renderApp(<FileBubble file={picture} peerName="Ana" />);
      const src = (await screen.findByRole("img", { name: "Pasted image.png" })).getAttribute("src");
      act(() => fakeEngine.update({ transfers: { [id]: { state: "transferring", direction: "out", transferred: 1, size: 3 } } }));
      act(() => fakeEngine.update({ transfers: { [id]: { state: "done", direction: "out", transferred: 3, size: 3 } } }));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      // The same URL all along, never revoked under the image (that showed WebKit's broken "?" until the end).
      expect(screen.getByRole("img", { name: "Pasted image.png" })).toHaveAttribute("src", src);
      expect(created).toEqual([src]);
      expect(revoked).toEqual([]);
      view.unmount();
      expect(revoked).toEqual([src]);
    } finally {
      Object.assign(URL, { createObjectURL, revokeObjectURL });
    }
  });

  it("a picture arriving here shows once it is all here, not from a part", async () => {
    vi.mocked(servicesPlatform!.getFile).mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    const { createObjectURL } = URL;
    URL.createObjectURL = () => "blob:arrived";
    try {
      show({ state: "transferring", direction: "in", transferred: 1, size: 3 }, { name: "photo.png", mime: "image/png", size: 3 });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(screen.queryByRole("img", { name: "photo.png" })).toBeNull();
      act(() => fakeEngine.update({ transfers: { "chat1-in-abc": { state: "done", direction: "in", transferred: 3, size: 3 } } }));
      expect(await screen.findByRole("img", { name: "photo.png" })).toHaveAttribute("src", "blob:arrived");
    } finally {
      URL.createObjectURL = createObjectURL;
    }
  });

  it("a file still arriving when the app starts is not offered to save once its transfer shows it moving", async () => {
    vi.mocked(servicesPlatform!.getFile).mockResolvedValue(new Blob(["part"], { type: "application/octet-stream" }));
    // Just started: the chat is drawn before its transfers are restored, and what is stored is a part of the file.
    show(null, { size: 80 });
    expect(await screen.findByTestId("file-save")).toBeInTheDocument();
    act(() => fakeEngine.update({ transfers: { "chat1-in-abc": { state: "transferring", direction: "in", transferred: 4, size: 80 } } }));
    expect(screen.queryByTestId("file-save")).toBeNull();
    expect(screen.getByTestId("file-cancel")).toBeInTheDocument();
    // All here: read again, and offered.
    vi.mocked(servicesPlatform!.getFile).mockResolvedValue(new Blob(["x".repeat(80)], { type: "application/octet-stream" }));
    act(() => fakeEngine.update({ transfers: { "chat1-in-abc": { state: "done", direction: "in", transferred: 80, size: 80 } } }));
    expect(await screen.findByTestId("file-save")).toBeInTheDocument();
    expect(vi.mocked(servicesPlatform!.getFile)).toHaveBeenCalledTimes(2);
  });

  it("a file kept but too large to show here is saved through the system (Desktop)", async () => {
    const saveFile = vi.fn(async () => true);
    Object.assign(servicesPlatform!, { saveFile });
    try {
      show({ state: "done", transferred: 4.2 * GB, size: 4.2 * GB });
      fireEvent.click(await screen.findByTestId("file-save"));
      expect(saveFile).toHaveBeenCalledWith("chat1-in-abc", "movie.mkv");
      expect(screen.getByTestId("file-status")).toHaveTextContent("4.2 GB");
    } finally { delete (servicesPlatform as { saveFile?: unknown }).saveFile; }
  });
});
