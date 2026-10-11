import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LNURL_LIMITS, fetchLnurlJson } from "../src";

/** A fetcher that answers from a table: a string is a redirect's `Location`, anything else is the JSON body. */
function table(routes: Record<string, unknown>) {
  const asked: string[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    asked.push(url);
    expect(init?.redirect).toBe("manual");
    const route = routes[url];
    return typeof route === "string" ? new Response(null, { status: 302, headers: { location: route } }) : new Response(JSON.stringify(route ?? null), { status: route === undefined ? 404 : 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

describe("a redirect of an LNURL service", () => {
  const servers: Server[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done)))); });
  const serve = async (handler: (url: string) => { status: number; location?: string; body?: string }) => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? "");
      const { status, location, body } = handler(req.url ?? "");
      res.writeHead(status, location ? { location } : { "content-type": "application/json" }).end(body ?? "");
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return { port: (server.address() as AddressInfo).port, hits };
  };

  it("is checked before anything is sent to it: another plain-HTTP host is never asked", async () => {
    const other = await serve(() => ({ status: 200, body: '{"reached":true}' }));
    const service = await serve(() => ({ status: 302, location: `http://127.0.0.1:${other.port}/admin?do=1` }));
    await expect(fetchLnurlJson(`http://localhost:${service.port}/.well-known/lnurlp/alice`)).rejects.toThrow(/HTTPS/);
    expect(service.hits).toEqual(["/.well-known/lnurlp/alice"]);
    expect(other.hits).toEqual([]);
  });

  it("is followed on the same host, relative or absolute", async () => {
    const service = await serve((url) => url === "/a" ? { status: 301, location: "/b" } : url === "/b" ? { status: 307, location: `http://localhost:${service.port}/c` } : { status: 200, body: '{"ok":true}' });
    await expect(fetchLnurlJson(`http://localhost:${service.port}/a`)).resolves.toEqual({ ok: true });
    expect(service.hits).toEqual(["/a", "/b", "/c"]);
  });

  it("may lead to another HTTPS host at a public address, and to nothing the app refuses", async () => {
    const moved = table({ "https://ln.example.com/x": "https://pay.example.net/y", "https://pay.example.net/y": "https://[2606:4700::1111]/z", "https://[2606:4700::1111]/z": "https://93.184.215.14/w", "https://93.184.215.14/w": { ok: 1 } });
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: moved.fetch })).resolves.toEqual({ ok: 1 });
    expect(moved.asked).toEqual(["https://ln.example.com/x", "https://pay.example.net/y", "https://[2606:4700::1111]/z", "https://93.184.215.14/w"]);

    for (const [location, error] of [
      ["http://192.168.1.1/cgi-bin/reboot", /HTTPS/], ["http://localhost:8080/x", /HTTPS/], ["http://abcdefghijklmnop.onion/x", /HTTPS/],
      ["https://192.168.1.1/cgi-bin/reboot", /local address/], ["https://127.0.0.1:8443/x", /local address/], ["https://[::1]/x", /local address/],
      ["https://router/x", /local address/], ["https://nas.local/x", /local address/], ["https://[fd00::1]/x", /local address/], ["https://10.0.0.7/x", /local address/],
      ["https://u:p@pay.example.net/y", /credentials/], ["ftp://pay.example.net/y", /HTTPS/], ["https://", /invalid address/],
      [`https://pay.example.net/${"y".repeat(LNURL_LIMITS.maxUrlLength)}`, /too long/],
    ] as const) {
      const { fetch, asked } = table({ "https://ln.example.com/x": location });
      await expect(fetchLnurlJson("https://ln.example.com/x", { fetch })).rejects.toThrow(error);
      expect(asked).toEqual(["https://ln.example.com/x"]);
    }
  });

  it("stops after a few hops", async () => {
    const routes: Record<string, unknown> = {};
    for (let i = 0; i <= LNURL_LIMITS.maxRedirects; i++) routes[`https://ln.example.com/${i}`] = `/${i + 1}`;
    const loop = table(routes);
    await expect(fetchLnurlJson("https://ln.example.com/0", { fetch: loop.fetch })).rejects.toThrow("ln.example.com redirects too many times");
    expect(loop.asked).toHaveLength(LNURL_LIMITS.maxRedirects + 1);
    routes[`https://ln.example.com/${LNURL_LIMITS.maxRedirects}`] = { ok: 1 };
    await expect(fetchLnurlJson("https://ln.example.com/0", { fetch: table(routes).fetch })).resolves.toEqual({ ok: 1 });
  });

  it("is refused where the fetcher does not say where it leads (a browser)", async () => {
    const opaque = vi.fn(async () => { const r = new Response(null); Object.defineProperty(r, "type", { value: "opaqueredirect" }); return r; }) as unknown as typeof globalThis.fetch;
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: opaque })).rejects.toThrow("ln.example.com redirects to another address, which cannot be checked here");
    expect(opaque).toHaveBeenCalledTimes(1);
  });

  it("without a Location is an answer like any other", async () => {
    const bare = vi.fn(async () => new Response("{}", { status: 302 })) as unknown as typeof globalThis.fetch;
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: bare })).rejects.toThrow("ln.example.com answered HTTP 302");
  });
});
