import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { desktopBinary, type DesktopApp } from "./desktop";
import { MacDriver } from "./desktopMac";

/**
 * The Desktop checks that a video too large for the page plays and seeks from the stored file (`ghostly-file`,
 * src-tauri/src/file_stream.rs), in the real WebView under the app's real policy: macOS (WKWebView, the #230
 * driver) and Linux/Windows (tauri-driver). The same page scripts for every engine.
 */

/**
 * A port free on 127.0.0.1 right now. Fixed ports fail on Windows runners, which reserve ranges around 49xxx
 * (`netsh interface ipv4 show excludedportrange protocol=tcp`).
 */
export async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

/** Serves `path` on 127.0.0.1 a piece at a time (`/?offset=&length=`), for the page to copy into the file store. */
export function servePieces(path: string, port: number): Promise<Server> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const offset = Number(url.searchParams.get("offset")), length = Number(url.searchParams.get("length"));
    const piece = Buffer.alloc(length);
    const fd = openSync(path, "r");
    const read = readSync(fd, piece, 0, length, offset);
    closeSync(fd);
    response.writeHead(200, { "content-type": "application/octet-stream", "access-control-allow-origin": "*" });
    response.end(piece.subarray(0, read));
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)));
}

/** Copies the file into the app's store through the same commands a received file is written with. */
export async function storeInApp(app: DesktopApp, port: number, size: number, place: { space: string; id: string }): Promise<void> {
  const answer = await app.executeAsync<{ error?: string } | null>(
    `const [port, size, space, id, done] = arguments;
     (async () => {
       const invoke = (command, ...rest) => window.__TAURI_INTERNALS__.invoke(command, ...rest)
         .catch((e) => { throw new Error(command + ": " + (e && e.message || e)); });
       await invoke("file_bytes_remove", { space, id });
       const step = 1024 * 1024;
       for (let offset = 0; offset < size; offset += step) {
         const length = Math.min(step, size - offset);
         const piece = new Uint8Array(await (await fetch("http://127.0.0.1:" + port + "/?offset=" + offset + "&length=" + length)).arrayBuffer());
         if (piece.length !== length) throw new Error("short piece at " + offset);
         await invoke("file_bytes_append", piece, { headers: { "x-space": space, "x-id": id, "x-offset": String(offset) } });
       }
       await invoke("file_bytes_close", { space, id });
       const stored = await invoke("file_bytes_size", { space, id });
       if (stored !== size) throw new Error("stored " + stored + " of " + size);
     })().then(() => done(null), (e) => done({ error: String(e && e.message || e) }));`,
    port, size, place.space, place.id,
  );
  if (answer?.error) throw new Error(answer.error);
}

/** Removes what `storeInApp` stored, so a run leaves nothing on the machine. */
export async function removeFromApp(app: DesktopApp, place: { space: string; id: string }): Promise<void> {
  await app.executeAsync(
    `const [space, id, done] = arguments;
     window.__TAURI_INTERNALS__.invoke("file_bytes_remove", { space, id }).then(() => done(null), () => done(null));`,
    place.space, place.id,
  ).catch(() => {});
}

export interface PlayReport {
  error?: string;
  url?: string;
  duration?: number;
  /** Where it was once playing had started. */
  playedTo?: number;
  /** Where the seek landed, and where it had played to after it. */
  seekedTo?: number;
  playedAfterSeek?: number;
  frames?: number;
  framesBeforeSeek?: number;
  events?: string[];
}

/**
 * Asks for a token, plays the file in a `<video>` from the scheme's URL, seeks to `seekTo` seconds and plays on.
 * Muted: nothing is heard at the machine running it.
 */
