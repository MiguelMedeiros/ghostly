import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { createLink, encodeInviteCode } from "@ghostly/core";
import { JoinDialog } from "../../components/JoinDialog";
import { renderApp } from "../render";
// covers: invite.qr.image

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

/** What the QR decoder finds in the picture it is handed: happy-dom draws nothing, so the test says. */
const qr = vi.hoisted(() => ({ data: null as string | null, calls: 0 }));
vi.mock("jsqr", () => ({ default: () => { qr.calls++; return qr.data === null ? null : { data: qr.data }; } }));

/** What a clipboard or a drag hands the page: happy-dom has no DataTransfer to build one with. */
function transfer({ files = [], text = "", html = "" }: { files?: File[]; text?: string; html?: string }) {
  return {
    files, types: [...(files.length ? ["Files"] : []), ...(text ? ["text/plain"] : []), ...(html ? ["text/html"] : [])],
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
