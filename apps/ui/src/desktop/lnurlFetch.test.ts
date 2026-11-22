import { describe, expect, it, vi } from "vitest";
import { fetchLnurlJson } from "@ghostly/core";
import { desktopLnurlFetch } from "./lnurlFetch";

const b64 = (text: string) => btoa(text);
const opaque = () => { const r = new Response(null); Object.defineProperty(r, "type", { value: "opaqueredirect" }); return r; };
const page = (response: () => Response) => vi.fn(async () => response()) as unknown as typeof fetch;
/** Rust: `hold_fetch` answers `read`, `link_preview_fetch` answers `followed`. */
const rust = (read: unknown, followed?: unknown) => vi.fn(async (command: string) => {
  const answer = command === "hold_fetch" ? read : followed;
  if (typeof answer === "string") throw answer;
  return answer;
});

describe("how Ghostly Desktop asks a Lightning address service", () => {
  it("asks from Rust on public addresses only, never from the page, and reads its answer", async () => {
    const invoke = rust({ status: 200, contentType: "application/json", bodyB64: b64('{"ok":1}') });
    const fetch = page(() => new Response('{"never":1}'));
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: desktopLnurlFetch(invoke as never, fetch) })).resolves.toEqual({ ok: 1 });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("hold_fetch", { url: "https://ln.example.com/x", headers: [["accept", "application/json"]] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says a service whose name leads to this machine or its network could not be reached, as Rust refuses it", async () => {
    const invoke = rust("unreachable: error sending request: dns error: 192.168.1.1 is not a public address");
    const fetch = page(() => new Response('{"reached":1}'));
    await expect(fetchLnurlJson("https://pay.example.com/.well-known/lnurlp/alice", { fetch: desktopLnurlFetch(invoke as never, fetch) })).rejects.toThrow(/Could not reach pay.example.com/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the service's own status, and a body Rust does not read", async () => {
    const invoke = rust({ status: 404, contentType: "", bodyB64: "" });
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: desktopLnurlFetch(invoke as never, page(opaque)) })).rejects.toThrow(/HTTP 404/);
  });

  it("asks a service that redirects again from Rust, which checks each hop, and reads its answer", async () => {
    const invoke = rust({ status: 302, contentType: "", bodyB64: "" }, { url: "https://pay.example.net/y", contentType: "application/json", bodyB64: b64('{"ok":2}') });
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: desktopLnurlFetch(invoke as never, page(opaque)) })).resolves.toEqual({ ok: 2 });
    expect(invoke).toHaveBeenLastCalledWith("link_preview_fetch", { url: "https://ln.example.com/x", kind: "json" });
  });

  it("refuses an answer that came from plain HTTP or an address with credentials", async () => {
    for (const [url, error] of [["http://pay.example.net/y", /HTTPS/], ["https://u:p@pay.example.net/y", /credentials/]] as const) {
      const invoke = rust({ status: 301, contentType: "", bodyB64: "" }, { url, contentType: "application/json", bodyB64: b64("{}") });
      await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: desktopLnurlFetch(invoke as never, page(opaque)) })).rejects.toThrow(error);
    }
  });

  it("says what Rust refused of a redirect: the service's status, or that it could not be reached", async () => {
    const moved = { status: 302, contentType: "", bodyB64: "" };
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: desktopLnurlFetch(rust(moved, "HTTP 404") as never, page(opaque)) })).rejects.toThrow(/HTTP 404/);
    const local = rust(moved, "unreachable: error following redirect: Local addresses have no preview");
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: desktopLnurlFetch(local as never, page(opaque)) })).rejects.toThrow(/Could not reach ln.example.com/);
  });

  it("asks a test server on this machine from the page, and never asks Rust for its redirect", async () => {
    const invoke = vi.fn();
    await expect(fetchLnurlJson("http://localhost:4610/x", { fetch: desktopLnurlFetch(invoke, page(() => new Response('{"ok":3}'))) })).resolves.toEqual({ ok: 3 });
    await expect(fetchLnurlJson("http://localhost:4610/x", { fetch: desktopLnurlFetch(invoke, page(opaque)) })).rejects.toThrow("localhost:4610 redirects to another address, which cannot be checked here");
    expect(invoke).not.toHaveBeenCalled();
  });
});
