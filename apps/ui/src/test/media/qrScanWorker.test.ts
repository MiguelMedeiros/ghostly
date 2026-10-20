import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readQrImage, scanQrFrames } from "../../lib/qrReader";

// covers: invite.qr.camera, invite.qr.image, wallet.cashu.send-scan

/** The decoder the page loads: what it finds when it decodes on the page. */
const onPageDecoder = vi.hoisted(() => ({ calls: 0, finds: null as string | null }));
vi.mock("jsqr", () => ({ default: () => { onPageDecoder.calls++; return onPageDecoder.finds === null ? null : { data: onPageDecoder.finds }; } }));

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

beforeEach(() => {
  FakeWorker.made = []; FakeWorker.refuse = false;
  onPageDecoder.calls = 0; onPageDecoder.finds = null;
  vi.stubGlobal("Worker", FakeWorker);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
    drawImage: () => {},
    getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
  }) as unknown as CanvasRenderingContext2D);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("a camera scan decodes its frames away from the page", () => {
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

describe("a picture's QR is decoded away from the page", () => {
  /** A phone photo, 4032x3024: read at 2048x1536. */
  const photo = { width: 4032, height: 3024, close: vi.fn() };
  beforeEach(() => { photo.close.mockClear(); vi.stubGlobal("createImageBitmap", async () => photo); });
  /** The photo's PNG header: the picture is decoded only once its header says its size. */
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x0f, 0xc0, 0, 0, 0x0b, 0xd0, 8, 6, 0, 0, 0];
  const read = () => readQrImage(new Blob([new Uint8Array(header)], { type: "image/png" }));
  const posted = async () => { await vi.waitFor(() => expect(FakeWorker.made[0]?.posted).toHaveLength(1)); return FakeWorker.made[0]; };

  it("hands the picture's pixels to a worker, never decodes them on the page, and ends the worker", async () => {
    const reading = read();
    const worker = await posted();
    expect(worker.posted[0]).toMatchObject({ width: 2048, height: 1536 });
    worker.answer("lnbc1invoice");
    await expect(reading).resolves.toBe("lnbc1invoice");
    expect(onPageDecoder.calls).toBe(0);
    expect(worker.terminated).toBe(true);
    expect(photo.close).toHaveBeenCalled();
  });

  it("a picture with no QR is said as such", async () => {
    const reading = read();
    (await posted()).answer(null);
    await expect(reading).resolves.toBeNull();
    expect(onPageDecoder.calls).toBe(0);
  });

  it("a worker whose script does not load leaves the picture to the page", async () => {
    onPageDecoder.finds = "lnbc1invoice";
    const reading = read();
    (await posted()).dispatchEvent(new Event("error"));
    await expect(reading).resolves.toBe("lnbc1invoice");
    expect(onPageDecoder.calls).toBe(1);
  });

  it("where no worker can start, the page decodes the picture as before", async () => {
    FakeWorker.refuse = true;
    onPageDecoder.finds = "lnbc1invoice";
    await expect(read()).resolves.toBe("lnbc1invoice");
    expect(onPageDecoder.calls).toBe(1);
  });
});