export function playFromStore(app: DesktopApp, place: { space: string; id: string }, seekTo: number): Promise<PlayReport> {
  return app.executeAsync<PlayReport>(
    `const [space, id, seekTo, done] = arguments;
     const events = [];
     const video = document.createElement("video");
     const until = (test, ms, what) => new Promise((resolve, reject) => {
       const start = performance.now();
       const tick = () => {
         if (video.error) return reject(new Error("media error " + video.error.code + " " + (video.error.message || "")));
         if (test()) return resolve();
         if (performance.now() - start > ms) return reject(new Error("timed out waiting for " + what + " at " + video.currentTime));
         setTimeout(tick, 50);
       };
       tick();
     });
     const frames = () => video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality().totalVideoFrames : -1;
     (async () => {
       const { url, token } = await window.__TAURI_INTERNALS__.invoke("file_bytes_stream_open", { space, id, mime: "video/mp4" });
       video.muted = true;
       video.playsInline = true;
       video.preload = "auto";
       video.style.cssText = "position:fixed;left:0;top:0;width:320px;height:180px;z-index:2147483647;background:#000";
       for (const type of ["loadedmetadata", "canplay", "playing", "waiting", "stalled", "seeking", "seeked", "error"]) {
         video.addEventListener(type, () => events.push(type + "@" + video.currentTime.toFixed(2)));
       }
       document.body.append(video);
       video.src = url;
       await until(() => video.readyState >= 1, 30000, "metadata");
       const duration = video.duration;
       await video.play();
       await until(() => video.currentTime > 1, 30000, "playback");
       const playedTo = video.currentTime;
       const framesBeforeSeek = frames();
       const seeked = new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }));
       video.currentTime = seekTo;
       await Promise.race([seeked, until(() => false, 30000, "seeked")]);
       const seekedTo = video.currentTime;
       await until(() => video.currentTime > seekTo + 1, 30000, "playback after the seek");
       const report = { url, duration, playedTo, seekedTo, playedAfterSeek: video.currentTime, frames: frames(), framesBeforeSeek, events };
       video.pause();
       video.removeAttribute("src");
       video.load();
       video.remove();
       await window.__TAURI_INTERNALS__.invoke("file_bytes_stream_close", { token });
       return report;
     })().then(done, (e) => { video.remove(); done({ error: String(e && e.message || e), events }); });`,
    place.space, place.id, seekTo,
  );
}

/**
 * The Desktop binary started by hand and driven through its own test driver (`src-tauri/src/e2e_driver.rs`, a debug
 * build with `--features e2e-driver`), as the macOS tests are. Windows uses it: tauri-driver's msedgedriver never
 * attached to the app's WebView2 on the GitHub runner ("DevToolsActivePort file doesn't exist"), while the app itself
 * ran fine there.
 */
