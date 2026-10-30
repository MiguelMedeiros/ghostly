import { beforeEach, describe, expect, it, vi } from "vitest";

// covers: invite.qr.camera, invite.qr.image, wallet.cashu.send-scan

/**
 * A QR read downloads one copy of the decoder, not two (apps/ui/src/lib/qrReader.ts): the worker, started at once,
 * brings its own, and the page loads its copy (the `jsqr` chunk) only where that worker fails. Each test is a fresh
 * page: the chunk is loaded at most once per page.
 */
const chunk = { loads: 0, fails: false, finds: null as string | null };
const loadChunk = () => {
  chunk.loads++;
  if (chunk.fails) throw new TypeError("Failed to fetch dynamically imported module");
  return { default: () => (chunk.finds === null ? null : { data: chunk.finds }) };
};

/** A stand-in for the decoding worker: keeps what the page hands it, answers when the test says. */
class FakeWorker extends EventTarget {
  static made: FakeWorker[] = [];
  posted: unknown[] = [];
  terminated = false;
  constructor() { super(); FakeWorker.made.push(this); }
  postMessage(message: unknown) { this.posted.push(message); }
  terminate() { this.terminated = true; }
  answer(text: string | null) { this.dispatchEvent(new MessageEvent("message", { data: { text } })); }
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x0f, 0xc0, 0, 0, 0x0b, 0xd0, 8, 6, 0, 0, 0];
const photo = () => new Blob([new Uint8Array(PNG)], { type: "image/png" });
const camera = () => ({ readyState: 4, videoWidth: 1280, videoHeight: 720 }) as unknown as HTMLVideoElement;
const reader = () => import("../../lib/qrReader");
/** When the picture was decoded, against when the worker started. */
let order: string[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.doMock("jsqr", loadChunk);
  chunk.loads = 0; chunk.fails = false; chunk.finds = null; FakeWorker.made = []; order = [];
  vi.stubGlobal("Worker", class extends FakeWorker { constructor() { super(); order.push("worker"); } });
  vi.stubGlobal("createImageBitmap", async () => { order.push("picture"); return { width: 4032, height: 3024, close() {} }; });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
    drawImage: () => {},
    getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
  }) as unknown as CanvasRenderingContext2D);
  return () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); };
});

describe("the first QR read loads the decoder once", () => {
  it("a picture: the worker starts before the picture is decoded, and the page loads no decoder of its own", async () => {
    const { readQrImage } = await reader();
    const reading = readQrImage(photo());
    await vi.waitFor(() => expect(FakeWorker.made[0]?.posted).toHaveLength(1));
    FakeWorker.made[0].answer("lnbc1invoice");
    await expect(reading).resolves.toBe("lnbc1invoice");
    expect(order).toEqual(["worker", "picture"]);
    expect(chunk.loads).toBe(0);
  });

  it("the camera: the worker starts with it, and the page loads no decoder of its own", async () => {
    const { qrFrameReader, scanQrFrames } = await reader();
    const decode = qrFrameReader();
    expect(FakeWorker.made).toHaveLength(1);
    const found = vi.fn(() => true);
    const scanning = scanQrFrames(camera(), decode, () => true, found);
    await vi.waitFor(() => expect(FakeWorker.made[0].posted).toHaveLength(1));
    FakeWorker.made[0].answer("ghostly:invite");
    await scanning;
    expect(found).toHaveBeenCalledWith("ghostly:invite");
    expect(chunk.loads).toBe(0);
  });

  it("a worker whose script does not load: the page loads its copy then, once", async () => {
    chunk.finds = "lnbc1invoice";
    const { readQrImage } = await reader();
    const reading = readQrImage(photo());
    await vi.waitFor(() => expect(FakeWorker.made[0]?.posted).toHaveLength(1));
    expect(chunk.loads).toBe(0);
    FakeWorker.made[0].dispatchEvent(new Event("error"));
    await expect(reading).resolves.toBe("lnbc1invoice");
    expect(chunk.loads).toBe(1);
  });

  it("a worker whose script does not load, and a page copy that does not either: said as the reader not loaded, once", async () => {
    chunk.fails = true;
    const { QrReaderNotLoaded, qrFrameReader, qrReaderFailures, scanQrFrames } = await reader();
    const scanning = scanQrFrames(camera(), qrFrameReader(), () => true, () => true);
    await vi.waitFor(() => expect(FakeWorker.made[0].posted).toHaveLength(1));
    FakeWorker.made[0].dispatchEvent(new Event("error"));
    await expect(scanning).rejects.toBeInstanceOf(QrReaderNotLoaded);
    expect(qrReaderFailures()).toBe(1);
    expect(FakeWorker.made[0].terminated).toBe(true);
  });
});
