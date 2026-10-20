import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanQrFrames } from "../../lib/qrReader";

// covers: invite.qr.camera, wallet.cashu.send-scan

/** A stand-in for the decoding worker: keeps what the page hands it, answers when the test says. */
class FakeWorker extends EventTarget {
  static made: FakeWorker[] = [];
  static refuse = false;
  posted: { pixels: Uint8ClampedArray; width: number; height: number }[] = [];
  terminated = false;
  constructor(readonly url: URL | string) {
    super();
    if (FakeWorker.refuse) throw new Error("SecurityError");
    FakeWorker.made.push(this);
  }
  postMessage(message: { pixels: Uint8ClampedArray; width: number; height: number }) { this.posted.push(message); }
  terminate() { this.terminated = true; }
  answer(text: string | null) { this.dispatchEvent(new MessageEvent("message", { data: { text } })); }
}

/** A playing camera preview, 1280x720. */
const camera = () => ({ readyState: 4, videoWidth: 1280, videoHeight: 720 }) as unknown as HTMLVideoElement;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a camera scan decodes its frames away from the page", () => {
  beforeEach(() => {
    FakeWorker.made = []; FakeWorker.refuse = false;
    vi.stubGlobal("Worker", FakeWorker);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
      drawImage: () => {},
      getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
    }) as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("hands each frame to a worker, never decodes it on the page, and ends the worker with the scan", async () => {
    const onPage = vi.fn(() => null);
    const found = vi.fn(() => true);
    scanQrFrames(camera(), onPage, () => true, found);
    await settle();

    expect(FakeWorker.made).toHaveLength(1);
    const [worker] = FakeWorker.made;
    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0]).toMatchObject({ width: 960, height: 540 });
    expect(worker.posted[0].pixels).toHaveLength(960 * 540 * 4);
    expect(onPage).not.toHaveBeenCalled();

    worker.answer("ghostly:invite");
    await settle();
    expect(found).toHaveBeenCalledWith("ghostly:invite");
    expect(worker.terminated).toBe(true);
  });

  it("a scan stopped while a frame decodes ends the worker and takes no answer", async () => {
    let live = true;
    const found = vi.fn(() => true);
    scanQrFrames(camera(), vi.fn(() => null), () => live, found);
    await settle();
    const [worker] = FakeWorker.made;
    live = false;
    worker.answer("ghostly:invite");
    await settle();
    expect(found).not.toHaveBeenCalled();
    expect(worker.terminated).toBe(true);
  });

  it("where no worker can start, the frames are decoded on the page as before", async () => {
    FakeWorker.refuse = true;
    const onPage = vi.fn(() => ({ data: "ghostly:invite" }) as ReturnType<typeof import("jsqr").default>);
    const found = vi.fn(() => true);
    scanQrFrames(camera(), onPage, () => true, found);
    await settle();
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(found).toHaveBeenCalledWith("ghostly:invite");
  });

  it("a worker whose script does not load leaves the next frames to the page", async () => {
    const onPage = vi.fn(() => ({ data: "ghostly:invite" }) as ReturnType<typeof import("jsqr").default>);
    const found = vi.fn(() => true);
    scanQrFrames(camera(), onPage, () => true, found);
    await settle();
    const [worker] = FakeWorker.made;
    worker.dispatchEvent(new Event("error"));
    expect(worker.terminated).toBe(true);
    await vi.waitFor(() => expect(found).toHaveBeenCalledWith("ghostly:invite"));
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(worker.posted).toHaveLength(1);
  });
});
