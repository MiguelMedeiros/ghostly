import { closeSync, openSync, readSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { DesktopApp } from "./desktop";

/**
 * The Desktop checks that a video too large for the page plays and seeks from the stored file (`ghostly-file`,
 * src-tauri/src/file_stream.rs), in the real WebView under the app's real policy: macOS (WKWebView, the #230
 * driver) and Linux/Windows (tauri-driver). The same page scripts for every engine.
 */

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
       const invoke = window.__TAURI_INTERNALS__.invoke;
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
       const token = await window.__TAURI_INTERNALS__.invoke("file_bytes_stream_open", { space, id, mime: "video/mp4" });
       const url = window.__TAURI_INTERNALS__.convertFileSrc(token, "ghostly-file");
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

/** A request the scheme answered, read from the app's `GHOSTLY_STREAM_LOG` lines. */
export interface Served { method: string; range: string; status: number; body: number }

export function servedRequests(log: string): Served[] {
  const out: Served[] = [];
  for (const match of log.matchAll(/\[ghostly-file\] (\w+) range=(\S+) -> (\d+) content-range=\S+ body=(\d+)/g)) {
    out.push({ method: match[1]!, range: match[2]!, status: Number(match[3]), body: Number(match[4]) });
  }
  return out;
}
