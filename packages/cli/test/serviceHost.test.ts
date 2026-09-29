import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { GhostlyHttpError, LIMITS, type ClientRequest, type ClientResponse } from "@ghostly/core";
import { keepServing } from "../src/host";
import { hostOnlyCookie, OPEN_COOKIE, openServiceServer, ownCookies, setCookieName, type OpenedService, type ServiceSend } from "../src/services";
// covers: headless.services

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: string; aborted: boolean }

/** A request to the opened service's port with any `Host` (fetch would not let a test set one). */
function get(opened: OpenedService, path: string, { host = opened.host, cookie, method = "GET", body }: { host?: string; cookie?: string; method?: string; body?: Buffer } = {}): Promise<Reply> {
  const port = Number(opened.host.split(":")[1]);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: { host, ...(cookie ? { cookie } : {}) } }, (res) => {
      const parts: Buffer[] = [];
      let aborted = false;
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("aborted", () => { aborted = true; });
      res.on("error", () => { aborted = true; });
      res.on("close", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString(), aborted: aborted || !res.complete }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function answer(status: number, headers: [string, string][], chunks: (string | Error)[]): ClientResponse {
  const body = (async function* () {
    for (const chunk of chunks) {
      await new Promise((r) => setTimeout(r, 5));
      if (chunk instanceof Error) throw chunk;
      yield new TextEncoder().encode(chunk);
    }
  })();
  return { status, headers, body, bytes: async () => { throw new Error("gathered, not streamed"); } };
}

const servers: OpenedService[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>((r) => s.server.close(() => r())); });

async function opened(send: ServiceSend): Promise<{ service: OpenedService; cookie: string }> {
  const service = await openServiceServer(send);
  servers.push(service);
  const url = new URL(service.url);
  const first = await get(service, url.pathname);
  const set = String(first.headers["set-cookie"]);
  return { service, cookie: set.split(";")[0] };
}

/** `service open`: the contact's app under a host name of its own, for the browser that was given the link. */
describe("an opened service's host and link", () => {
  it("is a random name under localhost; the link hands over an owner-only cookie and goes on to /", async () => {
    const seen: ClientRequest[] = [];
    const service = await openServiceServer(async (request) => { seen.push(request); return answer(200, [["content-type", "text/plain"]], ["hi"]); });
    servers.push(service);
    const url = new URL(service.url);
    expect(url.protocol).toBe("http:");
    expect(url.hostname).toMatch(/^[0-9a-f]{32}\.localhost$/);
    expect(url.pathname).toMatch(/^\/\.ghostly-open\/[0-9a-f]{64}$/);
    const first = await get(service, url.pathname);
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe("/");
    const set = String(first.headers["set-cookie"]);
    expect(set).toMatch(new RegExp(`^${OPEN_COOKIE}=[0-9a-f]{64}; Path=/; HttpOnly; SameSite=Lax$`));
    expect(set).not.toMatch(/domain/i);
    const page = await get(service, "/docs?x=1", { cookie: `${set.split(";")[0]}; other_app=secret` });
    expect(page.status).toBe(200);
    expect(page.body).toBe("hi");
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe("/docs?x=1");
    // This machine's cookie, and another app's, stay here.
    expect(seen[0].headers?.find(([name]) => name === "cookie")).toBeUndefined();
  });

  it("refuses another Host, a missing or wrong cookie, and a wrong link, with 404", async () => {
    let asked = 0;
    const { service, cookie } = await opened(async () => { asked++; return answer(200, [], ["hi"]); });
    const port = service.host.split(":")[1];
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `rebind.example:${port}`, `other.localhost:${port}`, service.host.split(":")[0]]) {
      expect((await get(service, "/", { host, cookie })).status).toBe(404);
    }
    expect((await get(service, "/")).status).toBe(404);
    expect((await get(service, "/", { cookie: `${OPEN_COOKIE}=${"0".repeat(64)}` })).status).toBe(404);
    expect((await get(service, "/.ghostly-open/" + "0".repeat(64))).status).toBe(404);
    expect((await get(service, "/.ghostly-open/")).status).toBe(404);
    expect(asked).toBe(0);
    expect((await get(service, "/", { host: service.host.toUpperCase(), cookie })).status).toBe(200);
    expect(asked).toBe(1);
  });

  it("keeps the service's cookies on its own host: Domain is dropped, and this machine's cookie cannot be set", async () => {
    const seen: ClientRequest[] = [];
    const { service, cookie } = await opened(async (request) => {
      seen.push(request);
      return answer(200, [["set-cookie", "sid=abc; Path=/; Domain=localhost; HttpOnly"], ["set-cookie", "theme=dark; domain=.localhost"], ["set-cookie", `${OPEN_COOKIE}=stolen; Path=/`]], ["ok"]);
    });
    const page = await get(service, "/", { cookie });
    expect(page.headers["set-cookie"]).toEqual(["sid=abc; Path=/; HttpOnly", "theme=dark"]);
    await get(service, "/", { cookie: `${cookie}; sid=abc; theme=dark; other_app=secret` });
    expect(seen[1].headers?.find(([name]) => name === "cookie")?.[1]).toBe("sid=abc; theme=dark");
  });
});