export async function openDriven(env: Record<string, string> = {}): Promise<{ app: MacDriver; stop: () => Promise<void> }> {
  const port = await freePort();
  const token = randomBytes(16).toString("hex");
  const log: string[] = [];
  const child = spawn(desktopBinary(), [], {
    stdio: ["ignore", "pipe", "pipe"],
    // GHOSTLY_E2E: never a new profile's default Mainnet wallets (#682). This driver sets no navigator.webdriver, and
    // the build has the real bundle id.
    env: { ...process.env, GHOSTLY_E2E: "1", GHOSTLY_PROFILE: "e2e-stream", GHOSTLY_E2E_DRIVER: String(port), GHOSTLY_E2E_DRIVER_TOKEN: token, ...env },
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  let exited: number | null | undefined;
  const gone = new Promise<void>((done) => child.on("exit", (code) => { exited = code; done(); }));
  const stop = async () => {
    if (exited === undefined) {
      child.kill();
      await Promise.race([gone, new Promise((done) => setTimeout(done, 5_000))]);
    }
  };
  const app = new MacDriver(`http://127.0.0.1:${port}`, token);
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (exited !== undefined) throw new Error(`The app exited (${exited}) before it could be driven:\n${log.join("")}`);
    try {
      if ((await app.execute<string>(`return document.readyState;`)) === "complete") break;
    } catch (error) {
      if (Date.now() > deadline) { await stop(); throw new Error(`${String(error)}; the app said:\n${log.join("").slice(-4000)}`, { cause: error }); }
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  return { app, stop };
}

/** A request the scheme answered, read from the app's `GHOSTLY_STREAM_LOG` lines. */
export interface Served { method: string; range: string; status: number; body: number }

export function servedRequests(log: string): Served[] {
  const out: Served[] = [];
  for (const match of log.matchAll(/\[ghostly-file\] (\w+) range=(\S+) -> (\d+) content-range=\S+ body=(\d+)/g)) {
    out.push({ method: match[1]!, range: match[2]!, status: Number(match[3]), body: Number(match[4]) });
  }
  return out;
}

export interface FullscreenReport {
  /** `document.fullscreenEnabled`: false where the engine has the API off (WKWebView before src-tauri/src/fullscreen.rs). */
  enabled: boolean;
  /** Where `requestFullscreen` got: the element full screen, or why not. */
  entered: boolean;
  error?: string;
  /** The Tauri window's own state while the element was full screen (WebView2 needs the host for it). */
  windowFullscreen?: boolean | string;
  /** The page's size then, against the screen's. */
  inner?: [number, number];
  screen?: [number, number];
  /** Out again, and the window with it. */
  exited: boolean;
  windowAfter?: boolean | string;
}

/**
 * A `<video>` asks for full screen from a button, as its Full screen button does, and leaves it again. `click` presses
 * it through the driver (WebDriver's click is a real gesture on Linux); otherwise the press runs inside the driver's
 * script, which WKWebView and WebView2 take as the person's gesture.
 */
export async function fullscreenInPage(app: DesktopApp, { click = false }: { click?: boolean } = {}): Promise<FullscreenReport> {
  await app.execute(
    `const press = !arguments[0];
     const video = document.createElement("video");
     video.id = "e2e-fullscreen-video";
     video.muted = true;
     video.style.cssText = "position:fixed;left:0;top:0;width:160px;height:90px;background:#000;z-index:2147483646";
     const button = document.createElement("button");
     button.id = "e2e-fullscreen";
     button.textContent = "Full screen";
     button.style.cssText = "position:fixed;left:0;top:100px;z-index:2147483647";
     window.__e2eFullscreen = { enabled: !!document.fullscreenEnabled };
     button.onclick = () => {
       try { video.requestFullscreen().catch((e) => { window.__e2eFullscreen.error = e.name + ": " + e.message; }); }
       catch (e) { window.__e2eFullscreen.error = String(e); }
     };
     document.body.append(video, button);
     if (press) button.click();`,
    click,
  );
  if (click) await app.click("#e2e-fullscreen");
  return app.executeAsync<FullscreenReport>(
    `const done = arguments[arguments.length - 1];
     const video = document.getElementById("e2e-fullscreen-video");
     const report = { ...window.__e2eFullscreen, entered: false, exited: false };
     const change = (want, ms) => new Promise((resolve) => {
       const start = performance.now();
       const tick = () => {
         if ((document.fullscreenElement === video) === want) return resolve(true);
         if (performance.now() - start > ms) return resolve(false);
         setTimeout(tick, 50);
       };
       tick();
     });
     const windowState = () => window.__TAURI_INTERNALS__.invoke("plugin:window|is_fullscreen", { label: "main" }).catch((e) => "threw: " + e);
     (async () => {
       report.entered = await change(true, 8000);
       report.error = window.__e2eFullscreen.error;
       // The window follows a moment later (an animation on macOS).
       await new Promise((r) => setTimeout(r, 1500));
       report.windowFullscreen = await windowState();
       report.inner = [window.innerWidth, window.innerHeight];
       report.screen = [screen.width, screen.height];
       if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
       report.exited = await change(false, 8000);
       await new Promise((r) => setTimeout(r, 1500));
       report.windowAfter = await windowState();
       video.remove();
       document.getElementById("e2e-fullscreen")?.remove();
       return report;
     })().then(done, (e) => done({ ...report, error: String(e) }));`,
  );
}

export interface WindowFullscreenReport { api: { enabled: boolean; request: string }; on?: boolean | string; off?: boolean | string; error?: string }

/**
 * Where the engine's full screen is off (Desktop on Linux), what the video's own Full screen button uses instead: the
 * window in and out of full screen (`plugin:window|set_fullscreen`, which the capability must grant).
 */
export function windowFullscreenInPage(app: DesktopApp): Promise<WindowFullscreenReport> {
  return app.executeAsync<WindowFullscreenReport>(
    `const done = arguments[arguments.length - 1];
     const invoke = window.__TAURI_INTERNALS__.invoke;
     const report = { api: { enabled: !!document.fullscreenEnabled, request: typeof document.createElement("video").requestFullscreen } };
     const state = () => invoke("plugin:window|is_fullscreen", { label: "main" });
     const settle = async (want) => { for (let i = 0; i < 40; i++) { if ((await state()) === want) return want; await new Promise((r) => setTimeout(r, 100)); } return state(); };
     (async () => {
       await invoke("plugin:window|set_fullscreen", { label: "main", value: true });
       report.on = await settle(true);
       await invoke("plugin:window|set_fullscreen", { label: "main", value: false });
       report.off = await settle(false);
       return report;
     })().then(done, (e) => done({ ...report, error: String(e) }));`,
  );
}
