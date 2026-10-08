// happy-dom has no IndexedDB: the file store keeps what is sent in this one.
import "fake-indexeddb/auto";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GROUP_FILE_LIMITS } from "@ghostly/core";
import type { FileTransferView, GroupMemberView, GroupView, MessageFile, StoredMessage } from "@ghostly/browser/shared/types";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";
import { installFakeAudio, installFakeMedia, removeFakeMedia } from "../voice/fakeMedia";

// covers: groups.files.compose, groups.files.bubbles, groups.files

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y"), BOB = "bob".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const group = (patch: Partial<GroupView> = {}): GroupView => groupView({ status: "active", epoch: 1,
  members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice", role: "admin" }), member({ key: BOB, nick: "Bob" })], ...patch });
const stored = (patch: Partial<StoredMessage>): StoredMessage => ({ linkId: "group:group-1", id: "g1", text: "", sender: "peer", timestamp: 1_700_000_000_000, via: "datalink", ...patch });

const LUNCH = `${ALICE}:1:0`;
const REPORT: MessageFile = { id: "group-group-1-in-report", name: "report.pdf", size: 2_400_000, mime: "application/pdf" };
const PHOTO: MessageFile = { id: "group-group-1-in-photo", name: "beach.jpg", size: 900_000, mime: "image/jpeg", image: { width: 1200, height: 800 } };
const VOICE: MessageFile = { id: "group-group-1-in-voice", name: "voice.webm", size: 40_000, mime: "audio/webm", voice: { duration: 42_000, peaks: Array(48).fill(90) } };
const CLIP: MessageFile = { id: "group-group-1-in-clip", name: "clip.mp4", size: 20_000_000, mime: "video/mp4", video: { duration: 12_000, width: 640, height: 360 } };
const MINE: MessageFile = { id: "group-group-1-out-mine", name: "notes.txt", size: 12, mime: "text/plain" };

const history = [
  stored({ id: LUNCH, text: "lunch at noon?", member: ALICE }),
  stored({ id: `${ALICE}:1:1`, text: "📎 report.pdf", member: ALICE, file: REPORT, timestamp: 1_700_000_001_000 }),
  stored({ id: `${BOB}:1:0`, text: "📷 beach.jpg", member: BOB, file: PHOTO, timestamp: 1_700_000_002_000 }),
  stored({ id: `${BOB}:1:1`, text: "🎤 Voice message", member: BOB, file: VOICE, timestamp: 1_700_000_003_000 }),
  stored({ id: `${ALICE}:1:2`, text: "🎬 clip.mp4", member: ALICE, file: CLIP, timestamp: 1_700_000_004_000 }),
  stored({ id: `${ME}:1:0`, text: "📎 notes.txt", sender: "me", member: ME, file: MINE, timestamp: 1_700_000_005_000 }),
];

const offered = (file: MessageFile): FileTransferView => ({ state: "transferring", stage: "asking", transferred: 0, size: file.size, direction: "in" });

function openGroup(transfers: Record<string, FileTransferView> = {}, patch: Partial<GroupView> = {}) {
  fakeEngine.on("groupMessages", () => history).on("updateSettings", () => undefined).on("sendGroupMessage", () => ({ error: null }))
    .on("sendGroupFile", () => ({ error: null, messageId: `${ME}:1:9` })).on("fileAction", () => undefined);
  fakeEngine.update({ groups: [group(patch)], transfers });
  return renderApp(<Routes>
    <Route path="/" element={<p>Chat list</p>} />
    <Route path="/group/:groupId" element={<GroupChat />} />
  </Routes>, { route: "/group/group-1" });
}
const row = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!;
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const touch = { pointerId: 1, pointerType: "touch", button: 0, clientX: 300, clientY: 500 };

