import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appErrorText } from "../../lib/apps/errors";
import { forgetRunnerCheck, runnerPolicy } from "../../lib/apps/runnerCheck";
import { webOpener } from "../../lib/apps/webOpener";
import type { AppsPlatform } from "../../lib/platform";
import { translateWith } from "../../locales/translate";
import { LOCALES as locales } from "../i18n/locales";

// covers: apps.web-sandbox

// The runner page's server failing (a proxy's 502 while it restarts for a deploy), too busy (429) or timing out (408)
// while the browser is online: Open said "You are offline." The person is online; the host had the trouble, and its
// own line says so. Offline, or a request that never got an answer, stays offline.
const started: { stop: (reason?: string) => void }[] = [];
vi.mock("../../lib/apps/broker", async (actual) => ({
  ...(await actual<typeof import("../../lib/apps/broker")>()),
  startApp: ({ container, onStop }: { container: HTMLElement; onStop?: (reason: string) => void }) => {
    const frame = document.createElement("div");
    container.appendChild(frame);
    let done = false;
    const stop = (reason = "stopped") => { if (done) return; done = true; frame.remove(); onStop?.(reason); };
    started.push({ stop });
    return { frame, phase: "starting", stop };
  },
}));

const en = translateWith(locales.en, "en");
const pt = translateWith(locales.pt, "pt");
const PLAIN = "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-pointer-lock";
const NET = "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; connect-src https: wss:; img-src data: blob: https:; media-src data: blob: https:; font-src data: https:; frame-src 'none'; worker-src 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-pointer-lock";

function host(permissions: string[]) {
  return {
    runnerUrl: "/app-frame.html",
    netRunnerUrl: "/app-frame-net.html",
    entry: async () => ({ ref: "pub/chess", digest: "d", version: "1.0.0", title: "Chess", permissions, entry: "<!doctype html>" }),
  } as unknown as AppsPlatform;
}
const opener = (permissions: string[]) => webOpener({ apps: () => host(permissions), nameIn: () => undefined, closeLabel: () => "Close" });

/** Opens it and gives back what it threw. */
async function refused(permissions: string[]): Promise<unknown> {
  return opener(permissions)("pub/chess", null).then(() => { throw new Error("it opened"); }, (error: unknown) => error);
}

let online = true;
let urls: string[] = [];
/** The runner pages answer with this status (200: with their policy). */
let status = 200;
beforeEach(() => {
  started.length = 0;
  online = true;
  urls = [];
  status = 200;
  forgetRunnerCheck();
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    if (status !== 200) return new Response("Bad gateway", { status });
    return new Response("<!doctype html>", { headers: { "content-security-policy": url.includes("-net") ? NET : PLAIN } });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  forgetRunnerCheck();
  document.querySelectorAll("[data-place=alone]").forEach((node) => node.remove());
});

describe("opening an app on the web while its runner page's host has trouble", () => {
  it.each([
    [502, "/app-frame.html", []],
    [429, "/app-frame-net.html", ["internet"]],
    [408, "/app-frame.html", []],
  ] as const)("a %i from %s while online: the host's problem, not offline", async (code, url, permissions) => {
    status = code;
    const error = await refused([...permissions]);
    expect(urls).toEqual([url]);
    expect(appErrorText(error, en)).not.toBe("You are offline.");
    expect(appErrorText(error, en)).toBe(`The host had a problem (error ${code}). Try again later.`);
    expect(appErrorText(error, pt)).toBe(pt("apps.errors.hostProblem", { status: code }));
    expect(started).toHaveLength(0);
  });

  it("the runner page is asked again at the next Open, and the app starts once it answers", async () => {
    status = 502;
    await refused(["internet"]);
    status = 200;
    await opener(["internet"])("pub/chess", null);
    expect(urls).toEqual(["/app-frame-net.html", "/app-frame-net.html"]);
    expect(started).toHaveLength(1);
    started[0]!.stop("closed");
  });

  it("the browser says it is offline: offline, whatever the server would answer", async () => {
    status = 502;
    online = false;
    const error = await refused([]);
    expect(appErrorText(error, en)).toBe("You are offline.");
    expect(started).toHaveLength(0);
  });

  it("a 502 that came as the browser went offline: offline", async () => {
    vi.mocked(fetch).mockImplementation(async () => { online = false; return new Response("Bad gateway", { status: 502 }); });
    const error = await refused([]);
    expect(appErrorText(error, en)).toBe("You are offline.");
  });

  it("a request that got no answer at all: offline", async () => {
    vi.mocked(fetch).mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
    const error = await refused([]);
    expect(appErrorText(error, en)).toBe("You are offline.");
    expect(appErrorText(error, pt)).toBe(pt("apps.errors.offline"));
  });
});

describe("the runner check", () => {
  it("tells a server's error status apart from a request that could not be made, and keeps neither", async () => {
    status = 503;
    expect(await runnerPolicy("/app-frame.html", fetch)).toBe(503);
    vi.mocked(fetch).mockImplementationOnce(async () => { throw new TypeError("Failed to fetch"); });
    expect(await runnerPolicy("/app-frame.html", fetch)).toBeNull();
    status = 200;
    expect(await runnerPolicy("/app-frame.html", fetch)).toBe(true);
    expect(urls).toHaveLength(2);
  });
});
