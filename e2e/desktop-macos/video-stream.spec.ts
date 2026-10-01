import { mkdirSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { makeBigVideo, type BigVideo } from "../support/bigVideo";
import { forgetSharedData, openMacDesktop, type MacDesktop } from "../support/desktopMac";
import { fullscreenInPage, playFromStore, servePieces, servedRequests, storeInApp } from "../support/streamCheck";

/**
 * A video too large for the page (#381: over 64 MiB, `NATIVE_BLOB_MAX`) plays and seeks in the Desktop app on a Mac,
 * from the stored file: WKWebView reads it in ranges from the `ghostly-file` scheme (apps/desktop/src/file_stream.rs),
 * under the app's own Content-Security-Policy. The video is 100 MB: fifty copies of the two-second fixture with
 * filler between them (support/bigVideo.ts), so a seek to 1:30 reads near the end of the file.
 *
 * The app's request log (`GHOSTLY_STREAM_LOG`) shows what WebKit asked for: ranges, each answer at most 4 MiB, so
 * the file was never whole in memory.
 *
 *   npm run desktop:macos:build
 *   npm run test:e2e:desktop-macos -- video-stream
 */

// 49730-49739: this test's ports.
const PORTS = { app: 49730, pieces: 49731 };
const MAX_BODY = 4 * 1024 * 1024;
const PLACE = { space: "e2e-stream", id: "chat-in-video-1" };
const DIR = fileURLToPath(new URL("../../test-results/desktop-macos-video", import.meta.url));

let desktop: MacDesktop | null = null;
let server: Server | null = null;
let video: BigVideo;

test.beforeAll(() => {
  test.skip(process.platform !== "darwin", "macOS only");
  forgetSharedData();
  mkdirSync(DIR, { recursive: true });
  video = makeBigVideo(`${DIR}/big.mp4`);
});
test.afterAll(async () => {
  await desktop?.stop();
  await new Promise((done) => (server ? server.close(done) : done(null)));
  forgetSharedData();
  rmSync(DIR, { recursive: true, force: true });
});

test("a 100 MB video plays and seeks from the stored file, a range at a time", {
  tag: ["@client:desktop", "@feature:files.video.stream"],
}, async () => {
  server = await servePieces(video.path, PORTS.pieces);
  desktop = await openMacDesktop({ name: "stream", port: PORTS.app, env: { GHOSTLY_STREAM_LOG: `${DIR}/requests.log` } });
  await storeInApp(desktop.app, PORTS.pieces, video.size, PLACE);

  const report = await playFromStore(desktop.app, PLACE, 90);
  test.info().annotations.push({ type: "WKWebView", description: JSON.stringify({ ...report, events: report.events?.slice(0, 40) }) });
  expect(report.error, JSON.stringify(report.events)).toBeUndefined();
  expect(report.url).toMatch(/^ghostly-file:\/\/localhost\/[A-Za-z0-9_-]{43}$/);
  expect(report.duration).toBeCloseTo(video.duration, 0);
  expect(report.playedTo).toBeGreaterThan(1);
  expect(report.seekedTo).toBeGreaterThanOrEqual(89.5);
  expect(report.playedAfterSeek).toBeGreaterThan(91);
  if (report.frames! >= 0) expect(report.frames).toBeGreaterThan(report.framesBeforeSeek!);

  const served = servedRequests(readFileSync(`${DIR}/requests.log`, "utf8"));
  test.info().annotations.push({ type: "requests", description: JSON.stringify(served.slice(0, 60)) });
  expect(served.length).toBeGreaterThan(0);
  // Never the whole file at once, and something read past 80 MB (the seek).
  expect(Math.max(...served.map((request) => request.body))).toBeLessThanOrEqual(MAX_BODY);
  expect(served.some((request) => request.status === 206 && Number(/^bytes=(\d+)/.exec(request.range)?.[1] ?? 0) > 80 * 1024 * 1024)).toBe(true);
  expect(served.every((request) => request.status === 200 || request.status === 206)).toBe(true);

  // The token is closed: the same URL is refused now.
  const after = await desktop.app.executeAsync<number | string>(
    `const [url, done] = arguments;
     const probe = document.createElement("video");
     probe.muted = true;
     probe.onerror = () => done(probe.error ? probe.error.code : -1);
     probe.onloadedmetadata = () => done("loaded");
     probe.src = url;
     setTimeout(() => done("no answer"), 15000);`,
    report.url,
  );
  expect(after).not.toBe("loaded");
});

// A video's Full screen button did nothing on the Mac (Picture in Picture worked): WKWebView ships with element full
// screen off. apps/desktop/src/fullscreen.rs turns it on; WebKit shows the element in a full-screen window of its own.
test("a video goes full screen and comes back", {
  tag: ["@client:desktop", "@feature:files.video.play"],
}, async () => {
  desktop ??= await openMacDesktop({ name: "stream", port: PORTS.app });
  const report = await fullscreenInPage(desktop.app);
  test.info().annotations.push({ type: "fullscreen", description: JSON.stringify(report) });
  expect(report.enabled).toBe(true);
  expect(report.error).toBeUndefined();
  expect(report.entered).toBe(true);
  expect(report.exited).toBe(true);
});