describe("the composer of a group takes files and voice messages", () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); installFakeMedia(); installFakeAudio(); });
  afterEach(() => { vi.useRealTimers(); removeFakeMedia(); vi.restoreAllMocks(); });

  it("+ → Document announces the file in the group: its bytes kept here first, under the group's own file id", async () => {
    const { engine } = openGroup();
    await screen.findByText("lunch at noon?");
    fireEvent.change(screen.getByTestId("file-input"), { target: { files: [new File(["one"], "one.txt", { type: "text/plain" })] } });
    await vi.waitFor(() => expect(engine.callsTo("sendGroupFile")).toHaveLength(1));
    const [sent] = engine.callsTo("sendGroupFile");
    expect(sent).toMatchObject({ groupId: "group-1", file: { name: "one.txt", size: 3, mime: "text/plain" } });
    expect(sent!.file.id).toMatch(/^group-group-1-out-/);
    expect(sent!.replyTo).toBeUndefined();
  });

  it("in a community too, and a reply goes with the file", async () => {
    const { engine } = openGroup({}, { profile: "community" });
    await screen.findByText("lunch at noon?");
    fireEvent.click(within(row(LUNCH)).getByTestId("message-reply-action"));
    await wait(0);
    fireEvent.change(screen.getByTestId("file-input"), { target: { files: [new File(["a"], "a.txt", { type: "text/plain" }), new File(["b"], "b.txt", { type: "text/plain" })] } });
    await vi.waitFor(() => expect(engine.callsTo("sendGroupFile").map(c => [c.file.name, c.replyTo])).toEqual([["a.txt", LUNCH], ["b.txt", undefined]]));
    expect(screen.queryByTestId("composer-reply")).not.toBeInTheDocument();
  });

  it("a voice message recorded in the group goes as one", async () => {
    const { engine } = openGroup();
    await screen.findByText("lunch at noon?");
    fireEvent.pointerDown(screen.getByTestId("voice-record"), touch);
    await wait(0);
    await wait(2_000);
    fireEvent.pointerUp(screen.getByTestId("voice-record"), touch);
    await vi.waitFor(() => expect(engine.callsTo("sendGroupFile")).toHaveLength(1));
    expect(engine.callsTo("sendGroupFile")[0]!.file.voice).toBeTruthy();
  });

  it("a file over the group's limit is refused here, with the limit, and nothing is announced", async () => {
    const { engine } = openGroup();
    await screen.findByText("lunch at noon?");
    const big = new File(["x"], "huge.iso", { type: "application/octet-stream" });
    Object.defineProperty(big, "size", { value: GROUP_FILE_LIMITS.maxBytes + 1 });
    fireEvent.change(screen.getByTestId("file-input"), { target: { files: [big] } });
    expect(await screen.findByText("That file is too large (max 100.0 MB).")).toBeInTheDocument();
    expect(engine.callsTo("sendGroupFile")).toEqual([]);
  });

  it("what the group refuses is said with its next step", async () => {
    const { engine } = openGroup();
    engine.on("sendGroupFile", () => ({ error: "You sent many files to this group just now. Wait a minute." }));
    await screen.findByText("lunch at noon?");
    fireEvent.change(screen.getByTestId("file-input"), { target: { files: [new File(["one"], "one.txt", { type: "text/plain" })] } });
    expect(await screen.findByText("You sent many files to this group just now. Wait a minute, then send it again.")).toBeInTheDocument();
  });
});

