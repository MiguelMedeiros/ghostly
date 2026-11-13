import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AudioBubble } from "../../components/audio/AudioBubble";
import { FileBubble } from "../../components/FileBubble";
import { VideoBubble } from "../../components/video/VideoBubble";
import { SpeedPill, VoiceBubble } from "../../components/voice/VoiceBubble";
import { servicesPlatform, type FileTransferState } from "../../lib/platform";
import type { ChatFile } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { everythingOnScreen } from "../onScreen";
import { renderApp } from "../render";

// covers: app.accessibility, app.theme

/**
 * Forced colors (Windows Contrast themes) replace backgrounds with the page's, and the buttons of a file, a song and a
 * video on their way were drawn by their fill alone (`bg-accent`, `bg-black/20`, `border-none`): a large file's
 * Accept and Decline, a group file's or voice message's Download <size>, Pause, Resume, Cancel and the speed read as
 * bare words. In forced colors only they keep a ButtonText edge, solid: `border-none` leaves Tailwind's border style
 * at none, under which `forced-colors:border`'s width alone draws nothing (e2e/web/forced-colors-chat.spec.ts measures
 * it in Chromium).
 */
const EDGE = ["forced-colors:border", "forced-colors:border-solid", "forced-colors:border-[color:ButtonText]"];

function keepsAnEdge(button: HTMLElement) {
  for (const name of EDGE) expect(button.className.split(/\s+/), `${button.dataset.testid}: ${name}`).toContain(name);
  // Normal colours: no edge of its own outside forced colors.
  expect(button.className.split(/\s+/).filter((name) => /^border(-|$)/.test(name) && name !== "border-none")).toEqual([]);
}

const MB = 1024 ** 2;
const asking = (size: number): FileTransferState => ({ state: "transferring", stage: "asking", direction: "in", transferred: 0, size, room: 12 * 1024 * MB });
const moving = (size: number, patch: Partial<FileTransferState> = {}): FileTransferState => ({ state: "transferring", direction: "in", transferred: size / 3, size, ...patch });
const kinds = {
  file: { file: { id: "chat1-in-zip", name: "photos.zip", size: 30 * MB, mime: "application/zip" }, Bubble: FileBubble, prefix: "file", transfer: "" },
  audio: { file: { id: "chat1-in-song", name: "Ghost Town.mp3", size: 40 * MB, mime: "audio/mpeg" }, Bubble: AudioBubble, prefix: "audio", transfer: "-transfer" },
  video: { file: { id: "chat1-in-video", name: "ghosts.mp4", size: 35 * MB, mime: "video/mp4", video: { duration: 12_000, width: 1280, height: 720 } }, Bubble: VideoBubble, prefix: "video", transfer: "-transfer" },
} as const;

function show(file: ChatFile, transfer: FileTransferState, Bubble: typeof FileBubble | typeof AudioBubble | typeof VideoBubble) {
  fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: { [file.id]: transfer } });
  return renderApp(<Bubble file={file} sender="peer" peerName="Ana" />);
}

beforeEach(() => {
  everythingOnScreen();
  vi.spyOn(servicesPlatform!, "getFile").mockResolvedValue(null);
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
});

describe("a file's, a song's and a video's buttons in forced colors", () => {
  it("a large file's offer: Accept and Decline", () => {
    const { file, Bubble } = kinds.file;
    show(file, asking(file.size), Bubble);
    keepsAnEdge(screen.getByTestId("file-accept"));
    keepsAnEdge(screen.getByTestId("file-decline"));
  });

  it("a group's file: Download <size>", () => {
    const file = { ...kinds.file.file, id: "group-g1-zip" };
    show(file, asking(file.size), FileBubble);
    expect(screen.getByTestId("file-accept")).toHaveTextContent("Download");
    keepsAnEdge(screen.getByTestId("file-accept"));
  });

  it("a group's voice message: Download <size>", () => {
    const file = { id: "group-g1-voice", name: "Voice message.webm", size: 2 * MB, mime: "audio/webm", voice: { duration: 3_000, peaks: [] } };
    fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: { [file.id]: asking(file.size) } });
    renderApp(<VoiceBubble file={file} sender="peer" peerName="Ana" timestamp={Date.now()} />);
    keepsAnEdge(screen.getByTestId("voice-download"));
  });

  it.each(["audio", "video"] as const)("the %s offer: Download <size> and Decline", (kind) => {
    const { file, Bubble, prefix } = kinds[kind];
    show(file, asking(file.size), Bubble);
    keepsAnEdge(screen.getByTestId(`${prefix}-accept`));
    // The video's Decline is an underlined word on the poster, a link's look that needs no fill.
    if (kind === "audio") keepsAnEdge(screen.getByTestId("audio-decline"));
  });

  it.each(["file", "audio", "video"] as const)("the %s on its way: Pause and Cancel; paused here, Resume", (kind) => {
    const { file, Bubble, prefix, transfer } = kinds[kind];
    const { unmount } = show(file, moving(file.size), Bubble);
    keepsAnEdge(screen.getByTestId(`${prefix}-pause${transfer}`));
    keepsAnEdge(screen.getByTestId(kind === "file" ? "file-cancel" : `${prefix}-cancel`));
    unmount();
    show(file, moving(file.size, { stage: "paused", pausedBy: "me" }), Bubble);
    keepsAnEdge(screen.getByTestId(`${prefix}-resume${transfer}`));
  });

  it("the speed of a voice message or a song", () => {
    renderApp(<SpeedPill rate={1.5} locale="en" onGone={() => {}} />);
    keepsAnEdge(screen.getByTestId("voice-speed"));
  });
});
