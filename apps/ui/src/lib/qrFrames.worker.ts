import jsQR from "jsqr";

/** Decodes a camera frame's QR away from the page: a frame takes tens of milliseconds, hundreds in low light. */
self.onmessage = (event: MessageEvent<{ pixels: Uint8ClampedArray; width: number; height: number }>) => {
  const { pixels, width, height } = event.data;
  self.postMessage({ text: jsQR(pixels, width, height, { inversionAttempts: "attemptBoth" })?.data ?? null });
};
