import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { startRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: transport.hyperdht-relay

/**
 * Each message a client sends costs its byte budget a share of its own, on top of its payload: a client that sends
 * empty or tiny messages runs out of budget as one that sends bytes does, and the relay stops reading it.
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
    if (head.startsWith("HTTP/1.1 101")) resolve(socket); else reject(new Error(head.split("\r\n")[0]));
  };
  socket.on("data", onData);
});

/** `count` masked binary frames with no payload. */
const empties = (count: number) => {
  const frame = Buffer.from([0x82, 0x80, 0, 0, 0, 0]);
  const all = Buffer.allocUnsafe(frame.length * count);
  for (let at = 0; at < all.length; at += frame.length) frame.copy(all, at);
  return all;
};

it("stops reading a client that sends a flood of empty messages, as it would one that sends their bytes", async () => {
  const relay = await startRelay({ testnet: 2, limits: { burstBytes: 64 * 1024, bytesPerSecond: 1024 * 1024 } });
  let socket: Socket | undefined;
  try {
    socket = await upgraded(relay.port);
    socket.on("error", () => {});
    // 200,000 empty messages (1.2 MB on the wire), then a ping: the relay answers it once it has read what came first.
    let ponged = 0;
    socket.on("data", (chunk: Buffer) => { if (chunk.includes(Buffer.from([0x8a, 0x04]))) ponged = performance.now(); });
    const start = performance.now();
    socket.write(empties(200_000));
    socket.write(Buffer.concat([Buffer.from([0x89, 0x84, 0, 0, 0, 0]), Buffer.from("last")]));
    await new Promise(resolve => setTimeout(resolve, 3_000));
    // Before: an empty message cost nothing, so all of them were read at once and the ping answered within a second.
    // Now each costs its share, well past the burst, and the relay is still holding off reading the client.
    expect(ponged).toBe(0);
    expect(relay.stats()).toMatchObject({ clients: 1, dropped: 0 });
    // It is read again as its budget refills, and answered.
    await new Promise<void>(resolve => { const wait = setInterval(() => { if (ponged) { clearInterval(wait); resolve(); } }, 50); });
    expect(ponged - start).toBeGreaterThan(3_000);
  } finally {
    socket?.destroy();
    await relay.close();
  }
}, 60_000);
