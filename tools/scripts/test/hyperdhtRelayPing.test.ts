import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: transport.hyperdht-relay

/**
 * A client's ping frames are what it sends like any message: they count against its byte budget, and the relay holds at
 * most one pong for it unwritten, answering the latest ping once that one is written.
 */

/** A raw WebSocket on the relay that has upgraded and then stops reading. */
const upgraded = (port: number) => new Promise<Socket>((resolve, reject) => {
  const socket = connect(port, "127.0.0.1");
  socket.on("error", reject);
  socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  let head = "";
  const onData = (chunk: Buffer) => {
    head += chunk.toString("latin1");
    if (!head.includes("\r\n\r\n")) return;
    socket.off("data", onData);
    socket.pause();
    if (head.startsWith("HTTP/1.1 101")) resolve(socket); else reject(new Error(head.split("\r\n")[0]));
  };
  socket.on("data", onData);
});

/** `count` masked ping frames of 125 bytes each, the largest a control frame may carry. */
const pings = (count: number) => {
  const frame = Buffer.concat([Buffer.from([0x89, 0x80 | 125]), Buffer.alloc(4), Buffer.alloc(125, 0x61)]);
  const all = Buffer.allocUnsafe(frame.length * count);
  for (let at = 0; at < all.length; at += frame.length) frame.copy(all, at);
  return all;
};

it("holds next to nothing for a client that sends ping frames as fast as it can and reads none of the pongs", async () => {
  const relay = await startRelay({ testnet: 2 });
  // About 50 MB of pings, made before the count starts: the client's own pending write is this same buffer.
  const frames = pings(400_000);
  let socket: Socket | undefined;
  try {
    socket = await upgraded(relay.port);
    socket.on("error", () => {});
    const before = process.memoryUsage().arrayBuffers;
    let most = 0;
    const sampling = setInterval(() => { most = Math.max(most, process.memoryUsage().arrayBuffers - before); }, 20);
    socket.write(frames);
    await new Promise(resolve => setTimeout(resolve, 2_000));
    clearInterval(sampling);
    most = Math.max(most, process.memoryUsage().arrayBuffers - before);
    // Without the budget every ping was read and answered within a second: ~50 MB of pongs held for a client that
    // reads none, until the relay's next write to it (a heartbeat every 15 s).
    expect(most).toBeLessThan(8 * 1024 * 1024);
    // The client itself stays (its idle and ping deadlines drop it as any other), and so does everyone else.
    expect(relay.stats()).toMatchObject({ clients: 1, dropped: 0 });
  } finally {
    socket?.destroy();
    await relay.close();
  }
}, 30_000);

it("answers a client's pings with their payload, the latest one last, and keeps it", async () => {
  const relay = await startRelay({ testnet: 2 });
  const ws = new WebSocket(relay.url);
  try {
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const pongs: string[] = [];
    ws.on("pong", data => { pongs.push(data.toString()); });
    ws.ping(Buffer.from("alone"));
    await vi.waitFor(() => expect(pongs).toEqual(["alone"]));
    // Sent at once: the relay may answer only some of them, but always in order and the last one.
    const sent = Array.from({ length: 20 }, (_, i) => `ping ${i}`);
    for (const ping of sent) ws.ping(Buffer.from(ping));
    await vi.waitFor(() => expect(pongs.at(-1)).toBe("ping 19"));
    const order = pongs.slice(1).map(pong => sent.indexOf(pong));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]))).toBe(true);
    expect(relay.stats()).toMatchObject({ clients: 1, dropped: 0 });
  } finally {
    ws.terminate();
    await relay.close();
  }
}, 30_000);
