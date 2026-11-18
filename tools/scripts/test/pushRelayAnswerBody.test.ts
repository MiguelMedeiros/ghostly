import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startRelay } from "../../../infra/services/push-relay/relay.mjs";

// covers: push.wake.send

const body = Buffer.from("encrypted").toString("base64url");

describe("the push relay and the push service's answer body (infra/services/push-relay)", () => {
  let close: (() => Promise<void>) | undefined;
  let upstream: Server | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
    vi.unstubAllGlobals();
    upstream?.closeAllConnections();
    await new Promise(done => upstream?.close(done) ?? done(undefined));
    upstream = undefined;
  });

  it("drops an answer's body it never reads, so a body that stalls does not hold the connection to the push service", async () => {
    // The push service sends its status and headers, one byte of the 100 it announced, then nothing: its own timers
    // are off, so only the relay can end the connection.
    upstream = createServer((_req, res) => {
      res.writeHead(201, { "Content-Length": "100" });
      res.write("x");
    });
    upstream.requestTimeout = 0;
    upstream.headersTimeout = 0;
    upstream.keepAliveTimeout = 0;
    // Whether the relay let go of its end, read on the push service's socket (`getConnections` lags behind it).
    const sockets: { open: boolean }[] = [];
    upstream.on("connection", socket => {
      const seen = { open: true };
      sockets.push(seen);
      socket.on("end", () => { seen.open = false; });
      socket.on("close", () => { seen.open = false; });
    });
    await new Promise<void>(done => upstream!.listen(0, "127.0.0.1", done));
    const { port } = upstream.address() as { port: number };

    const relay = await startRelay({ hosts: [/^127\.0\.0\.1$/], log: () => {} });
    close = relay.close;
    const real = globalThis.fetch;
    // The relay forwards only to https; the push service here is plain http on loopback.
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
      const url = String(input);
      return real(url.startsWith("https://127.0.0.1/") ? url.replace("https://127.0.0.1/", `http://127.0.0.1:${port}/`) : input, init);
    });

    const answer = await fetch(`http://127.0.0.1:${relay.port}/`, {
      method: "POST", headers: { Origin: "https://app.ghostly.tools" },
      body: JSON.stringify({ endpoint: "https://127.0.0.1/stall", headers: { Authorization: "vapid t=a.b.c, k=K" }, body }),
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ status: 201 });
    expect(sockets).toHaveLength(1);
    await vi.waitFor(() => expect(sockets).toEqual([{ open: false }]), { timeout: 3000, interval: 50 });
  });
});
