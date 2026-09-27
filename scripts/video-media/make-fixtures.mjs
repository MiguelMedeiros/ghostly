#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Makes the videos in `e2e/support/video-fixtures/` (CI has no ffmpeg, so they are committed): two seconds of
 * ffmpeg's test pattern, 320x180, no sound, with the index at the front (`faststart`).
 *
 * - `ghosts.mp4`: VP9 in MP4. Chromium plays it on every OS without H.264 (open-source builds on Linux have none),
 *   so the web e2e uses it.
 * - `ghosts-h264.mp4`: H.264 in MP4, what phones and cameras make: the macOS WKWebView check plays it.
 *
 * Run: `node scripts/video-media/make-fixtures.mjs` (needs ffmpeg with libvpx and libx264).
 */
const dir = fileURLToPath(new URL("../../e2e/support/video-fixtures/", import.meta.url));
const source = ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-t", "2", "-an", "-movflags", "+faststart"];
const make = (name, codec) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...source, ...codec, `${dir}${name}`], { stdio: "inherit" });
make("ghosts.mp4", ["-c:v", "libvpx-vp9", "-b:v", "150k", "-pix_fmt", "yuv420p"]);
make("ghosts-h264.mp4", ["-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-b:v", "150k"]);
