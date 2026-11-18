import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileBubble } from "../../components/FileBubble";
import { VideoBubble } from "../../components/video/VideoBubble";
import { servicesPlatform, type FileTransferState } from "../../lib/platform";
import type { Language } from "../../lib/settings";
import { saveSession } from "../../lib/storage";
import type { ChatFile } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { everythingOnScreen } from "../onScreen";
import { renderApp } from "../render";

// covers: files.large.offer

/**
 * An offer that does not fit beside the files already taken that are still coming: Accept's refusal said "wait for them
 * to arrive, or cancel one", and nothing said which files or which chats held the room. The bubble now lists them (the
 * file, its chat, what is still to come) with a Cancel for each, and the offer shows the list before Accept too.
 */

const MB = 1024 ** 2;
const OFFER = "chat1-in-offer";
const REFUSAL = "No room on this device for this file beside the files still coming (4.0 MB left of 40.0 MB free)";
const offer = (patch: Partial<ChatFile> = {}): ChatFile => ({ id: OFFER, name: "holiday.zip", size: 30 * MB, mime: "application/zip", ...patch });
const taken = (size: number, transferred: number, patch: Partial<FileTransferState> = {}): FileTransferState =>
  ({ state: "transferring", direction: "in", size, transferred, ...patch });

/** Chat 1 offers a 30 MB file; chat 2 (Bob) has two taken files still coming; other transfers hold no room. */
function world(offerPatch: Partial<FileTransferState> = {}) {
  saveSession({
    id: "chat2", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: "Ym9i", encKeyB64: "a2V5", createdAt: 1, nick: "Bob",
    messages: [
      { id: "m1", text: "", sender: "peer", timestamp: 1, file: { id: "chat2-in-big", name: "backup.iso", size: 25 * MB, mime: "application/octet-stream" } },
      { id: "m2", text: "", sender: "peer", timestamp: 2, file: { id: "chat2-in-paused", name: "song.flac", size: 10 * MB, mime: "audio/flac" } },
    ],
  });
  fakeEngine.update({
    links: [linkView({ id: "chat1", peerPubKeyZ32: "ana" }), linkView({ id: "chat2", peerPubKeyZ32: "bob" })],
    transfers: {
      [OFFER]: taken(30 * MB, 0, { stage: "asking", room: 4 * MB, ...offerPatch }),
      "chat2-in-big": taken(25 * MB, 1 * MB),
      "chat2-in-paused": taken(10 * MB, 4 * MB, { stage: "paused", pausedBy: "peer" }),
      // Not holding this device's room: one still asked about, one sent from here, one ended, a group's file.
      "chat2-in-asked": taken(50 * MB, 0, { stage: "asking" }),
      "chat2-out-sent": { state: "transferring", direction: "out", size: 70 * MB, transferred: 0 },
      "chat2-in-failed": { state: "failed", direction: "in", size: 80 * MB, transferred: 0, error: "Cancelled by the sender" },
      "group-g1-in-x": taken(90 * MB, 0),
    },
  });
}

const rows = () => screen.getAllByTestId("files-coming-row");

beforeEach(() => {
  everythingOnScreen();
  vi.spyOn(servicesPlatform!, "getFile").mockResolvedValue(null);
  fakeEngine.on("fileAction", ({ action }: { action: string }) => { if (action === "accept") throw new Error(REFUSAL); });
});
afterEach(() => vi.unstubAllGlobals());

