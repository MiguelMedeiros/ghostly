import { screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AudioBubble } from "../../components/audio/AudioBubble";
import { FileBubble } from "../../components/FileBubble";
import { VideoBubble } from "../../components/video/VideoBubble";
import { VoiceBubble } from "../../components/voice/VoiceBubble";
import { servicesPlatform, type FileTransferState } from "../../lib/platform";
import type { ChatFile } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { everythingOnScreen } from "../onScreen";
import { renderApp } from "../render";

// covers: app.accessibility, app.mobile-layout

/**
 * On a 375 px phone at 200% text a file offer's Accept and Decline sat in one row that did not wrap: Decline ran 43 px
 * out of the bubble. The rows of a file's, a song's, a video's and a voice message's buttons (Accept/Download and
 * Decline, Pause/Resume and Cancel) wrap, the second button under the first once both no longer fit.
 */
const MB = 1024 ** 2;
const asking = (size: number): FileTransferState => ({ state: "transferring", stage: "asking", direction: "in", transferred: 0, size });
const moving = (size: number, patch: Partial<FileTransferState> = {}): FileTransferState => ({ state: "transferring", direction: "in", transferred: size / 3, size, ...patch });
type Kind = { file: ChatFile; draw: (file: ChatFile) => ReactElement; prefix: string; transfer: string };
const kinds: Record<"file" | "audio" | "video" | "voice", Kind> = {
  file: { file: { id: "chat1-in-zip", name: "photos.zip", size: 30 * MB, mime: "application/zip" }, draw: (file) => <FileBubble file={file} peerName="Ana" />, prefix: "file", transfer: "" },
  audio: { file: { id: "chat1-in-song", name: "Ghost Town.mp3", size: 40 * MB, mime: "audio/mpeg" }, draw: (file) => <AudioBubble file={file} sender="peer" peerName="Ana" />, prefix: "audio", transfer: "-transfer" },
  video: { file: { id: "chat1-in-video", name: "ghosts.mp4", size: 35 * MB, mime: "video/mp4", video: { duration: 12_000, width: 1280, height: 720 } }, draw: (file) => <VideoBubble file={file} sender="peer" peerName="Ana" />, prefix: "video", transfer: "-transfer" },
  voice: { file: { id: "chat1-in-voice", name: "Voice message.webm", size: 2 * MB, mime: "audio/webm", voice: { duration: 3_000, peaks: [] } }, draw: (file) => <VoiceBubble file={{ ...file, voice: file.voice! }} sender="peer" peerName="Ana" timestamp={Date.now()} />, prefix: "voice", transfer: "-transfer" },
};

function show({ file, draw }: Kind, transfer: FileTransferState) {
  fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: { [file.id]: transfer } });
  return renderApp(draw(file));
}

/** The buttons share one parent row, and it wraps. */
function wrapsTogether(...ids: string[]) {
  const rows = new Set(ids.map((id) => screen.getByTestId(id).parentElement!));
  expect(rows.size, ids.join(" and ")).toBe(1);
  expect([...rows][0], ids.join(" and ")).toHaveClass("flex", "flex-wrap");
}

beforeEach(() => {
  everythingOnScreen();
  vi.spyOn(servicesPlatform!, "getFile").mockResolvedValue(null);
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
});

describe("a media bubble's row of buttons wraps at a larger text size", () => {
  it.each(["file", "audio", "voice"] as const)("the %s offer: Accept and Decline", (kind) => {
    const { file, prefix } = kinds[kind];
    show(kinds[kind], asking(file.size));
    wrapsTogether(kind === "voice" ? "voice-download" : `${prefix}-accept`, `${prefix}-decline`);
  });

  it.each(["file", "audio", "video", "voice"] as const)("the %s on its way: Pause and Cancel; paused here, Resume and Cancel", (kind) => {
    const { file, prefix, transfer } = kinds[kind];
    const { unmount } = show(kinds[kind], moving(file.size));
    wrapsTogether(`${prefix}-pause${transfer}`, `${prefix}-cancel`);
    unmount();
    show(kinds[kind], moving(file.size, { stage: "paused", pausedBy: "me" }));
    wrapsTogether(`${prefix}-resume${transfer}`, `${prefix}-cancel`);
  });
});
