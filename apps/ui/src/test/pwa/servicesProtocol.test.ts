import { describe, expect, it } from "vitest";
import { BRIDGE_PAGE, MAX_REQUEST_BYTES, answerStatus, fromView, isServiceHostname, parseServicesHost, readRequest, serviceOrigin } from "../../../../web/src/svc/protocol";
import { precacheList } from "../../../../web/src/sw/policy";

// covers: services.web-open

/**
 * Where a contact's shared web app runs on the web (apps/web/src/svc/protocol.ts): the services host a build is given,
 * the names under it, and what the app's page takes from the bridge. The browser's own part is
 * e2e/web/services-web-open.spec.ts.
 */
const host = parseServicesHost("https://*.svc.ghostly.example")!;
const LABEL = "ybndrfg8ejkmcpqxot1uwisza345h769";

describe("the services host", () => {
  it("takes only a wildcard host: HTTPS, or plain HTTP on this machine for tests", () => {
    expect(parseServicesHost("https://*.svc.example")).toEqual({ protocol: "https:", suffix: "svc.example", port: "" });
    expect(parseServicesHost("http://*.localhost:4173")).toEqual({ protocol: "http:", suffix: "localhost", port: "4173" });
    for (const bad of [undefined, "", "https://svc.example", "http://*.svc.example", "https://*.svc.example/path", "https://*.*.example", "javascript:*.x"]) {
      expect(parseServicesHost(bad)).toBeNull();
    }
    expect(BRIDGE_PAGE.startsWith("/_ghostly-svc/")).toBe(true);
  });

  it("names one label under it, never the app's own host nor a deeper or other name", () => {
    expect(serviceOrigin(host, LABEL)).toBe(`https://${LABEL}.svc.ghostly.example`);
    expect(serviceOrigin(parseServicesHost("http://*.localhost:4173")!, LABEL)).toBe(`http://${LABEL}.localhost:4173`);
    expect(isServiceHostname(host, `${LABEL}.svc.ghostly.example`)).toBe(true);
    for (const name of ["svc.ghostly.example", "app.ghostly.example", `a.${LABEL}.svc.ghostly.example`, "hello.svc.ghostly.example", `${LABEL}.ghostly.example`, `${LABEL.slice(1)}.svc.ghostly.example`]) {
      expect(isServiceHostname(host, name)).toBe(false);
    }
  });

  it("keeps the bridge's files out of the app's own cache", () => {
    expect(precacheList(["ghostly-services-sw.js", "_ghostly-svc/bridge.html", "_ghostly-svc/bridge.js", "index.html", "assets/a.js"])).toEqual(["/", "/assets/a.js"]);
  });
});

describe("who the worker passes on to the contact", () => {
  const get = { mode: "cors", destination: "" };
  it("the app framed under the bridge, its frames and its workers", () => {
    expect(fromView({ mode: "navigate", destination: "iframe" })).toBe(true);
    expect(fromView(get, { type: "window", frameType: "nested" })).toBe(true);
    expect(fromView(get, { type: "worker" })).toBe(true);
  });

  it("never a tab or a window on the app's origin: one it opened, or one another site opened, outlives the view", () => {
    expect(fromView({ mode: "navigate", destination: "document" })).toBe(false);
    for (const frameType of ["auxiliary", "top-level", "none", undefined]) expect(fromView(get, { type: "window", frameType })).toBe(false);
  });
});

describe("what the app's page takes from the bridge", () => {
  const good = { type: "request", method: "POST", path: "/api?x=1", headers: [["content-type", "application/json"]], body: new ArrayBuffer(2) };
  it("a request with a path on the app's origin, its headers and a body within the link's limit", () => {
    expect(readRequest(good)).toMatchObject({ method: "POST", path: "/api?x=1" });
    expect(readRequest({ ...good, body: null, method: "GET" })).toMatchObject({ method: "GET", body: null });
  });
  it("nothing else: another URL, a bad method, too many headers, a body too large", () => {
    for (const bad of [null, "x", { ...good, type: "head" }, { ...good, path: "https://evil.example/" }, { ...good, path: "//evil.example/" }, { ...good, method: "get" },
      { ...good, method: "GET\r\nX: 1" }, { ...good, headers: [["a"]] }, { ...good, headers: Array.from({ length: 129 }, () => ["a", "b"]) },
      { ...good, body: new ArrayBuffer(MAX_REQUEST_BYTES + 1) }, { ...good, body: "text" }]) {
      expect(readRequest(bad)).toBeNull();
    }
  });
  it("answers with the contact's status when a Response can carry it", () => {
    expect(answerStatus(200)).toBe(200);
    expect(answerStatus(404)).toBe(404);
    expect(answerStatus(101)).toBe(502);
    expect(answerStatus(0)).toBe(502);
  });
});
