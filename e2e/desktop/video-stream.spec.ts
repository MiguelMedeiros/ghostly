import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { makeBigVideo } from "../support/bigVideo";
import { desktopHome, expect, openDesktop, test } from "../support/desktop";
import { playFromStore, servePieces, servedRequests, storeInApp } from "../support/streamCheck";

/**
 * A video too large for the page (#381: over 64 MiB) plays and seeks in the Desktop WebView from the stored file,
 * read in ranges from the `ghostly-file` scheme (src-tauri/src/file_stream.rs) under the app's own policy. This
 * harness runs Linux's WebKitGTK and Windows' WebView2 (`http://ghostly-file.localhost/<token>` there); the macOS
 * WKWebView has the same check in e2e/desktop-macos/video-stream.spec.ts. The video is 100 MB, fifty copies of the
 * two-second fixture (support/bigVideo.ts): H.264 where the engine plays it, else VP9 (a WebKitGTK without
 * gstreamer1.0-libav).
 */

const MAX_BODY = 4 * 1024 * 1024;
const PLACE = { space: "e2e-stream", id: "chat-in-video-1" };
const DIR = fileURLToPath(new URL("../../test-results/desktop-video", import.meta.url));
const PIECES_PORT = 49741;

test("a 100 MB video plays and seeks from the stored file, a range at a time", { tag: ["@feature:files.video.stream"] }, async () => {
  mkdirSync(DIR, { recursive: true });
  const home = desktopHome("stream");
  const log = `${DIR}/requests.log`;
  rmSync(log, { force: true });
  const { app, stop } = await openDesktop({ home: home.dir, env: { GHOSTLY_STREAM_LOG: log } });
  let server: Server | null = null;
  try {
    await expect.poll(() => app.text('[title="New Chat"]')).not.toBeNull();
    const h264 = await app.execute<string>(`return document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E"');`);
    const video = makeBigVideo(`${DIR}/big.mp4`, { codec: h264 ? "h264" : "vp9" });
    server = await servePieces(video.path, PIECES_PORT);
    await storeInApp(app, PIECES_PORT, video.size, PLACE);

    const report = await playFromStore(app, PLACE, 90);
    test.info().annotations.push({ type: "playback", description: JSON.stringify({ h264, ...report, events: report.events?.slice(0, 40) }) });
    const served = existsSync(log) ? servedRequests(readFileSync(log, "utf8")) : [];
    test.info().annotations.push({ type: "requests", description: JSON.stringify(served.slice(0, 80)) });

    expect(report.error, JSON.stringify(report.events)).toBeUndefined();
    expect(report.url).toMatch(/^(ghostly-file:\/\/localhost|https?:\/\/ghostly-file\.localhost)\/[A-Za-z0-9_-]{43}$/);
    expect(report.duration).toBeCloseTo(video.duration, 0);
    expect(report.seekedTo).toBeGreaterThanOrEqual(89.5);
    expect(report.playedAfterSeek).toBeGreaterThan(91);
    expect(served.length).toBeGreaterThan(0);
    // Never the whole file at once, and the seek read past 80 MB.
    expect(Math.max(...served.map((request) => request.body))).toBeLessThanOrEqual(MAX_BODY);
    expect(served.some((request) => request.status === 206 && Number(/^bytes=(\d+)/.exec(request.range)?.[1] ?? 0) > 80 * 1024 * 1024)).toBe(true);
  } finally {
    await stop();
    await new Promise((done) => (server ? server.close(done) : done(null)));
    home.remove();
    rmSync(DIR, { recursive: true, force: true });
  }
});
