import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { startRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: transport.hyperdht-relay

/**
 * What an address's clients send is bounded together: its WebSockets share one byte budget, and a WebSocket it opens
 * after closing another starts from what is left of it, not from a full one. Another address has a budget of its own.
 */

const KiB = 1024;
// 64 KiB at once, 8 KiB a second after it: each client below sends 48 KiB, within the budget on its own.
const limits = { burstBytes: 64 * KiB, bytesPerSecond: 8 * KiB };

/** A raw WebSocket on the relay, upgraded, as from `address` (the relay counts one proxy in front). */
const upgraded = (port: number, address: string) => new Promise<Socket>((resolve, reject) => {
  const socket = connect(port, "127.0.0.1");
  socket.on("error", reject);
  socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Forwarded-For: ${address}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  let head = "";
  const onData = (chunk: Buffer) => {
    head += chunk.toString("latin1");
    if (!head.includes("\r\n\r\n")) return;
    socket.off("data", onData);
    socket.off("error", reject);
    socket.on("error", () => {});
    if (head.startsWith("HTTP/1.1 101")) resolve(socket); else reject(new Error(head.split("\r\n")[0]));
  };
  socket.on("data", onData);
});

/**
 * `bytes` of the budget as unasked pongs of 125 bytes, which the relay charges with 64 more each and otherwise ignores
 * (a protocol message it could not decode would drop the client).
 */
const spending = (bytes: number) => {
  const one = Buffer.concat([Buffer.from([0x8a, 0x80 | 125, 0, 0, 0, 0]), Buffer.alloc(125)]);
  return Buffer.concat(Array.from({ length: Math.ceil(bytes / (125 + 64)) }, () => one));
};
/** A masked ping carrying "last", and the pong answering it. */
const ping = Buffer.concat([Buffer.from([0x89, 0x84, 0, 0, 0, 0]), Buffer.from("last")]);
const pong = Buffer.concat([Buffer.from([0x8a, 0x04]), Buffer.from("last")]);

/** Whether the relay has answered the ping `socket` sends, read as it comes. */
const answers = (socket: Socket) => {
  const seen = { ponged: false };
  socket.on("data", (chunk: Buffer) => { if (chunk.includes(pong)) seen.ponged = true; });
  return seen;
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it("shares one byte budget among the WebSockets of one address, and not with another address", async () => {
  const relay = await startRelay({ testnet: 2, proxies: 1, limits });
  const sockets: Socket[] = [];
  try {
    // 16 clients from one address (all clientsPerAddress lets in), each sending 48 KiB: 768 KiB, the budget's 64 at once.
    for (let at = 0; at < 16; at++) sockets.push(await upgraded(relay.port, "192.0.2.1"));
    const seen = sockets.map(answers);
    for (const socket of sockets) socket.write(spending(48 * KiB));
    await wait(300);
    // Each ping comes after what its client sent, in a read of its own: a client the relay has stopped reading waits.
    for (const socket of sockets) socket.write(ping);
    // Another address, sending the same meanwhile, is read at once.
    const other = await upgraded(relay.port, "192.0.2.2");
    sockets.push(other);
    const otherSeen = answers(other);
    other.write(spending(48 * KiB));
    await wait(300);
    other.write(ping);
    await wait(1_000);
    // Before: each WebSocket had a budget of its own, all within it, and all 16 were answered at once.
    expect(seen.filter(({ ponged }) => ponged).length).toBeLessThanOrEqual(1);
    expect(otherSeen.ponged).toBe(true);
    expect(relay.stats()).toMatchObject({ clients: 17, dropped: 0 });
  } finally {
    for (const socket of sockets) socket.destroy();
    await relay.close();
  }
}, 30_000);

it("does not start a budget over for a WebSocket an address opens after closing another", async () => {
  const relay = await startRelay({ testnet: 2, proxies: 1, limits });
  const sockets: Socket[] = [];
  try {
    const first = await upgraded(relay.port, "192.0.2.1");
    sockets.push(first);
    first.write(spending(48 * KiB));
    await wait(300);
    first.end();
    await wait(100);
    // 32 KiB more from the same address: past what its 64 KiB had left, though a new WebSocket's own 64 KiB would hold it.
    const next = await upgraded(relay.port, "192.0.2.1");
    sockets.push(next);
    const seen = answers(next);
    next.write(spending(32 * KiB));
    await wait(300);
    next.write(ping);
    await wait(1_000);
    // Before: the new WebSocket started with a full budget, and was answered at once.
    expect(seen.ponged).toBe(false);
    expect(relay.stats()).toMatchObject({ clients: 1, dropped: 0 });
    // It is read again as the address's budget refills, and answered.
    await new Promise<void>(resolve => { const poll = setInterval(() => { if (seen.ponged) { clearInterval(poll); resolve(); } }, 50); });
  } finally {
    for (const socket of sockets) socket.destroy();
    await relay.close();
  }
}, 30_000);
