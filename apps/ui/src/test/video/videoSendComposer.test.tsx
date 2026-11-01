import { act, screen, waitFor } from "@testing-library/react";
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
/** The same video each time it is picked: its name, size and date. */
const mov = () => new File(["iphone video"], "IMG_0001.MOV", { type: "video/quicktime", lastModified: 1_700_000_000_000 });

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

    expect(await screen.findByRole("status")).toHaveTextContent("Converting IMG_0001.MOV to MP4…");
    expect(screen.getByRole("progressbar", { name: "Converting IMG_0001.MOV to MP4…" })).toHaveTextContent("42%");
    expect(screen.getByTestId("video-convert-cancel")).toHaveTextContent("Cancel");
    expect(onSendFile).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(onSendFile).toHaveBeenCalledTimes(1));
    const [sent] = onSendFile.mock.calls[0]!;
    expect([sent.name, sent.type]).toEqual(["IMG_0001.mp4", "video/mp4"]);
    await waitFor(() => expect(screen.queryByTestId("file-preparing")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a sample at a time, the line takes the latest at most every quarter second and says no percent aloud", async () => {
    let finish!: () => void;
    let report!: (progress: number) => void;
    converter.convert = (_file, { onProgress }) => new Promise((resolve) => {
      report = (progress) => onProgress?.(progress);
      finish = () => resolve({ file: new File(["mp4"], "IMG_0001.mp4", { type: "video/mp4" }) });
    });
    const { user } = composer();
    await user.upload(screen.getByTestId("media-input"), mov());
    await waitFor(() => expect(report).toBeDefined());

    const status = screen.getByTestId("file-preparing");
    const texts: string[] = [];
    const watcher = new MutationObserver(() => texts.push(status.textContent ?? ""));
    watcher.observe(status, { subtree: true, childList: true, characterData: true });
    const progress = () => screen.getByTestId("video-convert-progress");
    act(() => { for (let sample = 1; sample <= 99; sample++) report(sample / 100); });
    expect(progress()).toHaveTextContent("1%");
    await waitFor(() => expect(progress()).toHaveTextContent("99%"));
    expect(progress()).toHaveAttribute("aria-valuenow", "99");
    watcher.disconnect();
    expect(texts.every((text) => text === "Converting IMG_0001.MOV to MP4…")).toBe(true);
    expect(status).toHaveTextContent("Converting IMG_0001.MOV to MP4…");
    finish();
    await waitFor(() => expect(onSendFile).toHaveBeenCalledTimes(1));
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

  it("Cancel while two videos convert stops the one it is shown with, not the one chosen last", async () => {
    const runs = new Map<string, PrepareOptions>();
    converter.convert = (file, options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")));
      runs.set(file.name, options);
    });
    const { user } = composer();
    await user.upload(screen.getByTestId("media-input"), mov());
    await waitFor(() => expect(runs.has("IMG_0001.MOV")).toBe(true));
    await user.upload(screen.getByTestId("media-input"), new File(["second video"], "IMG_0002.MOV", { type: "video/quicktime" }));
    await waitFor(() => expect(runs.has("IMG_0002.MOV")).toBe(true));

    act(() => runs.get("IMG_0001.MOV")!.onProgress?.(0.1));
    expect(await screen.findByRole("progressbar", { name: "Converting IMG_0001.MOV to MP4…" })).toHaveTextContent("10%");
    await user.click(screen.getByTestId("video-convert-cancel"));
    expect(runs.get("IMG_0001.MOV")!.signal?.aborted).toBe(true);
    expect(runs.get("IMG_0002.MOV")!.signal?.aborted).toBe(false);
  });

  it("Cancel stops the video it is shown with, also after a second video chosen meanwhile is done converting", async () => {
    const runs = new Map<string, { options: PrepareOptions; finish: () => void }>();
    converter.convert = (file, options) => new Promise((resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")));
      runs.set(file.name, { options, finish: () => resolve({ file: new File(["mp4"], file.name.replace(/\.MOV$/, ".mp4"), { type: "video/mp4" }) }) });
    });
    const { user } = composer();
    await user.upload(screen.getByTestId("media-input"), mov());
    await waitFor(() => expect(runs.has("IMG_0001.MOV")).toBe(true));
    await user.upload(screen.getByTestId("media-input"), new File(["second video"], "IMG_0002.MOV", { type: "video/quicktime" }));
    await waitFor(() => expect(runs.has("IMG_0002.MOV")).toBe(true));
    const [first, second] = [runs.get("IMG_0001.MOV")!, runs.get("IMG_0002.MOV")!];

    // While both convert, the line names the first and its Cancel is there.
    act(() => { second.options.onProgress?.(0.5); first.options.onProgress?.(0.1); });
    expect(await screen.findByRole("progressbar", { name: "Converting IMG_0001.MOV to MP4…" })).toHaveTextContent("10%");
    expect(screen.getByTestId("video-convert-cancel")).toBeInTheDocument();
    second.finish();
    await waitFor(() => expect(onSendFile).toHaveBeenCalledTimes(1));
    expect(onSendFile.mock.calls[0]![0].name).toBe("IMG_0002.mp4");

    act(() => first.options.onProgress?.(0.2));
    await user.click(await screen.findByTestId("video-convert-cancel"));
    expect(first.options.signal?.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByTestId("file-preparing")).toBeNull());
    expect(onSendFile).toHaveBeenCalledTimes(1);
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

describe("a video still converting when the chat is left", () => {
  const inChat = () => <LockScreenProvider><MessageInput draftId="video-left" onSend={onSend} onSendFile={onSendFile} /></LockScreenProvider>;

  it("is on the chat's line again when it is opened, and picked again there it is converted and sent once", async () => {
    let finish!: () => void;
    const convert = vi.fn((_file: File, { onProgress }: PrepareOptions) => new Promise<PreparedVideo>((resolve) => {
      onProgress?.(0.42);
      finish = () => resolve({ file: new File(["mp4"], "IMG_0001.mp4", { type: "video/mp4" }) });
    }));
    converter.convert = convert;
    const first = renderApp(inChat());
    await first.user.upload(screen.getByTestId("media-input"), mov());
    await screen.findByRole("progressbar", { name: "Converting IMG_0001.MOV to MP4…" });
    first.unmount();

    const back = renderApp(inChat());
    expect(screen.getByRole("progressbar", { name: "Converting IMG_0001.MOV to MP4…" })).toHaveTextContent("42%");
    expect(screen.getByTestId("video-convert-cancel")).toBeInTheDocument();
    await back.user.upload(screen.getByTestId("media-input"), mov());
    finish();

    await waitFor(() => expect(screen.queryByTestId("file-preparing")).toBeNull());
    expect(convert).toHaveBeenCalledTimes(1);
    expect(onSendFile).toHaveBeenCalledTimes(1);
  });

  it("Cancel back in the chat stops it", async () => {
    converter.convert = (_file, { onProgress, signal }) => new Promise((_resolve, reject) => {
      onProgress?.(0.1);
      signal?.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")));
    });
    const first = renderApp(inChat());
    await first.user.upload(screen.getByTestId("media-input"), mov());
    await screen.findByTestId("video-convert-cancel");
    first.unmount();

    const { user } = renderApp(inChat());
    await user.click(screen.getByTestId("video-convert-cancel"));
    await waitFor(() => expect(screen.queryByTestId("file-preparing")).toBeNull());
    expect(onSendFile).not.toHaveBeenCalled();
  });

  it("sent as it is meanwhile, the sender is told when back in the chat", async () => {
    let finish!: () => void;
    converter.convert = (file) => new Promise((resolve) => { finish = () => resolve({ file, asIs: true }); });
    const first = renderApp(inChat());
    await first.user.upload(screen.getByTestId("media-input"), mov());
    await screen.findByTestId("file-preparing");
    first.unmount();
    finish();
    await waitFor(() => expect(onSendFile).toHaveBeenCalledTimes(1));

    renderApp(inChat());
    expect(await screen.findByRole("alert")).toHaveTextContent("Sent IMG_0001.MOV as it is: this device can't convert it.");
  });
});
