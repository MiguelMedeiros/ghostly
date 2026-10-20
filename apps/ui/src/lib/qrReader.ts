import { decodablePicture } from "./decodablePicture";

/**
 * Reading a QR code, shared by Join and the wallet's Send: from the camera, frame by frame, or from a picture (opened,
 * pasted or dropped). Scanned text is only data: each caller parses it as what it expects, never opens or runs it.
 *
 * The decoder (about 127 KiB) is loaded when a scan or a picture read first needs it, not with the first screen.
 * Loaded once; a load that failed is tried again the next time. A load that failed (offline, or a deploy replaced the
 * chunk under an open tab) is said as such, never as the camera or the picture: `QrReaderNotLoaded`. Once it failed
 * twice (`qrReaderFailures()`), a caller says to reload: Chromium keeps a failed import for as long as the page lives.
 */
export class QrReaderNotLoaded extends Error {}
let decoder: Promise<typeof import("jsqr").default> | null = null, decoderFailures = 0;
export const qrDecoder = () => (decoder ??= import("jsqr").then((module) => module.default, (cause: unknown) => { decoder = null; decoderFailures++; throw new QrReaderNotLoaded(String(cause)); }));
/** How many times the decoder failed to load in this page. */
export const qrReaderFailures = () => decoderFailures;

/** The largest picture a QR is read from, opened, dropped or pasted. */
export const QR_IMAGE_MAX = 12 * 1024 * 1024;

/**
 * The QR in a picture, or null when it shows none. Throws `QrReaderNotLoaded`, or what reading the picture threw.
 * Decoded in a worker: on the page a phone photo held the app for seconds. Where the worker fails, on the page.
 */
export async function readQrImage(file: Blob): Promise<string | null> {
  const jsQR = await qrDecoder();
  if (!await decodablePicture(file)) throw new Error("This picture cannot be read here");
  const bitmap = await createImageBitmap(file);
  const decode = frameDecoder(jsQR);
  try {
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas"); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const pixels = () => { context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); return context.getImageData(0, 0, canvas.width, canvas.height); };
    const text = await decode(pixels());
    // The pixels went to the worker that failed: drawn again for the page.
    return text !== undefined ? text : (await decode(pixels())) ?? null;
  } finally { decode.close(); bitmap.close(); }
}

/** The camera that faces away, for scanning; the caller stops its tracks. */
export async function qrCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("unsupported");
  return navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
}

/**
 * Reads the playing video's frames while `live()`, one at a time with 160 ms between them, handing each QR found to
 * `found`, which says whether to stop. A frame is decoded in a worker: on the page each one held the app for tens of
 * milliseconds, hundreds in low light. Where no worker starts or its script does not load, `jsQR` decodes on the page.
 */
export function scanQrFrames(element: HTMLVideoElement, jsQR: Awaited<ReturnType<typeof qrDecoder>>, live: () => boolean, found: (data: string) => boolean): void {
  const canvas = document.createElement("canvas"), context = canvas.getContext("2d", { willReadFrequently: true })!;
  const decode = frameDecoder(jsQR);
  const tick = async () => {
    if (!live()) { decode.close(); return; }
    if (element.readyState >= 2 && element.videoWidth) {
      const scale = Math.min(1, 960 / element.videoWidth);
      canvas.width = Math.round(element.videoWidth * scale); canvas.height = Math.round(element.videoHeight * scale);
      context.drawImage(element, 0, 0, canvas.width, canvas.height);
      const text = await decode(context.getImageData(0, 0, canvas.width, canvas.height));
      if (!live()) { decode.close(); return; }
      if (typeof text === "string" && found(text)) { decode.close(); return; }
    }
    window.setTimeout(() => void tick(), 160);
  };
  void tick();
}

/**
 * One frame at a time to the worker (its pixels handed over, not copied), or to `jsQR` on the page: the QR's text, or
 * null when it shows none. A worker that fails (its script did not load) answers its frame with `undefined`, not read,
 * and the frames after it are decoded on the page.
 */
function frameDecoder(jsQR: Awaited<ReturnType<typeof qrDecoder>>) {
  let worker: Worker | null = null;
  try { worker = new Worker(new URL("./qrFrames.worker.ts", import.meta.url), { type: "module" }); } catch { /* decoded on the page */ }
  let answer: ((text: string | null | undefined) => void) | null = null;
  const answered = (text: string | null | undefined) => { const resolve = answer; answer = null; resolve?.(text); };
  worker?.addEventListener("message", (event: MessageEvent<{ text: string | null }>) => answered(event.data.text));
  worker?.addEventListener("error", () => { worker?.terminate(); worker = null; answered(undefined); });
  const decode = (pixels: ImageData): Promise<string | null | undefined> => {
    if (!worker) return Promise.resolve(jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "attemptBoth" })?.data ?? null);
    const to = worker;
    return new Promise((resolve) => {
      answer = resolve;
      to.postMessage({ pixels: pixels.data, width: pixels.width, height: pixels.height }, [pixels.data.buffer]);
    });
  };
  return Object.assign(decode, { close: () => { worker?.terminate(); worker = null; } });
}
