import { captureCamera } from "./mediaDevices";
import { decodablePicture } from "./decodablePicture";

/**
 * Reading a QR code, shared by Join and the wallet's Send: from the camera, frame by frame, or from a picture (opened,
 * pasted or dropped). Scanned text is only data: each caller parses it as what it expects, never opens or runs it.
 *
 * The decoder (about 127 KiB) is loaded when a scan or a picture read first needs it, not with the first screen: in
 * the decoding worker, and on the page (`qrDecoder`) only where that worker fails. Loaded once; a load that failed is
 * tried again the next time. A load that failed (offline, or a deploy replaced the chunk under an open tab) is said as
 * such, never as the camera or the picture: `QrReaderNotLoaded`. Once it failed twice (`qrReaderFailures()`), a
 * caller says to reload: Chromium keeps a failed import for as long as the page lives.
 */
export class QrReaderNotLoaded extends Error {}
let decoder: Promise<typeof import("jsqr").default> | null = null, decoderFailures = 0;
const qrDecoder = () => (decoder ??= import("jsqr").then((module) => module.default, (cause: unknown) => { decoder = null; decoderFailures++; throw new QrReaderNotLoaded(String(cause)); }));
/** How many times the decoder failed to load in this page. */
export const qrReaderFailures = () => decoderFailures;

/** The largest picture a QR is read from, opened, dropped or pasted. */
export const QR_IMAGE_MAX = 12 * 1024 * 1024;

/**
 * The QR in a picture, or null when it shows none. Throws `QrReaderNotLoaded`, or what reading the picture threw.
 * Decoded in a worker: on the page a phone photo held the app for seconds. Where the worker fails, on the page.
 */
export async function readQrImage(file: Blob): Promise<string | null> {
  // The worker starts while the picture is read: its own decoder downloads with it, the page's only if it fails.
  const decode = qrFrameReader();
  let bitmap: ImageBitmap | null = null;
  try {
    await decode.ready;
    if (!await decodablePicture(file)) throw new Error("This picture cannot be read here");
    const picture = bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2048 / Math.max(picture.width, picture.height));
    const canvas = document.createElement("canvas"); canvas.width = Math.round(picture.width * scale); canvas.height = Math.round(picture.height * scale);
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const pixels = () => { context.drawImage(picture, 0, 0, canvas.width, canvas.height); return context.getImageData(0, 0, canvas.width, canvas.height); };
    const text = await decode(pixels());
    // The pixels went to the worker that failed: drawn again for the page.
    return text !== undefined ? text : (await decode(pixels())) ?? null;
  } finally { decode.close(); bitmap?.close(); }
}

/** The camera that faces away, for scanning; the caller stops its tracks. */
export function qrCamera(): Promise<MediaStream> {
  return captureCamera({ video: { facingMode: { ideal: "environment" } }, audio: false });
}

/**
 * Reads the playing video's frames while `live()`, one at a time with 160 ms between them, handing each QR found to
 * `found`, which says whether to stop. A frame is decoded in a worker: on the page each one held the app for tens of
 * milliseconds, hundreds in low light. Where no worker starts or its script does not load, on the page. Ends `decode`
 * with the scan; rejects with `QrReaderNotLoaded` when the page's decoder had to load and did not.
 */
export async function scanQrFrames(element: HTMLVideoElement, decode: QrFrameReader, live: () => boolean, found: (data: string) => boolean): Promise<void> {
  const canvas = document.createElement("canvas"), context = canvas.getContext("2d", { willReadFrequently: true })!;
  try {
    await decode.ready;
    while (live()) {
      if (element.readyState >= 2 && element.videoWidth) {
        const scale = Math.min(1, 960 / element.videoWidth);
        canvas.width = Math.round(element.videoWidth * scale); canvas.height = Math.round(element.videoHeight * scale);
        context.drawImage(element, 0, 0, canvas.width, canvas.height);
        const text = await decode(context.getImageData(0, 0, canvas.width, canvas.height));
        if (!live() || (typeof text === "string" && found(text))) return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 160));
    }
  } finally { decode.close(); }
}

export type QrFrameReader = ReturnType<typeof qrFrameReader>;
/**
 * Decodes frames one at a time in a worker started at once (its pixels handed over, not copied), or on the page: the
 * QR's text, or null when it shows none. The page loads its own decoder only where no worker starts or its script does
 * not load, so a read downloads one copy, not two. A worker that fails answers its frame with `undefined`, not read,
 * and the frames after it are decoded on the page. `ready` waits for the page's decoder where no worker started (and
 * rejects with `QrReaderNotLoaded`). Started with the camera or the picture; ended with `close`.
 */
export function qrFrameReader() {
  let worker: Worker | null = null;
  try { worker = new Worker(new URL("./qrFrames.worker.ts", import.meta.url), { type: "module" }); } catch { /* decoded on the page */ }
  // Tried once per reader: a failure counts once in `qrReaderFailures()`.
  let page: ReturnType<typeof qrDecoder> | null = null;
  const onPage = () => (page ??= qrDecoder());
  const ready = worker ? Promise.resolve() : onPage().then(() => {});
  ready.catch(() => {});
  let answer: ((text: string | null | undefined) => void) | null = null;
  const answered = (text: string | null | undefined) => { const resolve = answer; answer = null; resolve?.(text); };
  worker?.addEventListener("message", (event: MessageEvent<{ text: string | null }>) => answered(event.data.text));
  worker?.addEventListener("error", () => { worker?.terminate(); worker = null; answered(undefined); });
  const decode = async (pixels: ImageData): Promise<string | null | undefined> => {
    if (!worker) return (await onPage())(pixels.data, pixels.width, pixels.height, { inversionAttempts: "attemptBoth" })?.data ?? null;
    const to = worker;
    return new Promise((resolve) => {
      answer = resolve;
      to.postMessage({ pixels: pixels.data, width: pixels.width, height: pixels.height }, [pixels.data.buffer]);
    });
  };
  return Object.assign(decode, { ready, close: () => { worker?.terminate(); worker = null; } });
}
