import { describe, expect, it, vi } from "vitest";
import { fetchLnurlJson } from "@ghostly/core";
import { desktopLnurlFetch } from "./lnurlFetch";

const b64 = (text: string) => btoa(text);
const opaque = () => { const r = new Response(null); Object.defineProperty(r, "type", { value: "opaqueredirect" }); return r; };
const page = (response: () => Response) => vi.fn(async () => response()) as unknown as typeof fetch;

describe("how Ghostly Desktop asks a Lightning address service", () => {
  it("asks from the page, and Rust is not asked when the service does not redirect", async () => {
    const invoke = vi.fn();
    const fetch = page(() => new Response('{"ok":1}'));
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: desktopLnurlFetch(invoke, fetch) })).resolves.toEqual({ ok: 1 });
    expect(fetch).toHaveBeenCalledWith("https://ln.example.com/x", expect.objectContaining({ redirect: "manual", credentials: "omit" }));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("asks a service that redirects from Rust, which checks each hop, and reads its answer", async () => {
    const invoke = vi.fn(async () => ({ url: "https://pay.example.net/y", contentType: "application/json", bodyB64: b64('{"ok":2}') }));
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: desktopLnurlFetch(invoke as never, page(opaque)) })).resolves.toEqual({ ok: 2 });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("link_preview_fetch", { url: "https://ln.example.com/x", kind: "json" });
  });

  it("refuses an answer that came from plain HTTP or an address with credentials", async () => {
    for (const [url, error] of [["http://pay.example.net/y", /HTTPS/], ["https://u:p@pay.example.net/y", /credentials/]] as const) {
      const invoke = vi.fn(async () => ({ url, contentType: "application/json", bodyB64: b64("{}") }));
      await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: desktopLnurlFetch(invoke as never, page(opaque)) })).rejects.toThrow(error);
    }
  });

  it("says what Rust refused: the service's status, or that it could not be reached", async () => {
    const status = vi.fn(async () => { throw "HTTP 404"; });
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: desktopLnurlFetch(status as never, page(opaque)) })).rejects.toThrow(/HTTP 404/);
    const local = vi.fn(async () => { throw "unreachable: error following redirect: Local addresses have no preview"; });
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: desktopLnurlFetch(local as never, page(opaque)) })).rejects.toThrow(/Could not reach ln.example.com/);
  });

  it("never asks Rust for a redirect of a plain-HTTP service (this machine, a hidden service)", async () => {
    const invoke = vi.fn();
    await expect(fetchLnurlJson("http://localhost:4610/x", { fetch: desktopLnurlFetch(invoke, page(opaque)) })).rejects.toThrow("localhost:4610 redirects to another address, which cannot be checked here");
    expect(invoke).not.toHaveBeenCalled();
  });
});
