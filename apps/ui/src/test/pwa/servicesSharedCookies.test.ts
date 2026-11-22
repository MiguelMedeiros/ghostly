import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIPBOARD_GUARD_SCRIPT } from "@ghostly/core";

// covers: services.web-open

/**
 * Two contacts' apps open at once under a services host: their origins share its site, and one browser's cookie jar.
 * happy-dom keeps one jar for the window whatever its URL, and takes a cookie for a domain above it, as a browser that
 * keeps the cookies of a frame under another site does. Its own file: what the guard leaves stays fixed in the window.
 */
describe("a cookie for the whole services host, with two contacts' apps open at once", () => {
  const SUFFIX = "svc.ghostly.example";
  const A = `https://ybndrfg8ejkmcpqxot1uwisza345h769.${SUFFIX}/`;
  const B = `https://h769a345uwisz8ejkmcpqxot1ybndrfg.${SUFFIX}/`;
  const at = (url: string) => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);

  afterEach(() => { vi.unstubAllGlobals(); });

  /**
   * Runs the guard on this document as a browser would have it run in the page, given as its `Document` the prototype
   * of this document that holds `cookie`: happy-dom keeps `defaultView` above that one and has no `execCommand`, where a
   * browser has all three on `Document.prototype`. The rest of the window the guard reads is a stand-in (what happy-dom
   * lacks of it, the guard would stop at).
   */
  function runGuard(): void {
    let proto = Object.getPrototypeOf(document) as object;
    while (!Object.getOwnPropertyDescriptor(proto, "cookie")) proto = Object.getPrototypeOf(proto) as object;
    let holder = proto;
    while (!Object.getOwnPropertyDescriptor(holder, "defaultView")) holder = Object.getPrototypeOf(holder) as object;
    Object.defineProperty(proto, "defaultView", Object.getOwnPropertyDescriptor(holder, "defaultView")!);
    Object.defineProperty(proto, "execCommand", { value: () => false, writable: true, configurable: true });
    const w = {
      Reflect, Object, String, TypeError,
      Document: { prototype: proto },
      document,
      Event: class { get eventPhase() { return 0; } },
      EventTarget: { prototype: { addEventListener() {} } },
      Element: { prototype: {} },
      DocumentFragment: { prototype: {} },
      NodeList: { prototype: { get length() { return 0; } } },
      MutationObserver: class { observe() {} },
      get length() { return 0; },
    };
    new Function("window", CLIPBOARD_GUARD_SCRIPT)(w);
    expect(Object.getOwnPropertyDescriptor(proto, "cookie")?.configurable, "the guard ran").toBe(false);
  }

  it("is kept by the guard to the page's own host, and the bridge still drops one left from before", async () => {
    at(B);
    // Left by an app from before this guard (a build without it): the bridge drops it as it starts.
    document.cookie = `left=1; Path=/; Domain=${SUFFIX}; Secure; SameSite=None`;
    // The bridge's module loads before it runs the guard in its page.
    const { dropSharedCookies } = await import("../../../../web/src/svc/clearSite");
    runGuard();

    at(A);
    document.cookie = `told=1; Path=/; Domain=${SUFFIX}; Secure; SameSite=None`;
    document.cookie = `told2=1; Path=/; domain=.${SUFFIX}`;
    expect(document.cookie, "A keeps its own").toContain("told=1");

    at(B);
    expect(document.cookie, "another contact's app reads none of A's").not.toMatch(/told/);
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    await dropSharedCookies(SUFFIX);
    expect(document.cookie).not.toContain("left=1");
  });
});
