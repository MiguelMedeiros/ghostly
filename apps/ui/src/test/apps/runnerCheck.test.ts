import { afterEach, expect, it } from "vitest";
import { RUNNER_CSP } from "../../../../web/runnerPolicy";
import { forgetRunnerCheck, isRunnerPolicy, runnerAvailable } from "../../lib/apps/runnerCheck";

// covers: apps.web-sandbox

afterEach(() => forgetRunnerCheck());

it("takes the runner's own policy, and nothing looser", () => {
  expect(isRunnerPolicy(RUNNER_CSP)).toBe(true);
  expect(isRunnerPolicy("")).toBe(false);
  expect(isRunnerPolicy(RUNNER_CSP.replace("sandbox allow-scripts", "sandbox allow-scripts allow-same-origin"))).toBe(false);
  expect(isRunnerPolicy(RUNNER_CSP.replace("sandbox allow-scripts; ", ""))).toBe(false);
  expect(isRunnerPolicy(RUNNER_CSP.replace("connect-src 'none'", "connect-src 'self'"))).toBe(false);
  expect(isRunnerPolicy(RUNNER_CSP.replace("frame-ancestors 'self'", "frame-ancestors *"))).toBe(false);
  // The page's own policy, as a server that sent nginx-headers.conf everywhere would.
  expect(isRunnerPolicy("default-src 'self'; script-src 'self'; frame-ancestors 'none'")).toBe(false);
});

it("asks the runner page once, and says no when its header is missing or the page is", async () => {
  const asked: string[] = [];
  const answer = (headers: Record<string, string>, status = 200) => (async (url: RequestInfo | URL) => { asked.push(String(url)); return new Response("<!doctype html>", { status, headers }); }) as typeof fetch;
  expect(await runnerAvailable("/app-frame.html", answer({ "content-security-policy": RUNNER_CSP }))).toBe(true);
  expect(await runnerAvailable("/app-frame.html", answer({}))).toBe(true);
  expect(asked).toEqual(["/app-frame.html"]);
  forgetRunnerCheck();
  expect(await runnerAvailable("/app-frame.html", answer({}))).toBe(false);
  forgetRunnerCheck();
  expect(await runnerAvailable("/app-frame.html", answer({ "content-security-policy": RUNNER_CSP }, 404))).toBe(false);
  forgetRunnerCheck();
  expect(await runnerAvailable("/app-frame.html", (async () => { throw new TypeError("offline"); }) as typeof fetch)).toBe(false);
});
