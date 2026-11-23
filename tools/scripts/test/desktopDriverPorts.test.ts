import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDesktop } from "../../../e2e/support/desktop";

/*
 * `openDesktop` (e2e/support/desktop.ts) against a fake `tauri-driver` (TAURI_DRIVER). The real one starts
 * WebKitWebDriver on `--native-port` and forwards each request there. Both ports come from `freePort`, which lets each
 * one go before the drivers bind it, so another process can take one meanwhile. When the native one was taken,
 * WebKitWebDriver said so and exited while tauri-driver ran on, closing every request without an answer, and the open
 * failed 30 s later with a bare "TypeError: fetch failed / other side closed" (desktop/native-upgrade.spec.ts,
 * compat.spec.ts and video-stream.spec.ts on Omarchy). The fake does what the two did then on the launches it is told
 * to, and otherwise answers the two calls an open makes.
 */

const FAKE = `#!/usr/bin/env node
const { createServer } = require("node:http");
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const nativePort = Number(args[args.indexOf("--native-port") + 1]);
const state = process.env.FAKE_DRIVER_STATE;
let launch = 1;
try { launch = readFileSync(state, "utf8").split("\\n").filter(Boolean).length + 1; } catch {}
appendFileSync(state, port + " " + nativePort + "\\n");
const lost = (process.env.FAKE_DRIVER_LOSES ?? "").split(",").includes(String(launch));
const unanswered = (process.env.FAKE_DRIVER_HANGS ?? "").split(",").filter(Boolean);
const failing = (process.env.FAKE_DRIVER_FAILS ?? "").split(",").filter(Boolean);
if (lost) process.stderr.write("FATAL: Unable to listen for HTTP server at host 127.0.0.1 and port " + nativePort + ".\\n");
createServer((request, response) => {
  if (lost) return request.socket.destroy();
  if (unanswered.some((call) => request.method + " " + request.url === call)) return;
  if (failing.some((call) => request.method + " " + request.url === call)) {
    response.statusCode = 500;
    return response.end(JSON.stringify({ value: { error: "unknown error", message: "", stacktrace: "" } }));
  }
  const answer = (value) => response.end(JSON.stringify({ value }));
  if (request.method === "POST" && request.url === "/session") return answer({ sessionId: "s" + launch });
  if (request.method === "POST" && request.url === "/session/s" + launch + "/execute/sync") return answer(true);
  return answer(null);
}).listen(port, "127.0.0.1");
`;

let dir: string;
const launches = () => readFileSync(join(dir, "state"), "utf8").split("\n").filter(Boolean);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-tauri-driver-"));
  writeFileSync(join(dir, "tauri-driver"), FAKE, { mode: 0o755 });
  vi.stubEnv("TAURI_DRIVER", join(dir, "tauri-driver"));
  vi.stubEnv("FAKE_DRIVER_STATE", join(dir, "state"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("openDesktop when a driver port was taken", () => {
  it("starts the drivers again on other ports, and the app opens", async () => {
    vi.stubEnv("FAKE_DRIVER_LOSES", "1");

    const { app, stop } = await openDesktop({ binary: "/nonexistent/ghostly", home: join(dir, "home") });
    try {
      expect(await app.execute("return navigator.webdriver === true")).toBe(true);
    } finally {
      await stop();
    }
    const [first, second] = launches();
    expect(launches()).toHaveLength(2);
    expect(second).not.toBe(first);
  }, 15_000);

  it("says which port was taken, and what the driver said, when it keeps happening", async () => {
    vi.stubEnv("FAKE_DRIVER_LOSES", "1,2,3");

    await expect(openDesktop({ binary: "/nonexistent/ghostly", home: join(dir, "home") }))
      .rejects.toThrow(/A driver port \(\d+, \d+\) was taken:\nFATAL: Unable to listen for HTTP server at host 127\.0\.0\.1 and port \d+/);
    expect(launches()).toHaveLength(3);
  }, 15_000);
});

/*
 * A request the driver never answers. WebKitWebDriver answers each command within its script timeout or says why, but
 * one went unanswered in desktop/single-instance.spec.ts on Omarchy, and the test waited until its own 240 s were out,
 * with nothing saying which call it was waiting for.
 */
describe.skipIf(process.platform === "win32")("a WebDriver request with no answer", () => {
  it("fails naming the call, and the app still stops", async () => {
    vi.stubEnv("FAKE_DRIVER_HANGS", "POST /session/s1/element,DELETE /session/s1");

    const { app, stop } = await openDesktop({ binary: "/nonexistent/ghostly", home: join(dir, "home"), answerMs: 500 });
    try {
      await expect(app.text('[title="New chat"]')).rejects.toThrow(/^POST http:\/\/127\.0\.0\.1:\d+\/session\/s1\/element: no answer in 0\.5 s$/);
    } finally {
      await stop();
    }
  }, 15_000);
});

/*
 * A command the driver fails with an empty message, as WebKitWebDriver does now and then (`unknown error`, message "").
 * Only the message was kept, so a Desktop e2e step that kept failing so (compat.spec.ts's first text on Omarchy) ended
 * with an error that said nothing at all.
 */
describe.skipIf(process.platform === "win32")("a WebDriver error with no message", () => {
  it("says the driver's error", async () => {
    vi.stubEnv("FAKE_DRIVER_FAILS", "POST /session/s1/element");

    const { app, stop } = await openDesktop({ binary: "/nonexistent/ghostly", home: join(dir, "home") });
    try {
      await expect(app.text('[title="New chat"]')).rejects.toThrow(/^POST http:\/\/127\.0\.0\.1:\d+\/session\/s1\/element: unknown error$/);
    } finally {
      await stop();
    }
  }, 15_000);
});
