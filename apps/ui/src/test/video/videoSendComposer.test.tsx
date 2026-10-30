import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import type { PrepareOptions, PreparedVideo } from "../../lib/videoSend";
import { renderApp } from "../render";

// covers: files.video.convert

/** The converter (loaded only when a video is sent), driven by each test. */
const converter = vi.hoisted(() => ({
  convert: null as null | ((file: File, options: PrepareOptions) => Promise<PreparedVideo>),
}));
vi.mock("../../lib/videoConvert", () => ({ convertVideo: (file: File, options: PrepareOptions) => converter.convert!(file, options) }));

const onSend = vi.fn<(text: string) => Promise<string | null>>();
const onSendFile = vi.fn<(file: File) => Promise<string | null>>();

const composer = () => renderApp(<LockScreenProvider><MessageInput onSend={onSend} onSendFile={onSendFile} /></LockScreenProvider>);
const mov = () => new File(["iphone video"], "IMG_0001.MOV", { type: "video/quicktime" });

beforeEach(() => {
  onSend.mockReset().mockResolvedValue(null);
  onSendFile.mockReset().mockResolvedValue(null);
});

describe("a video chosen to send", () => {
  it("is converted first, its progress on the line, then the MP4 is what goes", async () => {
    let finish!: () => void;
    converter.convert = (_file, { onProgress }) => new Promise((resolve) => {
      onProgress?.(0.42);
      finish = () => resolve({ file: new File(["mp4"], "IMG_0001.mp4", { type: "video/mp4" }) });
    });
    const { user } = composer();
    await user.upload(screen.getByTestId("media-input"), mov());

    expect(await screen.findByText("Converting IMG_0001.MOV to MP4… 42%")).toBeInTheDocument();
    expect(screen.getByTestId("video-convert-cancel")).toHaveTextContent("Cancel");
    expect(onSendFile).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(onSendFile).toHaveBeenCalledTimes(1));
    const [sent] = onSendFile.mock.calls[0]!;
    expect([sent.name, sent.type]).toEqual(["IMG_0001.mp4", "video/mp4"]);
    await waitFor(() => expect(screen.queryByTestId("file-preparing")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Cancel while it converts sends nothing", async () => {
    converter.convert = (_file, { onProgress, signal }) => new Promise((_resolve, reject) => {
      onProgress?.(0.1);
      signal?.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")));
    });
    const { user } = composer();
    await user.upload(screen.getByTestId("media-input"), mov());
    await user.click(await screen.findByTestId("video-convert-cancel"));

    await waitFor(() => expect(screen.queryByTestId("file-preparing")).toBeNull());
    expect(onSendFile).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("one this device cannot convert goes as it is, and the sender is told", async () => {
    converter.convert = async (file) => ({ file, asIs: true });
    const { user } = composer();
    const chosen = mov();
    await user.upload(screen.getByTestId("media-input"), chosen);

    await waitFor(() => expect(onSendFile).toHaveBeenCalledWith(chosen));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sent IMG_0001.MOV as it is: this device can't convert it.");
  });

  it("other files go straight away, the converter never loaded", async () => {
    converter.convert = vi.fn();
    const { user } = composer();
    await user.upload(screen.getByTestId("file-input"), new File(["%PDF"], "notes.pdf", { type: "application/pdf" }));
    await waitFor(() => expect(onSendFile).toHaveBeenCalledTimes(1));
    expect(converter.convert).not.toHaveBeenCalled();
  });
});
