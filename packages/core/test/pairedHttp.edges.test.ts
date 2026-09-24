import { describe, expect, it, vi } from "vitest";
import { toBase64Url, utf8Decode, utf8Encode } from "../src/bytes";
import { CHUNK_KIND, LIMITS, encodeChunk, encodeControl, type FrameChannel } from "../src/frames";
import { parseLocalTarget, type LocalFetch } from "../src/http";
import { PairedHttp } from "../src/pairedHttp";

// covers: services.http

/** One PairedHttp on a channel that records the `ph` frames it sends; peer frames are fed by hand. */
function side(localFetch: LocalFetch = vi.fn<LocalFetch>(() => new Promise(() => {}))) {
  const sent: Record<string, unknown>[] = [];
  const channel: FrameChannel = {
    bufferedAmount: 77, drained: vi.fn(async () => {}), close: vi.fn(), onMessage: null, onClose: null,
    send: (data) => void sent.push(JSON.parse(String(data))),
  };
  const http = new PairedHttp(channel, (id) => (id === "atlas" ? { id, target: parseLocalTarget("localhost:3400") } : undefined), localFetch);
  return { http, sent, channel, localFetch };
}
const control = (frame: Parameters<typeof encodeControl>[0]) => ({ t: "ph", c: encodeControl(frame) });
const chunk = (kind: 1 | 2 | 3, id: number, end: boolean, payload: Uint8Array) => ({ t: "ph", b: toBase64Url(encodeChunk({ kind, id, end, payload })) });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("paired http tunnel", () => {
  it("wraps control frames as text and chunks as base64url, never raw bytes", async () => {
    const s = side(async () => ({ status: 200, headers: [], body: [utf8Encode("hi")] }));
    s.http.handle(control({ t: "req", id: 4, s: "atlas", m: "GET", p: "/", h: [], b: false }));
    await flush();
    expect(s.sent.every((f) => f.t === "ph" && (typeof f.c === "string") !== (typeof f.b === "string"))).toBe(true);
    expect(s.sent[0]).toEqual({ t: "ph", c: encodeControl({ t: "res", id: 4, st: 200, h: [], b: true }) });
    expect(s.sent[1]).toEqual(chunk(CHUNK_KIND.responseBody, 4, false, utf8Encode("hi")));
  });

  it("honours the paired channel's backpressure while streaming a body", async () => {
    const s = side(async () => ({ status: 200, headers: [], body: [utf8Encode("hi")] }));
    (s.channel as { bufferedAmount: number }).bufferedAmount = LIMITS.sendHighWaterMark + 1;
    s.http.handle(control({ t: "req", id: 1, s: "atlas", m: "GET", p: "/", h: [], b: false }));
    await flush();
    expect(s.channel.drained).toHaveBeenCalled();
    expect(s.channel.close).not.toHaveBeenCalled();
  });

  it("ignores frames that carry neither a control frame nor a chunk, or carry garbage", async () => {
    const s = side();
    for (const frame of [{}, { t: "ph" }, { t: "ph", c: 5 }, { t: "ph", c: "{" }, { t: "ph", c: '{"t":"nope"}' }, { t: "ph", b: "***" }, { t: "ph", b: toBase64Url(Uint8Array.of(9, 0, 0, 0, 1, 0)) }, { t: "ph", b: "" }]) {
      expect(() => s.http.handle(frame)).not.toThrow();
    }
    await flush();
    expect(s.sent).toEqual([]);
    expect(s.localFetch).not.toHaveBeenCalled();
  });

  it("routes control frames it does not handle nowhere", async () => {
    const s = side();
    s.http.handle(control({ t: "m", ts: 1, m: "hi" }));
    s.http.handle(control({ t: "rst", id: 1, d: "f", e: "" }));
    s.http.handle(chunk(CHUNK_KIND.fileBody, 1, true, Uint8Array.of(1)));
    await flush();
    expect(s.sent).toEqual([]);
  });

  it("delivers request bodies to the host and response bodies to the client, never crossed", async () => {
    const bodies: string[] = [];
    const s = side(async (request) => (bodies.push(utf8Decode(request.body ?? new Uint8Array())), { status: 204, headers: [], body: null }));
    s.http.handle(control({ t: "req", id: 1, s: "atlas", m: "POST", p: "/", h: [], b: true }));
    // A response chunk with the same stream id must not feed the request body.
    s.http.handle(chunk(CHUNK_KIND.responseBody, 1, false, utf8Encode("wrong")));
    s.http.handle(chunk(CHUNK_KIND.requestBody, 1, true, utf8Encode("right")));
    await flush();
    expect(bodies).toEqual(["right"]);
  });

  it("lets the client's reset (d=q) stop the host's local fetch", async () => {
    let signal!: AbortSignal;
    const s = side((request) => ((signal = request.signal), new Promise(() => {})));
    s.http.handle(control({ t: "req", id: 1, s: "atlas", m: "GET", p: "/", h: [], b: false }));
    await flush();
    s.http.handle(control({ t: "rst", id: 1, d: "s", e: "" }));
    expect(signal.aborted).toBe(false);
    s.http.handle(control({ t: "rst", id: 1, d: "q", e: "" }));
    expect(signal.aborted).toBe(true);
  });

  it("lets the host's reset (d=s) fail the client's response body", async () => {
    const s = side();
    const pending = s.http.client.request("atlas", { method: "GET", path: "/" });
    s.http.handle(control({ t: "res", id: 1, st: 200, h: [], b: true }));
    const response = await pending;
    s.http.handle(chunk(CHUNK_KIND.responseBody, 1, false, utf8Encode("part")));
    s.http.handle(control({ t: "rst", id: 1, d: "q", e: "" })); // aimed at the host side: no effect here
    s.http.handle(control({ t: "rst", id: 1, d: "s", e: "dropped" }));
    await expect(response.bytes()).rejects.toMatchObject({ code: "reset", message: "dropped" });
  });

  it("fails the client's requests and aborts the host's when closed", async () => {
    let signal!: AbortSignal;
    const s = side((request) => ((signal = request.signal), new Promise(() => {})));
    s.http.handle(control({ t: "req", id: 1, s: "atlas", m: "GET", p: "/", h: [], b: false }));
    const pending = s.http.client.request("atlas", { method: "GET", path: "/" });
    await flush();
    s.http.close();
    expect(signal.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "closed" });
  });
});
