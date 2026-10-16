import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { JoinDialog } from "../../components/JoinDialog";
import { renderApp } from "../render";
// covers: invite.qr.image

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

/** The QR decoder's chunk does not load: offline before the worker cached it, or a deploy replaced it under an open tab. */
vi.mock("jsqr", () => { throw new TypeError("Failed to fetch dynamically imported module"); });

const png = () => new File([new Uint8Array([137, 80, 78, 71])], "Screenshot.png", { type: "image/png" });
const paste = (files: File[]) => ({ files, types: ["Files"], items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })), getData: () => "" });

const getContext = HTMLCanvasElement.prototype.getContext;
const play = HTMLMediaElement.prototype.play;
// happy-dom takes only its own MediaStream as a source: the camera's fake stream is just kept.
const srcObject = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject")!;
beforeEach(() => {
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { configurable: true, get() { return this._src ?? null; }, set(value) { this._src = value; } });
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 400, height: 400, close() {} })));
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {}, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) })) as unknown as typeof getContext;
  HTMLMediaElement.prototype.play = async () => {};
});
afterEach(() => { vi.unstubAllGlobals(); HTMLCanvasElement.prototype.getContext = getContext; HTMLMediaElement.prototype.play = play; Object.defineProperty(HTMLMediaElement.prototype, "srcObject", srcObject); });

/**
 * Join loads its QR decoder when it first scans or reads a picture (apps/ui/src/components/JoinDialog.tsx). When that
 * load fails, Join says so: a good picture is not called unreadable, nor a working camera unavailable.
 */
describe("Join when its QR decoder does not load", () => {
  it("a pasted picture is not blamed for it", async () => {
    renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
    fireEvent.paste(screen.getByRole("dialog", { hidden: true }), { clipboardData: paste([png()]) });
    expect(await screen.findByRole("alert")).toHaveTextContent("The QR reader did not load. Check your connection, then try again.");
  });

  it("a camera that started is not called unavailable, and is stopped", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } });
    renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} autoScan />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The QR reader did not load. Check your connection, then try again.");
    expect(track.stop).toHaveBeenCalled();
  });

  it("on Add this device too", async () => {
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop() {} }] })) } });
    renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} onDevice={async () => {}} autoScan />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The QR reader did not load.");
  });

  it("a camera that does not start is still said as such", async () => {
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); }) } });
    renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} autoScan />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Camera unavailable. Paste an invite or open an image.");
  });
});
