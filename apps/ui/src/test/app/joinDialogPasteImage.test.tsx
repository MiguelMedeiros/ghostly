import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { createLink, encodeInviteCode } from "@ghostly/core";
import type { ClipboardFile } from "@ghostly/browser/host";
import { JoinDialog } from "../../components/JoinDialog";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
// covers: invite.qr.image

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

/** What the QR decoder finds in the picture it is handed: happy-dom draws nothing, so the test says. */
const qr = vi.hoisted(() => ({ data: null as string | null, calls: 0 }));
vi.mock("jsqr", () => ({ default: () => { qr.calls++; return qr.data === null ? null : { data: qr.data }; } }));

/** What a clipboard or a drag hands the page: happy-dom has no DataTransfer to build one with. */
function transfer({ files = [], text = "", html = "", types = [] }: { files?: File[]; text?: string; html?: string; types?: string[] }) {
  return {
    files, types: [...(files.length ? ["Files"] : []), ...(text ? ["text/plain"] : []), ...(html ? ["text/html"] : []), ...types],
    items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    getData: (type: string) => type === "text/plain" ? text : type === "text/html" ? html : "",
    dropEffect: "none",
  };
}
const png = (name = "Screenshot.png") => new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });
const dialog = () => screen.getByRole("dialog", { hidden: true });

const getContext = HTMLCanvasElement.prototype.getContext;
beforeEach(() => {
  qr.data = null; qr.calls = 0;
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 400, height: 400, close() {} })));
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {}, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) })) as unknown as typeof getContext;
});
afterEach(() => { vi.unstubAllGlobals(); HTMLCanvasElement.prototype.getContext = getContext; });

/**
 * Join takes a screenshot of an invite's QR pasted or dropped on it (apps/ui/src/components/JoinDialog.tsx): read as
 * "Open image" reads one, and what it holds is only parsed as an invite.
 */
