import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { GhostlyHttpError, LIMITS, type ClientResponse } from "@ghostly/core";
import { openServiceServer, type OpenedService, type ServiceSend } from "../src/services";

// covers: headless.services

interface Reply { status: number; headers: Record<string, string | string[] | undefined> }

function get(opened: OpenedService, path: string, { host = opened.host, cookie, method = "GET", body }: { host?: string; cookie?: string; method?: string; body?: Buffer } = {}): Promise<Reply> {
  const port = Number(opened.host.split(":")[1]);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: { host, ...(cookie ? { cookie } : {}) } }, (res) => {
      res.resume();
      res.on("close", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const servers: OpenedService[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>((r) => s.server.close(() => r())); });

async function opened(send: ServiceSend): Promise<{ service: OpenedService; cookie: string }> {
  const service = await openServiceServer(send);
  servers.push(service);
  const first = await get(service, new URL(service.url).pathname);
  return { service, cookie: String(first.headers["set-cookie"]).split(";")[0] };
}

/** A header Node refuses to write: the answer fails before its status line goes out (a 502). */
const unwritable: ClientResponse = { status: 200, headers: [["bad header", "x"]], body: (async function* () { /* nothing */ })(), bytes: async () => new Uint8Array() };

describe("this machine's own answers on an opened service's origin", () => {
  it("load and reach nothing, and are not sniffed: a page of the app that frames one cannot send from it past its own policy", async () => {
    const { service, cookie } = await opened(async (request) => {
      if (request.path === "/gone") throw new GhostlyHttpError("offline", "offline");
      return unwritable;
    });
    const replies = [
      [404, await get(service, "/.ghostly-open/wrong", { cookie })],
      [404, await get(service, "/", {})],
      [404, await get(service, "/", { host: "other.localhost", cookie })],
      [303, await get(service, new URL(service.url).pathname)],
      [503, await get(service, "/gone", { cookie })],
      [502, await get(service, "/bad", { cookie })],
      [413, await get(service, "/upload", { cookie, method: "POST", body: Buffer.alloc(LIMITS.maxRequestBodyBytes + 1) })],
    ] as const;
    for (const [status, reply] of replies) {
      expect(reply.status).toBe(status);
      expect(reply.headers["content-security-policy"]).toBe("default-src 'none'; form-action 'none'; base-uri 'none'");
      expect(reply.headers["x-content-type-options"]).toBe("nosniff");
    }
  });
});
