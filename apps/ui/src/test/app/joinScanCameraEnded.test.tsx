import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { JoinDialog } from "../../components/JoinDialog";
import { renderApp } from "../render";
// covers: invite.qr.camera

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

/** Every frame the QR decoder is handed: happy-dom draws nothing, so none holds a QR. */
const qr = vi.hoisted(() => ({ calls: 0 }));
vi.mock("jsqr", () => ({ default: () => { qr.calls++; return null; } }));

/** The camera's one track, as the system ends it (Android takes the camera from an app at Home). */
const track = { readyState: "live" as MediaStreamTrackState, stop() { this.readyState = "ended"; } };
const camera = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;

const getContext = HTMLCanvasElement.prototype.getContext;
const play = HTMLMediaElement.prototype.play;
beforeEach(() => {
  qr.calls = 0;
  track.readyState = "live";
  // No worker here: frames are decoded on the page.
  vi.stubGlobal("Worker", class { constructor() { throw new Error("no workers"); } });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => camera } });
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {}, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) })) as unknown as typeof getContext;
  HTMLMediaElement.prototype.play = async () => {};
  for (const [name, value] of [["readyState", 4], ["videoWidth", 64], ["videoHeight", 64]] as const) {
    Object.defineProperty(HTMLVideoElement.prototype, name, { configurable: true, get: () => value });
  }
  // happy-dom's preview takes only its own streams: this one holds the stand-in camera.
  let source: MediaStream | null = null;
  Object.defineProperty(HTMLVideoElement.prototype, "srcObject", { configurable: true, get: () => source, set: (stream: MediaStream | null) => { source = stream; } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as unknown as Record<string, unknown>).mediaDevices;
  HTMLCanvasElement.prototype.getContext = getContext;
  HTMLMediaElement.prototype.play = play;
  for (const name of ["readyState", "videoWidth", "videoHeight", "srcObject"]) delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>)[name];
});

/**
 * Join's camera scan (apps/ui/src/components/JoinDialog.tsx, lib/qrReader.ts `scanQrFrames`) when the camera ends under
 * it: on Android the system closes it a few seconds after the app goes to Home, and the video keeps its last frame.
 */
describe("Join's camera scan when the camera ends", () => {
  it("stops reading the last frame and says the camera is unavailable", async () => {
    renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Scan QR" }));
    await waitFor(() => expect(qr.calls).toBeGreaterThan(0));
    act(() => { track.readyState = "ended"; });
    expect(await screen.findByText("Camera unavailable. Paste an invite or open an image.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scan QR" })).toBeTruthy();
    // No frame read after it ended: the one the video still shows is not a camera's.
    const after = qr.calls;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(qr.calls).toBe(after);
  });
});
