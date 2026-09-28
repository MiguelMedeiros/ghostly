import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { makeBigVideo } from "../support/bigVideo";
import { desktopHome, expect, openDesktop, test } from "../support/desktop";
import { freePort, fullscreenInPage, openDriven, windowFullscreenInPage, playFromStore, removeFromApp, servePieces, servedRequests, storeInApp } from "../support/streamCheck";

/**
 * A video too large for the page (#381: over 64 MiB) plays and seeks in the Desktop WebView from the stored file,
 * read in ranges from what Rust serves it on (src-tauri/src/file_stream.rs) under the app's own policy. This harness
 * runs Linux's WebKitGTK, which plays no custom scheme, so it gets HTTP on 127.0.0.1, and Windows' WebView2
 * (`http://ghostly-file.localhost/<token>`); the macOS
 * WKWebView has the same check in e2e/desktop-macos/video-stream.spec.ts. The video is 100 MB, fifty copies of the
 * two-second fixture (support/bigVideo.ts): H.264 where the engine plays it, else VP9 (a WebKitGTK without
 * gstreamer1.0-libav).
 */

const MAX_BODY = 4 * 1024 * 1024;
const PLACE = { space: "e2e-stream", id: "chat-in-video-1" };
const DIR = fileURLToPath(new URL("../../test-results/desktop-video", import.meta.url));
/**
 * Windows: the app's own test driver (see `openDriven`). `GHOSTLY_E2E_DRIVEN=1` forces it elsewhere, for debugging
 * the harness only: on a Mac the bare binary's window is hidden, so WebKit decodes nothing and refuses full screen;
 * Macs have e2e/desktop-macos/video-stream.spec.ts.
 */
const DRIVEN = process.platform === "win32" || process.env.GHOSTLY_E2E_DRIVEN === "1";

test("a 100 MB video plays and seeks from the stored file, a range at a time", { tag: ["@feature:files.video.stream"] }, async () => {
  mkdirSync(DIR, { recursive: true });
  const home = desktopHome("stream");
  const log = `${DIR}/requests.log`;
  rmSync(log, { force: true });
  const { app, stop } = DRIVEN
    ? await openDriven({ GHOSTLY_STREAM_LOG: log })
    : await openDesktop({ home: home.dir, env: { GHOSTLY_STREAM_LOG: log } });
  let server: Server | null = null;
  try {
    await expect.poll(() => app.text('[title="New Chat"]')).not.toBeNull();
    const h264 = await app.execute<string>(`return document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E"');`);
    const video = makeBigVideo(`${DIR}/big.mp4`, { codec: h264 ? "h264" : "vp9" });
    const piecesPort = await freePort();
    server = await servePieces(video.path, piecesPort);
    await storeInApp(app, piecesPort, video.size, PLACE);

    const report = await playFromStore(app, PLACE, 90);
    test.info().annotations.push({ type: "playback", description: JSON.stringify({ h264, ...report, events: report.events?.slice(0, 40) }) });
    const served = existsSync(log) ? servedRequests(readFileSync(log, "utf8")) : [];
    test.info().annotations.push({ type: "requests", description: JSON.stringify(served.slice(0, 80)) });

    expect(report.error, JSON.stringify(report.events)).toBeUndefined();
    const loopback = /^http:\/\/127\.0\.0\.1:\d+\//.test(report.url ?? "");
    expect(report.url).toMatch(({
      linux: /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}$/,
      win32: /^https?:\/\/ghostly-file\.localhost\/[A-Za-z0-9_-]{43}$/,
    } as Record<string, RegExp>)[process.platform] ?? /^ghostly-file:\/\/localhost\/[A-Za-z0-9_-]{43}$/);
    expect(report.duration).toBeCloseTo(video.duration, 0);
    expect(report.seekedTo).toBeGreaterThanOrEqual(89.5);
    expect(report.playedAfterSeek).toBeGreaterThan(91);
    expect(served.length).toBeGreaterThan(0);
    // The scheme never answers with more than 4 MiB at once; the loopback server streams to the socket instead. Either
    // way the seek read past 80 MB.
    if (!loopback) expect(Math.max(...served.map((request) => request.body))).toBeLessThanOrEqual(MAX_BODY);
    expect(served.some((request) => request.status === 206 && Number(/^bytes=(\d+)/.exec(request.range)?.[1] ?? 0) > 80 * 1024 * 1024)).toBe(true);
  } finally {
    await removeFromApp(app, PLACE);
    await stop();
    await new Promise((done) => (server ? server.close(done) : done(null)));
    home.remove();
    rmSync(DIR, { recursive: true, force: true });
  }
});

// A video's Full screen button fills the screen. WebView2 fills only the webview until the window follows it
// (src-tauri/src/fullscreen.rs). WebKitGTK 2.50 aborts the app entering element full screen, so on Linux the API is off
// and the video's own button puts the window in full screen instead. The macOS WKWebView:
// e2e/desktop-macos/video-stream.spec.ts.
test("a video goes full screen, the window with it, and comes back", { tag: ["@feature:files.video.play"] }, async () => {
  const home = desktopHome("fullscreen");
  const { app, stop } = DRIVEN ? await openDriven() : await openDesktop({ home: home.dir });
  try {
    await expect.poll(() => app.text('[title="New Chat"]')).not.toBeNull();
    if (process.platform === "linux") {
      const report = await windowFullscreenInPage(app);
      test.info().annotations.push({ type: "fullscreen", description: JSON.stringify(report) });
      expect(report.api).toEqual({ enabled: false, request: "undefined" });
      expect(report.error).toBeUndefined();
      expect(report.on).toBe(true);
      expect(report.off).toBe(false);
      // Still here: the app answers.
      expect(await app.execute<string>(`return document.readyState;`)).toBe("complete");
      return;
    }
    const report = await fullscreenInPage(app, { click: !DRIVEN });
    test.info().annotations.push({ type: "fullscreen", description: JSON.stringify(report) });
    expect(report.enabled).toBe(true);
    expect(report.error).toBeUndefined();
    expect(report.entered).toBe(true);
    expect(report.exited).toBe(true);
    if (process.platform === "win32") {
      expect(report.windowFullscreen).toBe(true);
      expect(report.windowAfter).toBe(false);
    }
  } finally {
    await stop();
    home.remove();
  }
});
