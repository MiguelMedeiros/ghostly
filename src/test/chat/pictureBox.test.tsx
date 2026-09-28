import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileBubble } from "../../components/FileBubble";
import { MessageBubble } from "../../components/MessageBubble";
import { servicesPlatform, type FileTransferState } from "../../lib/platform";
import { pictureBox } from "../../lib/pictureBox";
import type { ChatFile } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: files.image.box

/** The first bytes of a PNG of this size: all the bubble reads of a picture its sender said nothing about. */
function pngHead(width: number, height: number): Blob {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return new Blob([bytes], { type: "image/png" });
}

let n = 0;
/** A picture with an id of its own: sizes found on this device are remembered by id for the run. */
const picture = (patch: Partial<ChatFile> = {}): ChatFile => ({ id: `chat1-in-pic${++n}`, name: "photo.jpg", size: 3_000_000, mime: "image/jpeg", ...patch });
const show = (file: ChatFile, transfer: FileTransferState | null = { state: "done", direction: "in", transferred: file.size, size: file.size }) => {
  fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: transfer ? { [file.id]: transfer } : {} });
  return renderApp(<FileBubble file={file} peerName="Ana" />);
};
const box = () => screen.queryByTestId("file-picture");
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const { createObjectURL, revokeObjectURL } = URL;
beforeEach(() => {
  // The bytes are slow to come: whatever the bubble lays out, it lays out before the picture is there.
  vi.spyOn(servicesPlatform!, "getFile").mockReturnValue(new Promise(() => {}));
  URL.createObjectURL = () => "blob:picture";
  URL.revokeObjectURL = () => {};
});
afterEach(() => Object.assign(URL, { createObjectURL, revokeObjectURL }));

describe("the box of a picture", () => {
  it("fits 330 × 330, keeps its proportions, and is never larger than the picture", () => {
    expect(pictureBox({ width: 4032, height: 3024 })).toEqual({ width: 330, ratio: "4032 / 3024" });
    expect(pictureBox({ width: 3024, height: 4032 })).toEqual({ width: 248, ratio: "3024 / 4032" });
    expect(pictureBox({ width: 88, height: 31 })).toEqual({ width: 88, ratio: "88 / 31" });
    expect(pictureBox({ width: 10_000, height: 1 })).toEqual({ width: 330, ratio: "10000 / 1" });
  });
});

describe("FileBubble: a picture's box is there before the picture", () => {
  it("from the size its sender said, before a byte of it is shown", () => {
    show(picture({ image: { width: 3024, height: 4032 } }));
    const shown = box()!;
    expect(shown).toHaveAttribute("data-box", "sized");
    expect(shown.style.width).toBe("248px");
    expect(shown.style.aspectRatio).toBe("3024 / 4032");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("while it is still arriving", () => {
    show(picture({ image: { width: 1920, height: 1080 } }), { state: "transferring", direction: "in", transferred: 10, size: 3_000_000 });
    expect(box()).toHaveAttribute("data-box", "sized");
    expect(box()!.style.aspectRatio).toBe("1920 / 1080");
  });

  it("the picture loads into the box it had", async () => {
    vi.mocked(servicesPlatform!.getFile).mockResolvedValue(pngHead(1920, 1080));
    show(picture({ mime: "image/png", image: { width: 1920, height: 1080 } }));
    const image = await screen.findByRole("img", { name: "photo.jpg" });
    expect(image.parentElement).toBe(box());
    expect(box()!.style.aspectRatio).toBe("1920 / 1080");
  });

  it("without a size from its sender: a placeholder, then the size read from its first bytes, before it shows", async () => {
    let arrive!: (blob: Blob) => void;
    vi.mocked(servicesPlatform!.getFile).mockReturnValue(new Promise((resolve) => { arrive = resolve; }));
    const file = picture({ mime: "image/png" });
    const view = show(file);
    expect(box()).toHaveAttribute("data-box", "placeholder");
    expect(box()!.style.width).toBe("240px");
    expect(box()!.style.aspectRatio).toBe("4 / 3");
    await act(async () => arrive(pngHead(100, 400)));
    const image = await screen.findByRole("img", { name: "photo.jpg" });
    expect(box()).toHaveAttribute("data-box", "sized");
    expect(box()!.style.aspectRatio).toBe("100 / 400");
    expect(image.parentElement).toBe(box());
    // Shown again (the chat reopened): the size found is kept for the run, so the box is right at once.
    view.unmount();
    vi.mocked(servicesPlatform!.getFile).mockReturnValue(new Promise(() => {}));
    show(file);
    expect(box()).toHaveAttribute("data-box", "sized");
    expect(box()!.style.aspectRatio).toBe("100 / 400");
  });

  it("one that loads as another shape than it said is shown as it loaded", async () => {
    vi.mocked(servicesPlatform!.getFile).mockResolvedValue(pngHead(400, 300));
    show(picture({ mime: "image/png", image: { width: 400, height: 300 } }));
    const image = await screen.findByRole("img", { name: "photo.jpg" });
    Object.defineProperty(image, "naturalWidth", { value: 300 });
    Object.defineProperty(image, "naturalHeight", { value: 400 });
    fireEvent.load(image);
    expect(box()!.style.aspectRatio).toBe("300 / 400");
  });

  it("nothing is reserved for a picture that will not show", async () => {
    const file = picture({ image: { width: 800, height: 600 } });
    // Waiting for this person's consent (a large one): the offer, not an empty box.
    const view = show(file, { state: "transferring", direction: "in", stage: "asking", transferred: 0, size: file.size });
    expect(box()).toBeNull();
    act(() => fakeEngine.update({ transfers: { [file.id]: { state: "failed", direction: "in", transferred: 0, size: file.size, error: "Declined" } } }));
    expect(box()).toBeNull();
    view.unmount();
    // Not a picture at all.
    show(picture({ name: "notes.pdf", mime: "application/pdf" }));
    await settle();
    expect(screen.getByTestId("file-bubble")).toBeInTheDocument();
    expect(box()).toBeNull();
  });

  it("a picture that cannot be shown gives its box back", async () => {
    vi.mocked(servicesPlatform!.getFile).mockResolvedValue(pngHead(40, 30));
    show(picture({ mime: "image/png", image: { width: 40, height: 30 } }));
    fireEvent.error(await screen.findByRole("img", { name: "photo.jpg" }));
    expect(box()).toBeNull();
  });
});

describe("MessageBubble: a picture link", () => {
  it("keeps a placeholder's height until its picture loads", () => {
    const url = "https://media.giphy.com/media/abc/giphy.gif";
    renderApp(<MessageBubble message={{ id: "m1", text: url, sender: "me", timestamp: 1_700_000_000_000 }} peerPubKey="peer" />);
    const image = screen.getByTestId("picture-link");
    expect(image.className).toContain("min-h-[120px]");
    fireEvent.load(image);
    expect(image.className).not.toContain("min-h-[120px]");
  });
});