describe("an offer refused for the files still coming names them", () => {
  it("Accept refused: each file still coming, its chat and what is left of it, largest first, with a Cancel", async () => {
    world();
    renderApp(<FileBubble file={offer()} peerName="Ana" />);
    fireEvent.click(screen.getByTestId("file-accept"));
    await waitFor(() => expect(rows()).toHaveLength(2));
    const list = screen.getByTestId("files-coming");
    expect(list).toHaveTextContent("These files you took are still coming and hold the room. Cancel one to make room:");
    expect(rows()[0]).toHaveTextContent("backup.iso from Bob: 24.0 MB still to come");
    expect(rows()[1]).toHaveTextContent("song.flac from Bob: 6.0 MB still to come");
    // Open at once after the refusal: no button to open it first.
    expect(screen.queryByTestId("files-coming-show")).toBeNull();
    // The refusal itself still says why, behind the ⓘ.
    fireEvent.click(screen.getByTestId("file-why"));
    expect(screen.getByTestId("file-why-text")).toHaveTextContent("No room beside the files still coming.");
  });

  it("Cancel on a row cancels that file in its own chat; the offer is only asked to be taken", async () => {
    world();
    renderApp(<FileBubble file={offer()} peerName="Ana" />);
    fireEvent.click(screen.getByTestId("file-accept"));
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(within(rows()[1]).getByRole("button", { name: "Cancel song.flac" }));
    await waitFor(() => expect(fakeEngine.callsTo("fileAction")).toHaveLength(2));
    // Nothing of chat 2 is said to chat 1's contact: chat 1 only got the Accept, chat 2 the Cancel.
    expect(fakeEngine.callsTo("fileAction")).toEqual([
      { linkId: "chat1", fileId: OFFER, action: "accept" },
      { linkId: "chat2", fileId: "chat2-in-paused", action: "cancel" },
    ]);
    // Arrived, cancelled: it leaves the list.
    act(() => fakeEngine.update({ transfers: { ...fakeEngine.state.transfers, "chat2-in-paused": { state: "failed", direction: "in", size: 10 * MB, transferred: 4 * MB, error: "You cancelled it" } } }));
    expect(rows()).toHaveLength(1);
  });

  it("an offer that shows it does not fit has the list behind a button before Accept; one that fits has none", () => {
    world();
    const view = renderApp(<FileBubble file={offer()} peerName="Ana" />);
    expect(screen.queryByTestId("files-coming-row")).toBeNull();
    const show = screen.getByTestId("files-coming-show");
    expect(show).toHaveTextContent("Files still coming (2)");
    expect(show).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(show);
    expect(show).toHaveAttribute("aria-expanded", "true");
    expect(rows()).toHaveLength(2);
    view.unmount();
    world({ room: 100 * MB });
    renderApp(<FileBubble file={offer()} peerName="Ana" />);
    expect(screen.queryByTestId("files-coming")).toBeNull();
  });

  it("with no name kept for a file or a chat, it still says which: a file, and the contact's key", async () => {
    world();
    act(() => fakeEngine.update({ links: [linkView({ id: "chat1" }), linkView({ id: "chat3", peerPubKeyZ32: "carolkey" })], transfers: { [OFFER]: taken(30 * MB, 0, { stage: "asking", room: 4 * MB }), "chat3-in-x": taken(8 * MB, 0) } }));
    renderApp(<FileBubble file={offer()} peerName="Ana" />);
    fireEvent.click(screen.getByTestId("file-accept"));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent("A file from Contact · carolk: 8.0 MB still to come");
  });

  it.each<[Language, string, string]>([
    ["en", "backup.iso from Bob: 24.0 MB still to come", "Cancel backup.iso"],
    ["ar", "backup.iso من Bob: يتبقى 24.0 م.ب", "إلغاء backup.iso"],
  ])("%s: the file's and the chat's names are each isolated in the translated sentence", async (language, said, cancel) => {
    world();
    renderApp(<FileBubble file={offer()} peerName="Ana" />, { language });
    fireEvent.click(screen.getByTestId("file-accept"));
    await waitFor(() => expect(rows()).toHaveLength(2));
    const line = rows()[0].querySelector("span")!;
    expect(line.textContent).toBe(said);
    // Each name its own <bdi>: a Latin name in an Arabic sentence keeps its punctuation on its side.
    expect([...line.querySelectorAll("bdi")].map((bdi) => bdi.textContent)).toEqual(["backup.iso", "Bob"]);
    expect(within(rows()[0]).getByRole("button", { name: cancel })).toBeInTheDocument();
  });

  it("a video offer refused the same way lists them too", async () => {
    world();
    renderApp(<VideoBubble file={offer({ name: "clip.mp4", mime: "video/mp4" })} sender="peer" peerName="Ana" />);
    fireEvent.click(screen.getByTestId("video-accept"));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[0]).toHaveTextContent("backup.iso from Bob: 24.0 MB still to come");
  });
});
