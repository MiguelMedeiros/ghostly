import type { FrameChannel } from "../src/frames";

/** Two in-memory channels wired back to back, delivering asynchronously like a DataChannel. */
export function createChannelPair(): [FrameChannel, FrameChannel] {
  const make = (): FrameChannel & { peer?: FrameChannel; closed: boolean } => ({
    closed: false,
    bufferedAmount: 0,
    onMessage: null,
    onClose: null,
    drained: () => Promise.resolve(),
    send(data) {
      if (this.closed) throw new Error("Data link is not open");
      const copy = typeof data === "string" ? data : data.slice();
      queueMicrotask(() => this.peer?.onMessage?.(copy));
    },
    close() {
      if (this.closed) return;
      this.closed = true;
      this.onClose?.();
      this.peer?.close();
    },
  });
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
