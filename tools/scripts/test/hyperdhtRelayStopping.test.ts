import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: transport.hyperdht-relay

/**
 * While the relay stops, it waits up to `stopMs` for its clients to answer the going-away close (1001). A client that
 * never reads it (a sleeping laptop) makes that wait last; one that redialled at once on its 1001 was let in again by
 * the stopping relay, then cut at the end of the wait with 1006, and `/healthz` still sent new clients to it.
 */
it("refuses new WebSockets and reads unhealthy while it stops, and closes each client it held with 1001", async () => {
  const relay = await startRelay({ testnet: 3 });
  const open = async () => {
    const ws = new WebSocket(relay.url);
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    return ws;
  };
  const sleeping = await open();
  (sleeping as unknown as { _socket: { pause(): void } })._socket.pause();
  sleeping.on("error", () => {});
  const awake = await open();
  const awakeClosed = new Promise<number>((resolve) => awake.once("close", (code) => resolve(code)));
  await vi.waitFor(() => expect(relay.stats()).toMatchObject({ clients: 2, accepted: 2 }));
  const closing = relay.close();
  try {
    expect(await awakeClosed).toBe(1001);
    const late = new WebSocket(relay.url);
    const answer = await new Promise<{ status?: number; retryAfter?: string; opened?: true }>((resolve) => {
      late.once("open", () => resolve({ opened: true }));
      late.once("unexpected-response", (_request, response) => resolve({ status: response.statusCode, retryAfter: response.headers["retry-after"] }));
      late.once("error", () => {});
    });
    late.terminate();
    expect(answer).toEqual({ status: 503, retryAfter: "1" });
    const health = await fetch(`${relay.url.replace(/^ws/, "http")}/healthz`);
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ ok: false, stopping: true });
    expect(relay.stats()).toMatchObject({ accepted: 2, refused: 1 });
  } finally {
    await closing;
  }
}, 30_000);
