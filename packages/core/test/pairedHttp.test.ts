import { expect, it } from "vitest";
import { parseLocalTarget, utf8Decode, type FrameChannel, type LocalFetch } from "../src";
import { PairedHttp } from "../src/pairedHttp";
import { createChannelPair } from "./helpers";
// covers: services.http

/** Two sides of a paired session: only text application frames cross, as on the real channel. */
function paired(localFetch: LocalFetch, services: Record<string, string>) {
  const [a, b] = createChannelPair();
  const make = (channel: FrameChannel) => new PairedHttp(channel, (id) => services[id] ? { id, target: parseLocalTarget(services[id]) } : undefined, localFetch);
  const host = make(a), viewer = make(b);
  const deliver = (to: PairedHttp) => (data: string | Uint8Array) => {
    if (typeof data !== "string") throw new Error("paired application data is text");
    const frame = JSON.parse(data);
    if (frame.t === "ph") to.handle(frame);
  };
  a.onMessage = deliver(host); b.onMessage = deliver(viewer);
  return { host, viewer };
}

it("carries a request and a large binary response over text frames, intact", async () => {
  const big = new Uint8Array(70_000).map((_, i) => i % 251);
  const seen: string[] = [];
  const { viewer } = paired(async (request) => {
    seen.push(`${request.method} ${request.url}`);
    return { status: 200, headers: [["content-type", "application/octet-stream"]], body: [big] };
  }, { atlas: "localhost:3400" });
  const response = await viewer.client.request("atlas", { method: "GET", path: "/data?x=1" });
  expect(response.status).toBe(200);
  expect(await response.bytes()).toEqual(big);
  expect(seen).toEqual(["GET http://localhost:3400/data?x=1"]);
});

it("posts a body and refuses an app that was not granted", async () => {
  const { viewer } = paired(async (request) => ({ status: 201, headers: [], body: [request.body ?? new Uint8Array()] }), { atlas: "localhost:3400" });
  const posted = await viewer.client.request("atlas", { method: "POST", path: "/echo", body: new TextEncoder().encode("hello ghost") });
  expect(utf8Decode(await posted.bytes())).toBe("hello ghost");
  expect((await viewer.client.request("private", { method: "GET", path: "/" })).status).toBe(404);
});
