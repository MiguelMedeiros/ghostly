import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: transport.hyperdht-relay

/**
 * A client's protomux opens one session, dht-relay's. Every other open it sends with a fresh id made the relay keep one
 * more slot for it until it left, at a few bytes each: a client that opens anything past its first is dropped.
 */

/** protomux's varint (compact-encoding uint) for the small numbers here. */
const uint = (n: number) => n < 0xfd ? [n] : n <= 0xffff ? [0xfd, n & 0xff, n >> 8] : [0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
/** An open-session message's body: type 1, the client's id for it, the protocol, no id. */
const open = (id: number, protocol: string) => [1, ...uint(id), ...uint(protocol.length), ...Buffer.from(protocol), 0];
/** One control-session frame carrying the opens for `from`..`to` in a batch. */
const batch = (from: number, to: number, protocol: string) => {
  const body: number[] = [];
  for (let id = from; id <= to; id++) {
    const message = open(id, protocol);
    body.push(...uint(message.length), ...message);
  }
  return Buffer.from([0, 0, 0, ...body]);
};

const connected = async (url: string) => {
  const ws = new WebSocket(url);
  ws.on("error", () => {});
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return ws;
};

it("drops a client that opens sessions past dht-relay's", async () => {
  const relay = await startRelay({ testnet: 2 });
  try {
    const ws = await connected(relay.url);
    ws.send(Buffer.from([0, ...open(1, "@hyperswarm/dht-relay")]));
    ws.send(batch(2, 2_000, "nobody-serves-this"));
    await vi.waitFor(() => expect(relay.stats()).toMatchObject({ clients: 0, dropped: 1 }), { timeout: 5_000 });
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  } finally {
    await relay.close();
  }
}, 30_000);

it("keeps a client that opens only dht-relay's session", async () => {
  const relay = await startRelay({ testnet: 2 });
  const ws = await connected(relay.url);
  try {
    ws.send(Buffer.from([0, ...open(1, "@hyperswarm/dht-relay")]));
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    await vi.waitFor(() => expect(relay.stats()).toMatchObject({ clients: 1, dropped: 0 }));
  } finally {
    ws.terminate();
    await relay.close();
  }
}, 30_000);
