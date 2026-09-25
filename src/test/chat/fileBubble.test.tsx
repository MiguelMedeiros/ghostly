import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileBubble } from "../../components/FileBubble";
import { fileStatus, timeLeft } from "../../lib/fileStatus";
import { servicesPlatform, type FileTransferState } from "../../lib/platform";
import type { ChatFile } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: files.large.offer, files.large.resume, files.size-label

const GB = 1024 ** 3;
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
    ["declined", { state: "failed", transferred: 0, size: f.size, error: "Declined by your contact" } as FileTransferState, "Failed: Declined by your contact"],
  ])("%s", (_, transfer, text) => {
    expect(fileStatus(f, transfer, "Ana", false)).toBe(text);
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
    await waitFor(() => expect(fakeEngine.callsTo("fileAction").at(-1)?.action).toBe("decline"));
  });

  it("an offer larger than the room here cannot be accepted", () => {
    show({ state: "transferring", stage: "asking", direction: "in", transferred: 0, size: 4.2 * GB, room: 1 * GB });
    expect(screen.getByTestId("file-room")).toHaveTextContent("Not enough space: 1.0 GB free on this device");
    expect(screen.getByTestId("file-accept")).toBeDisabled();
  });

  it("a moving transfer pauses and cancels; paused here it resumes; paused by the contact it does not", async () => {
    const view = show({ state: "transferring", direction: "out", transferred: GB, size: 4.2 * GB, rate: 1024 ** 2 }, { id: "chat1-out-xyz" });
    fireEvent.click(screen.getByTestId("file-pause"));
    await waitFor(() => expect(fakeEngine.callsTo("fileAction").at(-1)).toEqual({ linkId: "chat1", fileId: "chat1-out-xyz", action: "pause" }));
    act(() => fakeEngine.update({ transfers: { "chat1-out-xyz": { state: "transferring", stage: "paused", pausedBy: "me", direction: "out", transferred: GB, size: 4.2 * GB } } }));
    expect(screen.queryByTestId("file-pause")).toBeNull();
    fireEvent.click(screen.getByTestId("file-resume"));
    await waitFor(() => expect(fakeEngine.callsTo("fileAction").at(-1)?.action).toBe("resume"));
    act(() => fakeEngine.update({ transfers: { "chat1-out-xyz": { state: "transferring", stage: "paused", pausedBy: "peer", direction: "out", transferred: GB, size: 4.2 * GB } } }));
    expect(screen.queryByTestId("file-resume")).toBeNull();
    fireEvent.click(screen.getByTestId("file-cancel"));
    await waitFor(() => expect(fakeEngine.callsTo("fileAction").at(-1)?.action).toBe("cancel"));
    view.unmount();
  });

  it("a declined or cancelled file cannot be sent again; a failed one can", () => {
    const retryFile = vi.spyOn(servicesPlatform!, "retryFile").mockResolvedValue();
    const declined = show({ state: "failed", direction: "out", transferred: 0, size: 10, error: "Declined by your contact" }, { id: "chat1-out-1" });
    expect(screen.queryByText("Retry sending")).toBeNull();
    declined.unmount();
    show({ state: "failed", direction: "out", transferred: 0, size: 10, error: "The file arrived damaged", retry: true }, { id: "chat1-out-2" });
    fireEvent.click(screen.getByText("Retry sending"));
    expect(retryFile).toHaveBeenCalledWith("chat1-out-2");
  });

  it("a file kept but too large to show here is saved through the system (Desktop)", async () => {
    const saveFile = vi.fn(async () => true);
    Object.assign(servicesPlatform!, { saveFile });
    try {
      show({ state: "done", transferred: 4.2 * GB, size: 4.2 * GB });
      fireEvent.click(await screen.findByTestId("file-save"));
      expect(saveFile).toHaveBeenCalledWith("chat1-in-abc");
      expect(screen.getByTestId("file-status")).toHaveTextContent("4.2 GB");
    } finally { delete (servicesPlatform as { saveFile?: unknown }).saveFile; }
  });
});
