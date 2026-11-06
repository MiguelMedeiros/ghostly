import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appErrorText } from "../../lib/apps/errors";
import { takedownText } from "../../lib/apps/open";
import { forgetRunnerCheck } from "../../lib/apps/runnerCheck";
import { webOpener } from "../../lib/apps/webOpener";
import type { AppsPlatform } from "../../lib/platform";
import { translateWith } from "../../locales/translate";
import { LOCALES as locales } from "../i18n/locales";

// covers: apps.takedown

// The web runner pages (`/app-frame.html`, `/app-frame-net.html`) are never cached: offline, neither one loads. Open
// says the person is offline, at once and in their language, rather than blaming the server or the app's maker.
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
const POLICY = "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; connect-src https: wss:; img-src data: blob: https:; media-src data: blob: https:; font-src data: https:; frame-src 'none'; worker-src 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-pointer-lock";

function host(permissions: string[]) {
  return {
    runnerUrl: "/app-frame.html",
    netRunnerUrl: "/app-frame-net.html",
    entry: async () => ({ ref: "pub/chess", digest: "d", version: "1.0.0", title: "Chess", permissions, entry: "<!doctype html>" }),
  } as unknown as AppsPlatform;
}
const opener = (permissions: string[]) => webOpener({ apps: () => host(permissions), nameIn: () => undefined, closeLabel: () => "Close", stoppedLabel: (title, takedown) => takedownText(title, takedown, en) });

/** Opens it and gives back what it threw. */
async function refused(permissions: string[]): Promise<unknown> {
  return opener(permissions)("pub/chess", null).then(() => { throw new Error("it opened"); }, (error: unknown) => error);
}

let online = true;
beforeEach(() => {
  started.length = 0;
  online = true;
  forgetRunnerCheck();
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.querySelectorAll("[data-place=alone]").forEach((node) => node.remove());
});

describe("opening an app on the web while offline", () => {
  it("an app granted internet, its runner never asked: offline, in the person's language", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const error = await refused(["internet"]);
    expect(appErrorText(error, en)).toBe("You are offline.");
    expect(appErrorText(error, pt)).toBe(pt("apps.errors.offline"));
    expect(started).toHaveLength(0);
  });

  it("the browser says it is offline, the runner answered earlier: offline at once, the app never starts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { headers: { "content-security-policy": POLICY } })));
    await opener(["internet"])("pub/chess", null);
    started[0]!.stop("closed");
    online = false;
    const error = await refused(["internet"]);
    expect(appErrorText(error, pt)).toBe(pt("apps.errors.offline"));
    expect(started).toHaveLength(1);
  });

  it("a runner that answers without its policy: its own words, translated", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("")));
    const error = await refused(["internet"]);
    expect(appErrorText(error, pt)).toBe(pt("apps.errors.runner"));
    expect(appErrorText(error, pt)).not.toBe(appErrorText(error, en));
  });

  it("a start that timed out while offline does not send the person to the app's maker", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { headers: { "content-security-policy": POLICY } })));
    await opener(["internet"])("pub/chess", null);
    online = false;
    started[0]!.stop("timeout");
    const said = within(screen.getByTestId("mini-app")).getByRole("status");
    expect(said).toHaveTextContent(en("apps.view.stoppedOffline", { title: "Chess" }));
    expect(said).not.toHaveTextContent("tell its maker");
  });
});