describe("A QR screenshot pasted or dropped on Join", () => {
  it("a pasted image is decoded and joins, as a pasted invite does", async () => {
    const { invite } = createLink();
    qr.data = encodeInviteCode(invite);
    const onJoin = vi.fn();
    renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />);
    const left = fireEvent.paste(screen.getByRole("button", { name: "Paste from clipboard" }), { clipboardData: transfer({ files: [png()] }) });
    expect(left).toBe(false);
    await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1));
    expect(onJoin.mock.calls[0][0]).toMatchObject({ seedB64: invite.seedB64, peerPubKeyB64: invite.peerPubKeyZ32, encKeyB64: invite.encKeyB64 });
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
  });

  it("a QR that holds a web address is refused, never opened", async () => {
    qr.data = "https://example.com/#not-an-invite";
    const onJoin = vi.fn();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const before = location.href;
    renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />);
    fireEvent.paste(dialog(), { clipboardData: transfer({ files: [png()] }) });
    expect(await screen.findByRole("alert")).toHaveTextContent("This is not a Ghostly invite.");
    expect(onJoin).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(location.href).toBe(before);
    open.mockRestore();
  });

  it("a picture with no QR says so", async () => {
    renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
    fireEvent.paste(dialog(), { clipboardData: transfer({ files: [png()] }) });
    expect(await screen.findByRole("alert")).toHaveTextContent("No QR found. Try a clearer image.");
  });

  it("text, and a rich copy with a picture of itself, are left to the field", async () => {
    renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
    expect(fireEvent.paste(dialog(), { clipboardData: transfer({ text: "ghostly1…" }) })).toBe(true);
    expect(fireEvent.paste(dialog(), { clipboardData: transfer({ files: [png("image.png")], text: "a cell", html: "<td>a cell</td>" }) })).toBe(true);
    expect(fireEvent.paste(dialog(), { clipboardData: transfer({ files: [new File(["%PDF"], "a.pdf", { type: "application/pdf" })] }) })).toBe(true);
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(qr.calls).toBe(0);
  });

  describe("where the webview shows the page nothing of a copied picture (Desktop on Linux)", () => {
    /** What the desktop host holds for a paste, read back by token as Rust hands it. */
    const held = (name: string | null, size: number, mime: string | null = null) =>
      ({ name, size, mime, read: vi.fn(async (offset: number, length: number) => new Uint8Array(Math.max(0, Math.min(length, size - offset)))), done: vi.fn<() => void>() }) satisfies ClipboardFile;
    afterEach(() => { fakeEngine.readClipboardFiles = undefined; });

    it("the app reads the picture, and its QR joins", async () => {
      const { invite } = createLink();
      qr.data = encodeInviteCode(invite);
      const shot = held(null, 4, "image/png");
      fakeEngine.readClipboardFiles = vi.fn(async () => [shot]);
      const onJoin = vi.fn();
      renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />);
      expect(fireEvent.paste(dialog(), { clipboardData: transfer({}) })).toBe(false);
      await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1));
      expect(onJoin.mock.calls[0][0]).toMatchObject({ seedB64: invite.seedB64 });
      expect(createImageBitmap).toHaveBeenCalledTimes(1);
      expect(shot.done).toHaveBeenCalledTimes(1);
    });

    it("a picture copied as a file is read too, alone; a picture too large is not read, and says so", async () => {
      const notes = held("notes.pdf", 9), code = held("invite.PNG", 4);
      fakeEngine.readClipboardFiles = vi.fn(async () => [notes, code]);
      renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
      fireEvent.paste(dialog(), { clipboardData: transfer({}) });
      expect(await screen.findByRole("alert")).toHaveTextContent("No QR found. Try a clearer image.");
      expect(notes.read).not.toHaveBeenCalled();
      expect(notes.done).toHaveBeenCalledTimes(1);
      expect(code.done).toHaveBeenCalledTimes(1);

      const huge = held(null, 12 * 1024 * 1024 + 1, "image/png");
      fakeEngine.readClipboardFiles = vi.fn(async () => [huge]);
      fireEvent.paste(dialog(), { clipboardData: transfer({}) });
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Choose an image smaller than 12 MB."));
      expect(huge.read).not.toHaveBeenCalled();
      expect(huge.done).toHaveBeenCalledTimes(1);
    });

    it("copied files with no picture among them say so; an empty clipboard, and what the app refuses, are told apart", async () => {
      fakeEngine.readClipboardFiles = vi.fn(async () => []);
      renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
      expect(fireEvent.paste(dialog(), { clipboardData: transfer({}) })).toBe(false);
      await waitFor(() => expect(fakeEngine.readClipboardFiles).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByRole("button", { name: "Paste from clipboard" })).toBeEnabled());
      expect(screen.queryByRole("alert")).toBeNull();

      fakeEngine.readClipboardFiles = vi.fn(async () => [held("a.pdf", 4)]);
      fireEvent.paste(dialog(), { clipboardData: transfer({ types: ["text/uri-list"] }) });
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not read the image. Try PNG or JPEG.");

      // What the app refuses is said in the dialog's own words: the composer's point at its +, which Join has none of.
      fakeEngine.readClipboardFiles = vi.fn(async () => { throw "That picture is too large to paste"; });
      fireEvent.paste(dialog(), { clipboardData: transfer({}) });
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Choose an image smaller than 12 MB."));
      fakeEngine.readClipboardFiles = vi.fn(async () => { throw "The clipboard's picture is damaged"; });
      fireEvent.paste(dialog(), { clipboardData: transfer({}) });
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not read the image. Try PNG or JPEG."));
      expect(createImageBitmap).not.toHaveBeenCalled();
    });

    it("text never asks the app, and the web app has no such read", () => {
      renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
      expect(fireEvent.paste(dialog(), { clipboardData: transfer({}) })).toBe(true);
      fakeEngine.readClipboardFiles = vi.fn(async () => []);
      expect(fireEvent.paste(dialog(), { clipboardData: transfer({ text: "ghostly1…" }) })).toBe(true);
      expect(fakeEngine.readClipboardFiles).not.toHaveBeenCalled();
    });
  });

  it("a dropped image joins; a dropped file of another kind is refused", async () => {
    const { invite } = createLink();
    qr.data = encodeInviteCode(invite);
    const onJoin = vi.fn();
    renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />);
    expect(fireEvent.drop(dialog(), { dataTransfer: transfer({ files: [new File(["%PDF"], "a.pdf", { type: "application/pdf" })] }) })).toBe(false);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not read the image. Try PNG or JPEG.");
    expect(fireEvent.dragOver(dialog(), { dataTransfer: transfer({ files: [png()] }) })).toBe(false);
    expect(fireEvent.drop(dialog(), { dataTransfer: transfer({ files: [png()] }) })).toBe(false);
    await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1));
    expect(onJoin.mock.calls[0][0]).toMatchObject({ seedB64: invite.seedB64 });
  });
});
