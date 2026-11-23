import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileBubble } from "../../components/FileBubble";
import { AudioBubble } from "../../components/audio/AudioBubble";
import { VideoBubble } from "../../components/video/VideoBubble";
import { servicesPlatform, type FileTransferState } from "../../lib/platform";
import { saveSession } from "../../lib/storage";
import type { ChatFile } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { everythingOnScreen } from "../onScreen";
import { renderApp } from "../render";

// covers: files.large.offer

/**
 * Accept refused for the files still coming shows the refusal behind a red ⓘ and lists those files, each with a
 * Cancel. Once none of them is left (cancelled, or arrived), the list went but the red ⓘ kept saying there was no room
 * until Accept was pressed again. The refusal is now dropped with the list, in the file, video and voice-note bubbles;
 * any other refusal stays until the next action, and the focus that was in the list or on the ⓘ lands on Accept.
 */

const MB = 1024 ** 2;
const OFFER = "chat1-in-offer";
const REFUSAL = "No room on this device for this file beside the files still coming (4.0 MB left of 40.0 MB free)";
const taken = (size: number, transferred: number, patch: Partial<FileTransferState> = {}): FileTransferState =>
  ({ state: "transferring", direction: "in", size, transferred, ...patch });

const bubbles: [string, (file: ChatFile) => ReactElement, Partial<ChatFile>][] = [
  ["file", (file) => <FileBubble file={file} peerName="Ana" />, { name: "holiday.zip", mime: "application/zip" }],
  ["video", (file) => <VideoBubble file={file} sender="peer" peerName="Ana" />, { name: "clip.mp4", mime: "video/mp4" }],
  ["audio", (file) => <AudioBubble file={file} sender="peer" peerName="Ana" />, { name: "talk.mp3", mime: "audio/mpeg" }],
];

/** Chat 1 offers a 30 MB file; chat 2 (Bob) has two taken files still coming. */
function world() {
  saveSession({
    id: "chat2", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: "Ym9i", encKeyB64: "a2V5", createdAt: 1, nick: "Bob",
    messages: [
      { id: "m1", text: "", sender: "peer", timestamp: 1, file: { id: "chat2-in-big", name: "backup.iso", size: 25 * MB, mime: "application/octet-stream" } },
      { id: "m2", text: "", sender: "peer", timestamp: 2, file: { id: "chat2-in-song", name: "song.flac", size: 10 * MB, mime: "audio/flac" } },
    ],
  });
  fakeEngine.update({
    links: [linkView({ id: "chat1", peerPubKeyZ32: "ana" }), linkView({ id: "chat2", peerPubKeyZ32: "bob" })],
    transfers: {
      [OFFER]: taken(30 * MB, 0, { stage: "asking", room: 4 * MB }),
      "chat2-in-big": taken(25 * MB, 1 * MB),
      "chat2-in-song": taken(10 * MB, 4 * MB),
    },
  });
}

/** A file still coming ends: cancelled here, or all arrived. */
const ended = (fileId: string, how: "cancelled" | "arrived") => fakeEngine.update({
  transfers: {
    ...fakeEngine.state.transfers,
    [fileId]: how === "arrived" ? { state: "done", direction: "in", size: 10 * MB, transferred: 10 * MB } : { state: "failed", direction: "in", size: 10 * MB, transferred: 4 * MB, error: "You cancelled it" },
  },
});

let refusal = REFUSAL;
beforeEach(() => {
  everythingOnScreen();
  refusal = REFUSAL;
  vi.spyOn(servicesPlatform!, "getFile").mockResolvedValue(null);
  fakeEngine.on("fileAction", ({ action }: { action: string }) => { if (action === "accept" && refusal) throw new Error(refusal); });
});
afterEach(() => vi.unstubAllGlobals());

async function refused(kind: string, show: (file: ChatFile) => ReactElement, patch: Partial<ChatFile>) {
  world();
  renderApp(show({ id: OFFER, size: 30 * MB, ...patch } as ChatFile));
  fireEvent.click(screen.getByTestId(`${kind}-accept`));
  await waitFor(() => expect(screen.getByTestId(`${kind}-why`)).toBeInTheDocument());
}

describe.each(bubbles)("%s bubble: the no-room refusal goes with the files still coming that held the room", (kind, show, patch) => {
  it("stays while one is left, and goes once the last is cancelled or arrives: the offer reads as one to Accept", async () => {
    await refused(kind, show, patch);
    expect(screen.getAllByTestId("files-coming-row")).toHaveLength(2);
    act(() => ended("chat2-in-song", "cancelled"));
    // One still holds the room: the refusal and its list stay.
    expect(screen.getAllByTestId("files-coming-row")).toHaveLength(1);
    expect(screen.getByTestId(`${kind}-why`)).toBeInTheDocument();
    act(() => ended("chat2-in-big", "arrived"));
    expect(screen.queryByTestId("files-coming")).toBeNull();
    expect(screen.queryByTestId(`${kind}-why`)).toBeNull();
    expect(screen.queryByText(/No room beside the files still coming/)).toBeNull();
    expect(screen.getByTestId(`${kind}-accept`)).toBeEnabled();
    // Accept again asks the engine again, as any offer's would.
    refusal = "";
    fireEvent.click(screen.getByTestId(`${kind}-accept`));
    await waitFor(() => expect(fakeEngine.callsTo("fileAction").filter((call) => call.action === "accept")).toHaveLength(2));
  });

  it("another refusal stays when the files still coming end", async () => {
    refusal = "No connection to your contact";
    await refused(kind, show, patch);
    act(() => { ended("chat2-in-song", "cancelled"); ended("chat2-in-big", "cancelled"); });
    expect(screen.getByTestId(`${kind}-why`)).toBeInTheDocument();
  });

  it("the focus on the last Cancel in the list lands on Accept, not on the page", async () => {
    await refused(kind, show, patch);
    act(() => ended("chat2-in-song", "arrived"));
    const cancel = within(screen.getByTestId("files-coming-row")).getByRole("button", { name: "Cancel backup.iso" });
    cancel.focus();
    expect(cancel).toHaveFocus();
    act(() => {
      ended("chat2-in-big", "cancelled");
      fireEvent.focusOut(cancel);
    });
    expect(screen.queryByTestId("files-coming")).toBeNull();
    expect(screen.getByTestId(`${kind}-accept`)).toHaveFocus();
  });

  it("the focus on the red ⓘ lands on Accept once the refusal goes", async () => {
    await refused(kind, show, patch);
    const why = screen.getByTestId(`${kind}-why`);
    why.focus();
    fireEvent.click(why);
    expect(screen.getByTestId(`${kind}-why-text`)).toHaveTextContent("No room beside the files still coming.");
    act(() => {
      ended("chat2-in-song", "cancelled");
      ended("chat2-in-big", "cancelled");
      fireEvent.focusOut(why);
    });
    expect(screen.queryByTestId(`${kind}-why`)).toBeNull();
    expect(screen.queryByTestId(`${kind}-why-text`)).toBeNull();
    expect(screen.getByTestId(`${kind}-accept`)).toHaveFocus();
  });
});
