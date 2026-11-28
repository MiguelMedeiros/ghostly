import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceMeta } from "@ghostly/core";
import { VoiceBubble } from "../../components/voice/VoiceBubble";
import type { FileTransferState } from "../../lib/platform";
import { saveSession } from "../../lib/storage";
import type { ChatFile } from "../../lib/types";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { everythingOnScreen } from "../onScreen";
import { renderApp } from "../render";
import { installFakeAudio } from "./fakeMedia";

// covers: files.large.offer

/**
 * A 1:1 voice note the engine asks about that does not fit beside the files still coming: as the file, video and
 * audio-file offers, it lists those files (which file, which chat, what is left) with a Cancel for each, behind a
 * button while the room it shows is short, open at once once Download is refused for them. Before, the voice note
 * showed only "Not enough space" and, after Download, the refusal behind its ⓘ.
 */

const MB = 1024 ** 2;
const OFFER = "chat1-in-note";
const GROUP_OFFER = "group-g1-in-note";
const REFUSAL = "No room on this device for this file beside the files still coming (4.0 MB left of 40.0 MB free)";
const peaks = Array.from({ length: 64 }, (_, i) => (i * 37) % 256);
const note = (id = OFFER): ChatFile & { voice: VoiceMeta } => ({ id, name: "Voice message.wav", size: 8 * MB, mime: "audio/wav", voice: { duration: 600_000, peaks } });
const taken = (size: number, transferred: number, patch: Partial<FileTransferState> = {}): FileTransferState =>
  ({ state: "transferring", direction: "in", size, transferred, ...patch });

/** Chat 1 (Ana) offers an 8 MB voice note with 4 MB of room shown; chat 2 (Bob) has a 25 MB file still coming. */
function world() {
  saveSession({
    id: "5e4c22ff", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: "bob", encKeyB64: "a2V5", createdAt: 1, nick: "Bob",
    messages: [{ id: "m1", text: "", sender: "peer", timestamp: 1, file: { id: "chat2-in-big", name: "backup.iso", size: 25 * MB, mime: "application/octet-stream" } }],
  });
  fakeEngine.update({
    links: [linkView({ id: "chat1", peerPubKeyZ32: "ana" }), linkView({ id: "chat2", peerPubKeyZ32: "bob" })],
    groups: [groupView({ id: "g1" })],
    transfers: {
      [OFFER]: taken(8 * MB, 0, { stage: "asking", room: 4 * MB }),
      [GROUP_OFFER]: taken(8 * MB, 0, { stage: "asking", room: 4 * MB }),
      "chat2-in-big": taken(25 * MB, 1 * MB),
    },
  });
}

const rows = () => screen.getAllByTestId("files-coming-row");
const show = (id = OFFER) => renderApp(<VoiceBubble file={note(id)} sender="peer" peerName="Ana" timestamp={1_700_000_000_000} />);

beforeEach(() => {
  everythingOnScreen();
  installFakeAudio();
  fakeEngine.on("fileAction", ({ action }: { action: string }) => { if (action === "accept") throw new Error(REFUSAL); });
});
afterEach(() => vi.restoreAllMocks());

describe("a 1:1 voice note offered beside the files still coming lists them, as an audio file's offer does", () => {
  it("while the room shown is short: the list behind a button", () => {
    world();
    show();
    expect(screen.getByTestId("voice-room")).toHaveTextContent("4.0 MB left");
    expect(screen.queryByTestId("files-coming-row")).toBeNull();
    const button = screen.getByTestId("files-coming-show");
    expect(button).toHaveTextContent("Files still coming (1)");
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("backup.iso from Bob: 24.0 MB still to come");
  });

  it("Download refused for the files still coming: the list open at once, beside the refusal's ⓘ", async () => {
    world();
    show();
    fireEvent.click(screen.getByTestId("voice-download"));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByTestId("files-coming-show")).toBeNull();
    expect(screen.getByTestId("voice-why")).toBeInTheDocument();
  });

  it("the last row's Cancel: the refusal goes with the list, and the focus lands on Download", async () => {
    world();
    show();
    fireEvent.click(screen.getByTestId("voice-download"));
    await waitFor(() => expect(rows()).toHaveLength(1));
    const cancel = within(rows()[0]).getByRole("button", { name: "Cancel backup.iso" });
    cancel.focus();
    fireEvent.click(cancel);
    await waitFor(() => expect(fakeEngine.callsTo("fileAction")).toContainEqual({ linkId: "chat2", fileId: "chat2-in-big", action: "cancel" }));
    act(() => fakeEngine.update({ transfers: { ...fakeEngine.state.transfers, "chat2-in-big": { state: "failed", direction: "in", size: 25 * MB, transferred: MB, error: "You cancelled it" } } }));
    expect(screen.queryByTestId("files-coming")).toBeNull();
    expect(screen.queryByTestId("voice-why")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("voice-download")));
  });

  it("a group's voice note lists none, before or after Download", async () => {
    world();
    show(GROUP_OFFER);
    expect(screen.getByTestId("voice-room")).toHaveTextContent("4.0 MB left");
    expect(screen.queryByTestId("files-coming")).toBeNull();
    fireEvent.click(screen.getByTestId("voice-download"));
    await waitFor(() => expect(fakeEngine.callsTo("fileAction")).toContainEqual({ linkId: "group:g1", fileId: GROUP_OFFER, action: "accept" }));
    await act(async () => {});
    expect(screen.queryByTestId("files-coming")).toBeNull();
  });
});
