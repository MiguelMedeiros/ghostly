import { describe, expect, it } from "vitest";
import { localHost, ownCookies, setCookieName } from "../src/services";
// covers: headless.services

/** `service.open`'s loopback port answers a page that asks for it by this machine's name, not by any name resolving here. */
describe("an opened service's Host check", () => {
  it("takes 127.0.0.1, localhost and [::1] on its own port, and nothing else", () => {
    expect(localHost("127.0.0.1:4800", 4800)).toBe(true);
    expect(localHost("LOCALHOST:4800", 4800)).toBe(true);
    expect(localHost("[::1]:4800", 4800)).toBe(true);
    expect(localHost("127.0.0.1:4801", 4800)).toBe(false);
    expect(localHost("rebind.example:4800", 4800)).toBe(false);
    expect(localHost("127.0.0.1", 4800)).toBe(false);
    expect(localHost(undefined, 4800)).toBe(false);
  });
});

/** A browser sends an opened service every cookie set for 127.0.0.1 by any app here: only the service's own go on. */
describe("an opened service's cookies", () => {
  it("passes on only the cookies the service set itself", () => {
    const own = new Set(["sid"]);
    expect(ownCookies("other_app=secret; sid=abc; theme=dark", own)).toBe("sid=abc");
    expect(ownCookies("other_app=secret", own)).toBeNull();
    expect(ownCookies("sid=abc", new Set())).toBeNull();
    expect(ownCookies("  sid = abc ;junk", own)).toBe("sid = abc");
  });

  it("reads a Set-Cookie's name", () => {
    expect(setCookieName("sid=abc; Path=/; HttpOnly")).toBe("sid");
    expect(setCookieName("sid=")).toBe("sid");
    expect(setCookieName("=abc")).toBeNull();
    expect(setCookieName("HttpOnly; sid=abc")).toBeNull();
  });
});
