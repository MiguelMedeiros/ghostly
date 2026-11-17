import net from "node:net";
import { afterEach, expect, it } from "vitest";
import { startRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: transport.hyperdht-relay

/**
 * A client that sends a whole WebSocket upgrade and resets at once (a tab closed mid-connect, a phone changing
 * networks) has a closed socket by the time the relay opens its stream. That open must end there: a failed open that
 * rejects where nothing catches it was written as one `unhandled` line per client.
 */
const rejections: unknown[] = [];
const onRejection = (error: unknown) => { rejections.push(error); };
process.on("unhandledRejection", onRejection);
afterEach(() => { process.off("unhandledRejection", onRejection); });

const upgradeAndReset = (port: number) => new Promise<void>(resolve => {
  const socket = net.connect(port, "127.0.0.1", () => {
    socket.write([
      "GET / HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      "", "",
    ].join("\r\n"));
    socket.resetAndDestroy();
  });
  socket.on("error", () => {});
  socket.on("close", () => resolve());
});

it("ends the stream of a client that resets right after its upgrade, with nothing left unhandled", async () => {
  const lines: string[] = [];
  const relay = await startRelay({ testnet: 2, limits: { clientsPerAddress: 1000 }, log: (...words: unknown[]) => { lines.push(words.join(" ")); } });
  try {
    for (let i = 0; i < 200; i++) await upgradeAndReset(relay.port);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(relay.stats().accepted).toBeGreaterThan(0);
    expect(relay.stats().clients).toBe(0);
    expect(rejections).toEqual([]);
  } finally {
    await relay.close();
  }
}, 60_000);