describe("a group's file bubbles", () => {
  it("a file not downloaded: its name, size and Download; Download asks the group for it", async () => {
    const { user, engine } = openGroup({ [REPORT.id]: offered(REPORT) });
    const bubble = await vi.waitFor(() => within(row(`${ALICE}:1:1`)).getByTestId("file-bubble"));
    expect(within(bubble).getByText("report.pdf")).toBeInTheDocument();
    expect(within(bubble).getByTestId("file-status")).toHaveTextContent("2.3 MB · not downloaded");
    // Never declined, paused or cancelled: a member's copy is fetched or not.
    expect(within(bubble).queryByTestId("file-decline")).toBeNull();
    expect(within(bubble).queryByText(/wants to send/)).toBeNull();
    await user.click(within(bubble).getByTestId("file-accept"));
    expect(within(bubble).getByTestId("file-accept")).toHaveTextContent("Download 2.3 MB");
    expect(engine.callsTo("fileAction")).toEqual([{ linkId: "group:group-1", fileId: REPORT.id, action: "accept" }]);
  });

  it("downloading: how far, with no pause or cancel", async () => {
    openGroup({ [REPORT.id]: { state: "transferring", transferred: 1_200_000, size: REPORT.size, direction: "in" } });
    const bubble = await vi.waitFor(() => within(row(`${ALICE}:1:1`)).getByTestId("file-bubble"));
    expect(within(bubble).getByTestId("file-status")).toHaveTextContent("50% of 2.3 MB");
    expect(within(bubble).getByTestId("file-progress")).toBeInTheDocument();
    expect(within(bubble).queryByTestId("file-pause")).toBeNull();
    expect(within(bubble).queryByTestId("file-cancel")).toBeNull();
  });

  it("asked from a member: says so", async () => {
    openGroup({ [REPORT.id]: { state: "transferring", stage: "queued", transferred: 0, size: REPORT.size, direction: "in" } });
    const bubble = await vi.waitFor(() => within(row(`${ALICE}:1:1`)).getByTestId("file-bubble"));
    expect(within(bubble).getByTestId("file-status")).toHaveTextContent("Asking a member who has it…");
  });

  it("nobody connected has it: said, and what happens next behind the ⓘ", async () => {
    const { user } = openGroup({ [REPORT.id]: { state: "transferring", stage: "waiting", transferred: 0, size: REPORT.size, direction: "in", note: "Nobody you are connected to has this file yet" } });
    const bubble = await vi.waitFor(() => within(row(`${ALICE}:1:1`)).getByTestId("file-bubble"));
    expect(within(bubble).getByTestId("file-status")).toHaveTextContent("Nobody you are connected to has this file yet");
    await user.click(within(bubble).getByTestId("file-why"));
    expect(within(bubble).getByTestId("file-why-text")).toHaveTextContent("It comes by itself when a member who has it is online.");
  });

  it("a Download that cannot start: a short title in the bubble's ⓘ, with the next step", async () => {
    const { user, engine } = openGroup({ [REPORT.id]: offered(REPORT) });
    engine.on("fileAction", () => { throw new Error("Not enough space on this device for this file"); });
    const bubble = await vi.waitFor(() => within(row(`${ALICE}:1:1`)).getByTestId("file-bubble"));
    await user.click(within(bubble).getByTestId("file-accept"));
    await user.click(await within(bubble).findByTestId("file-why"));
    expect(within(bubble).getByTestId("file-why-text")).toHaveTextContent("Not enough space on this device for this file. Free some space, then download it again.");
  });

  it("done: nothing to answer", async () => {
    openGroup({ [REPORT.id]: { state: "done", transferred: REPORT.size, size: REPORT.size, direction: "in" } });
    const bubble = await vi.waitFor(() => within(row(`${ALICE}:1:1`)).getByTestId("file-bubble"));
    expect(bubble).toHaveAttribute("data-stage", "done");
    expect(within(bubble).queryByTestId("file-accept")).toBeNull();
    expect(within(bubble).queryByTestId("file-progress")).toBeNull();
  });

  it("each under its sender's name, as a text; a picture not downloaded keeps no box, a voice message and a video have their Download", async () => {
    const { user, engine } = openGroup({ [PHOTO.id]: offered(PHOTO), [VOICE.id]: offered(VOICE), [CLIP.id]: offered(CLIP) });
    const photo = await vi.waitFor(() => within(row(`${BOB}:1:0`)).getByTestId("file-bubble"));
    expect(within(row(`${BOB}:1:0`)).getByTestId("message-nick")).toHaveTextContent("Bob");
    expect(within(photo).queryByTestId("file-picture")).toBeNull();
    expect(within(photo).getByTestId("file-accept")).toHaveTextContent("Download");

    const voice = within(row(`${BOB}:1:1`)).getByTestId("voice-bubble");
    expect(within(voice).getByTestId("voice-status")).toHaveTextContent("not downloaded");
    await user.click(within(voice).getByTestId("voice-download"));

    expect(within(row(`${ALICE}:1:2`)).getByTestId("message-nick")).toHaveTextContent("Alice");
    const clip = within(row(`${ALICE}:1:2`)).getByTestId("video-bubble");
    expect(within(clip).queryByTestId("video-decline")).toBeNull();
    await user.click(within(clip).getByTestId("video-accept"));
    expect(engine.callsTo("fileAction").map(c => [c.fileId, c.action])).toEqual([[VOICE.id, "accept"], [CLIP.id, "accept"]]);
  });

  it("my own file: here from the start, no Download, no Send again", async () => {
    openGroup({ [MINE.id]: { state: "done", transferred: MINE.size, size: MINE.size, direction: "out" } });
    const bubble = await vi.waitFor(() => within(row(`${ME}:1:0`)).getByTestId("file-bubble"));
    expect(within(bubble).queryByTestId("file-accept")).toBeNull();
    expect(within(bubble).queryByTestId("file-retry")).toBeNull();
  });
});
