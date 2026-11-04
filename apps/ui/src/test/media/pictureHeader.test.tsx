import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentSheet } from "../../components/composer/AttachmentSheet";
import { avatarFromFile } from "../../lib/avatarImage";
import { readQrImage } from "../../lib/qrReader";
import { renderApp } from "../render";

// covers: invite.qr.image, wallet.cashu.send-scan, groups.picture.set, app.composer.paste-files

vi.mock("jsqr", () => ({ default: () => null }));

const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
/** A PNG whose header says `width` × `height`: a few bytes can say gigabytes once decoded. */
const png = (width: number, height: number, name = "shot.png") => new File([new Uint8Array([
  0x89, ..."PNG\r\n\x1a\n".split("").map((c) => c.charCodeAt(0)), ...be32(13), ..."IHDR".split("").map((c) => c.charCodeAt(0)),
  ...be32(width), ...be32(height), 1, 0, 0, 0, 0,
])], name, { type: "image/png" });

/** The pixels each decode was asked for. */
let decoded: number[];
beforeEach(() => {
  decoded = [];
  vi.stubGlobal("Worker", class { constructor() { throw new Error("no worker here"); } });
  vi.stubGlobal("createImageBitmap", async (file: Blob) => {
    const view = new DataView(await file.slice(16, 24).arrayBuffer());
    const width = view.getUint32(0), height = view.getUint32(4);
    decoded.push(width * height);
    return { width, height, close: () => {} };
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
    drawImage: () => {},
    getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
  }) as unknown as CanvasRenderingContext2D);
  // A 128 x 128 JPEG's header: what the canvas makes of the picture.
  const jpeg = [0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 128, 0, 128, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9, 0];
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(`data:image/jpeg;base64,${btoa(String.fromCharCode(...jpeg))}`);
  URL.createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("a picture is decoded only when its own header says a size the chat would draw", () => {
  it("a QR picture (Join, wallet Send) whose header says 23000 x 23000 is refused, never decoded", async () => {
    await expect(readQrImage(png(23000, 23000))).rejects.toThrow("This picture cannot be read here");
    expect(decoded).toEqual([]);
    await expect(readQrImage(png(1000, 1000))).resolves.toBeNull();
    expect(decoded).toEqual([1_000_000]);
  });

  it("a QR picture whose bytes say no size is refused too", async () => {
    await expect(readQrImage(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }))).rejects.toThrow();
    expect(decoded).toEqual([]);
  });

  it("a profile or group picture whose header says 23000 x 23000 is refused, never decoded", async () => {
    await expect(avatarFromFile(png(23000, 23000))).rejects.toThrow("This picture cannot be read here. Try a JPEG or PNG.");
    expect(decoded).toEqual([]);
    await expect(avatarFromFile(png(1000, 1000))).resolves.toMatch(/^data:image\/jpeg;base64,/);
    expect(decoded).toEqual([1_000_000]);
  });

  it("the attachment sheet shows such a picture as a file (its name and size) and draws the one beside it", async () => {
    const files = [png(23000, 23000, "bomb.png"), png(1000, 1000, "fine.png")];
    renderApp(<AttachmentSheet files={files} onPaste={() => false} onRemove={() => {}} onSend={() => {}} onCancel={() => {}} />);
    expect(await screen.findByAltText("fine.png")).toHaveAttribute("src", "blob:fine.png");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByAltText("bomb.png")).toBeNull();
    expect(new Set(vi.mocked(URL.createObjectURL).mock.calls.map(([file]) => (file as File).name))).toEqual(new Set(["fine.png"]));
    expect(screen.getByText("bomb.png")).toBeInTheDocument();
  });

  it("alone on the sheet, it is never drawn", async () => {
    renderApp(<AttachmentSheet files={[png(23000, 23000, "bomb.png")]} onPaste={() => false} onRemove={() => {}} onSend={() => {}} onCancel={() => {}} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("attachment-image")).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByText("bomb.png")).toBeInTheDocument();
  });
});