/** A contact's answer that breaks halfway (too large, or dropped) cuts the response; the daemon goes on serving. */
describe("an opened service's answers", () => {
  it("a body that fails after its headers ends the response short, and the next request is served", async () => {
    let n = 0;
    const { service, cookie } = await opened(async () => (++n === 1
      ? answer(200, [["content-type", "text/html"]], ["<p>start", new GhostlyHttpError("response-too-large", "Response body too large")])
      : answer(200, [["content-type", "text/plain"]], ["still here"])));
    const cut = await get(service, "/big", { cookie });
    expect(cut.status).toBe(200);
    expect(cut.aborted).toBe(true);
    expect(cut.body).toBe("<p>start");
    const next = await get(service, "/", { cookie });
    expect(next).toMatchObject({ status: 200, body: "still here", aborted: false });
  });

  it("streams the body as it comes, never gathering it", async () => {
    const { service, cookie } = await opened(async () => answer(200, [], ["a", "b", "c"]));
    expect(await get(service, "/", { cookie })).toMatchObject({ status: 200, body: "abc", aborted: false });
  });

  it("a contact that cannot be reached is a 503; a request that fails before an answer, a 502", async () => {
    const { service, cookie } = await opened(async (request) => {
      if (request.path === "/gone") throw new GhostlyHttpError("offline", "offline");
      return answer(200, [["bad header", "x"]], ["x"]);
    });
    expect((await get(service, "/gone", { cookie })).status).toBe(503);
    expect((await get(service, "/bad", { cookie })).status).toBe(502);
  });

  it("a request body over the limit is refused here with 413, never sent on", async () => {
    let asked = 0;
    const { service, cookie } = await opened(async () => { asked++; return answer(200, [], ["x"]); });
    const reply = await get(service, "/upload", { cookie, method: "POST", body: Buffer.alloc(LIMITS.maxRequestBodyBytes + 1) });
    expect(reply.status).toBe(413);
    expect(asked).toBe(0);
  });
});

describe("an opened service's cookies", () => {
  it("passes on only the cookies the service set itself, never this machine's", () => {
    const own = new Set(["sid", OPEN_COOKIE]);
    expect(ownCookies("other_app=secret; sid=abc; theme=dark", own)).toBe("sid=abc");
    expect(ownCookies(`other_app=secret; ${OPEN_COOKIE}=x`, own)).toBeNull();
    expect(ownCookies("sid=abc", new Set())).toBeNull();
    expect(ownCookies("  sid = abc ;junk", own)).toBe("sid = abc");
  });

  it("reads a Set-Cookie's name and makes it host-only", () => {
    expect(setCookieName("sid=abc; Path=/; HttpOnly")).toBe("sid");
    expect(setCookieName("sid=")).toBe("sid");
    expect(setCookieName("=abc")).toBeNull();
    expect(setCookieName("HttpOnly; sid=abc")).toBeNull();
    expect(hostOnlyCookie("sid=abc; Domain=localhost; Path=/")).toBe("sid=abc; Path=/");
    expect(hostOnlyCookie("sid=abc;DOMAIN = .localhost")).toBe("sid=abc");
    expect(hostOnlyCookie("sid=domain=x; Path=/")).toBe("sid=domain=x; Path=/");
    expect(hostOnlyCookie(`${OPEN_COOKIE}=x`)).toBeNull();
    expect(hostOnlyCookie("=x")).toBeNull();
  });
});

describe("the daemon's last resort", () => {
  it("says an error nobody caught, with its stack, and does not exit", () => {
    const proc = new EventEmitter();
    const lines: string[] = [];
    keepServing(proc as unknown as NodeJS.Process, (text) => lines.push(text));
    proc.emit("unhandledRejection", new Error("headers sent twice"));
    proc.emit("uncaughtException", new Error("thrown in a callback"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/unhandled rejection.*headers sent twice/s);
    expect(lines[0]).toMatch(/at /);
    expect(lines[1]).toMatch(/uncaught exception.*thrown in a callback/s);
  });
});
