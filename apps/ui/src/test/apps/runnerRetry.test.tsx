import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RUNNER_CSP } from "../../../../web/runnerPolicy";
import { forgetAppsAvailable, useAppsState } from "../../lib/apps/flag";
import { forgetRunnerCheck, runnerAvailable } from "../../lib/apps/runnerCheck";
import { setAppOpener } from "../../lib/apps/open";
import { fakeEngine } from "../fakeEngine";

// covers: apps.web-sandbox, apps.page

// The runner check could not reach the server (the web app opened offline from its service worker, or a dropped
// request): that is not "this server sends no policy". It was kept as a no for the page's life, so Apps stayed hidden
// and nothing opened until a reload.

let online: boolean;
let asked: number;
beforeEach(() => {
  forgetAppsAvailable();
  forgetRunnerCheck();
  asked = 0;
  online = false;
  vi.stubEnv("VITE_APPS_TEST", "1");
  fakeEngine.appRunner = "/app-frame.html";
  setAppOpener(vi.fn(async () => {}));
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    asked++;
    if (!online) throw new TypeError("Failed to fetch");
    return new Response("<!doctype html>", { headers: { "content-security-policy": RUNNER_CSP } });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setAppOpener(null);
  fakeEngine.appRunner = undefined;
  forgetAppsAvailable();
  forgetRunnerCheck();
});

it("asks the runner page again once it could not reach it, instead of keeping a no", async () => {
  expect(await runnerAvailable("/app-frame.html")).toBe(false);
  online = true;
  expect(await runnerAvailable("/app-frame.html")).toBe(true);
  expect(asked).toBe(2);
  // A real answer is kept: no third request.
  expect(await runnerAvailable("/app-frame.html")).toBe(true);
  expect(asked).toBe(2);
});

it("shows Apps once the network is back, without a reload", async () => {
  const { result } = renderHook(() => useAppsState());
  await waitFor(() => expect(asked).toBe(1));
  await waitFor(() => expect(result.current).toBe("off"));
  online = true;
  await act(async () => { window.dispatchEvent(new Event("online")); });
  await waitFor(() => expect(result.current).toBe("on"));
});

it("still hides Apps for good on a server that answers without the runner's policy", async () => {
  vi.mocked(globalThis.fetch).mockImplementation(async () => { asked++; return new Response("<!doctype html>"); });
  const { result } = renderHook(() => useAppsState());
  await waitFor(() => expect(result.current).toBe("off"));
  await act(async () => { window.dispatchEvent(new Event("online")); });
  expect(result.current).toBe("off");
  expect(asked).toBe(1);
});
