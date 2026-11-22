import { describe, expect, it } from "vitest";
import { utf8Decode } from "../src/bytes";
import { LIMITS, decodeChunk, decodeControl, type FrameChannel, type HeaderList } from "../src/frames";
import { GhostlyHttpError, HttpClient, HttpHost, parseLocalTarget, type ClientResponse, type LocalFetch } from "../src/http";

// covers: services.http, core.frames

/** A client and a host on the two ends of one link, each reading what the other sends as the link decodes it. */
function link(localFetch: LocalFetch) {
  const sent: string[] = [];
  const end = (deliver: (data: string | Uint8Array) => void): FrameChannel => ({
    bufferedAmount: 0, drained: async () => {}, close() {}, onMessage: null, onClose: null,
    send(data) {
      if (typeof data === "string") sent.push(data);
      queueMicrotask(() => deliver(data));
    },
  });
  const service = { id: "atlas", target: parseLocalTarget("localhost:3400") };
  const host: HttpHost = new HttpHost(end((data) => {
    if (typeof data !== "string") return client.handleChunk(decodeChunk(data)!);
    const frame = decodeControl(data);
    if (frame?.t === "res") client.handleResponse(frame);
    else if (frame?.t === "rst") client.handleReset(frame);
  }), (id) => (id === service.id ? service : undefined), localFetch);
  const client: HttpClient = new HttpClient(end((data) => {
    if (typeof data !== "string") return host.handleChunk(decodeChunk(data)!);
    const frame = decodeControl(data);
    if (frame?.t === "req") host.handleRequest(frame);
    else if (frame?.t === "rst") host.handleReset(frame);
  }));
  return { client, sent };
}

/** What a request came to by the time the link has carried everything it was given, without waiting on any timer. */
async function settled(pending: Promise<ClientResponse>): Promise<ClientResponse | GhostlyHttpError | "waiting"> {
  const outcome = pending.catch((error: GhostlyHttpError) => error);
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
  return Promise.race([outcome, Promise.resolve("waiting" as const)]);
}

const answer = (headers: HeaderList): LocalFetch => async () => ({ status: 200, headers, body: [new TextEncoder().encode("ok")] });

describe("headers past the link's limits", () => {
  it.each([
    ["a cookie past the value limit", [["cookie", "a".repeat(LIMITS.maxHeaderValueBytes + 1)]]],
    ["more headers than the link takes", Array.from({ length: LIMITS.maxHeaderCount + 1 }, (_, i): [string, string] => [`x-h${i}`, "1"])],
    ["a header name past its limit", [[`x-${"n".repeat(256)}`, "1"]]],
  ] as [string, HeaderList][])("refuses a request with %s at once, without sending it", async (_, headers) => {
    const t = link(answer([]));
    const outcome = await settled(t.client.request("atlas", { method: "GET", path: "/", headers }));
    expect(outcome).toBeInstanceOf(GhostlyHttpError);
    expect((outcome as GhostlyHttpError).code).toBe("headers-too-large");
    expect(t.sent).toEqual([]);
  });

  it("still sends a request whose headers are at the limits", async () => {
    const t = link(answer([]));
    const outcome = await settled(t.client.request("atlas", { method: "GET", path: "/", headers: [["cookie", "a".repeat(LIMITS.maxHeaderValueBytes)]] }));
    expect((outcome as ClientResponse).status).toBe(200);
  });

  it.each([
    ["a policy past the value limit", [["content-security-policy", `script-src ${"'sha256-x' ".repeat(1700)}`]]],
    ["more headers than the link takes", Array.from({ length: LIMITS.maxHeaderCount + 1 }, (_, i): [string, string] => [`x-h${i}`, "1"])],
  ] as [string, HeaderList][])("answers a local response with %s as 502 headers-too-large at once", async (_, headers) => {
    const t = link(answer(headers));
    const outcome = await settled(t.client.request("atlas", { method: "GET", path: "/" }));
    const response = outcome as ClientResponse;
    expect(response.status).toBe(502);
    expect(response.headers).toContainEqual(["x-ghostly-error", "headers-too-large"]);
    expect(utf8Decode(await response.bytes())).toMatch(/\n$/);
  });

  it("forwards a local response whose headers are at the limits", async () => {
    const t = link(answer([["content-security-policy", "a".repeat(LIMITS.maxHeaderValueBytes)]]));
    const response = (await settled(t.client.request("atlas", { method: "GET", path: "/" }))) as ClientResponse;
    expect(response.status).toBe(200);
    expect(utf8Decode(await response.bytes())).toBe("ok");
  });
});
