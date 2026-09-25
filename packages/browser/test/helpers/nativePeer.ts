import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { BoundChannel, FrameChannel, NativeBinding, NativeEndpoint } from "@ghostly/core";

/** `relays` homes the peer on those Iroh relays (so a browser peer can reach it); without it, loopback only. */
export async function nativePeer(binary: string, seed: number, options: { relays?: string[] } = {}): Promise<NativeEndpoint & { dropReceipts: boolean }> {
  const process = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
  const channels = new Map<number, BoundChannel>();
  const send = (value: object) => process.stdin.write(JSON.stringify(value) + "\n");
  let connectResolve: ((value: BoundChannel) => void) | undefined;
  let addressResolve!: (descriptor: unknown) => void;
  const address = new Promise<unknown>(resolve => { addressResolve = resolve; });
  const lifecycle: { endpoint?: NativeEndpoint & { dropReceipts: boolean } } = {};
  let failure = "";
  process.stderr.on("data", data => { failure += data.toString(); });
  createInterface({ input: process.stdout }).on("line", line => {
    const event = JSON.parse(line) as { type: string; id: number; text: string; binding: NativeBinding; descriptor: unknown };
    if (event.type === "address") { addressResolve(event.descriptor); return; }
    if (event.type === "open") {
      let reader: FrameChannel["onMessage"] = null;
      const pending: string[] = [];
      const channel: FrameChannel = {
        bufferedAmount: 0, drained: async () => {}, onClose: null,
        get onMessage() { return reader; },
        set onMessage(value) { reader = value; if (value) for (const text of pending.splice(0)) value(text); },
        send: text => { if (typeof text !== "string") throw new Error("Text only"); send({ type: "send", id: event.id, text }); },
        close: () => send({ type: "close", id: event.id }),
      };
      const bound = { channel, binding: event.binding };
      channels.set(event.id, bound);
      receivers.set(channel, text => { if (reader) reader(text); else pending.push(text); });
      if (connectResolve) { connectResolve(bound); connectResolve = undefined; }
      else lifecycle.endpoint?.onConnection?.(bound);
    } else if (event.type === "frame") {
      if (lifecycle.endpoint?.dropReceipts && event.text.includes('"t":"paired-received"')) return;
      const channel = channels.get(event.id)?.channel;
      if (channel) receivers.get(channel)?.(event.text);
    } else if (event.type === "closed") { channels.get(event.id)?.channel.onClose?.(); channels.delete(event.id); }
  });
  const receivers = new WeakMap<FrameChannel, (text: string) => void>();
  send({ seed: Array(32).fill(seed), ...(options.relays ? { relays: options.relays } : {}) });
  const descriptor = await Promise.race([address, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => { process.kill(); reject(new Error(`Native peer startup timeout: ${failure}`)); }, options.relays ? 15000 : 5000);
    timer.unref(); address.finally(() => clearTimeout(timer));
  })]);
  const endpoint: NativeEndpoint & { dropReceipts: boolean } = {
    transport: "iroh/1", descriptor, onConnection: null, onDescriptor: null, dropReceipts: false,
    connect(descriptor) { return new Promise<BoundChannel>(resolve => { connectResolve = resolve; send({ type: "connect", descriptor }); }); },
    async close() { process.stdin.end(); await new Promise<void>(resolve => { if (process.exitCode !== null) resolve(); else process.once("exit", () => resolve()); }); },
  };
  lifecycle.endpoint = endpoint;
  return endpoint;
}
