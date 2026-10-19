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

/** The QR in a picture, or null when it shows none. Throws `QrReaderNotLoaded`, or what reading the picture threw. */
export async function readQrImage(file: Blob): Promise<string | null> {
  const jsQR = await qrDecoder();
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas"); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = context.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(data.data, data.width, data.height, { inversionAttempts: "attemptBoth" })?.data ?? null;
  } finally { bitmap.close(); }
}

/** The camera that faces away, for scanning; the caller stops its tracks. */
export async function qrCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("unsupported");
  return navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
}

/**
 * Reads the playing video's frames about six times a second while `live()`, handing each QR found to `found`, which
 * says whether to stop.
 */
export function scanQrFrames(element: HTMLVideoElement, jsQR: Awaited<ReturnType<typeof qrDecoder>>, live: () => boolean, found: (data: string) => boolean): void {
  const canvas = document.createElement("canvas"), context = canvas.getContext("2d", { willReadFrequently: true })!;
  const tick = () => {
    if (!live()) return;
    if (element.readyState >= 2 && element.videoWidth) {
      const scale = Math.min(1, 960 / element.videoWidth);
      canvas.width = Math.round(element.videoWidth * scale); canvas.height = Math.round(element.videoHeight * scale);
      context.drawImage(element, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const qr = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "attemptBoth" });
      if (qr && found(qr.data)) return;
    }
    window.setTimeout(tick, 160);
  };
  tick();
}
