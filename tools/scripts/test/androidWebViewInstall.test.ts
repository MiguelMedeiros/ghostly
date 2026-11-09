import { createHash, randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { PINNED, currentWebView, fetchEntry, minWebView, webViewProblem } from "../android-webview.mjs";

/*
 * The API 30 google_apis emulator image ships WebView 83, below the app's minimum (MainActivity.kt `MIN_WEBVIEW`), so
 * the app shows its update screen and no spec reaches its page. tools/scripts/android-webview.mjs gives such a device a
 * pinned Chromium SystemWebView.apk: only that file of the snapshot's zip is fetched (range requests), and it is
 * installed only when its sha256 is the pinned one.
 */

/** `adb shell dumpsys webviewupdate` on the API 30 google_apis emulator. */
const API30 = `Current WebView Update Service state
  Fallback logic enabled: true
  Current WebView package (name, version): (com.google.android.webview, 83.0.4103.106)
  Minimum targetSdkVersion: 30
  Preferred WebView package (name, version): (com.google.android.webview, 83.0.4103.106)
`;
const AFTER = API30.replace("(com.google.android.webview, 83.0.4103.106)", "(com.android.webview, 140.0.7339.0)");

/** A zip of `files` (deflated), as a snapshot's archive is laid out: local headers, central directory, end record. */
function zip(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const packed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    // A local extra field the central directory does not repeat: the data starts after it.
    local.writeUInt16LE(4, 28);
    locals.push(local, Buffer.from(name), Buffer.alloc(4), packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, Buffer.from(name));
    offset += 30 + name.length + 4 + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A fetch that serves `body` with HTTP ranges and counts the bytes it sent. */
function rangeServer(body: Buffer) {
  const served = { bytes: 0, requests: 0 };
  const fetch = async (_url: string, init?: { headers?: Record<string, string> }) => {
    served.requests += 1;
    const range = /^bytes=(\d*)-(\d*)$/.exec(init?.headers?.Range ?? "");
    if (!range) throw new Error("not a range request");
    const [start, end] = range[1] === "" ? [body.length - Number(range[2]), body.length - 1] : [Number(range[1]), Math.min(Number(range[2]), body.length - 1)];
    const part = body.subarray(start, end + 1);
    served.bytes += part.length;
    return new Response(part, { status: 206 });
  };
  return { fetch, served };
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

describe("the emulator's WebView", () => {
  it("is read from dumpsys webviewupdate, against MainActivity.kt's minimum", () => {
    expect(currentWebView(API30)).toEqual({ pkg: "com.google.android.webview", version: "83.0.4103.106", major: 83 });
    expect(currentWebView("Can't find service: webviewupdate")).toBeNull();
    expect(minWebView()).toBe(111);
    expect(webViewProblem(API30, 111)).toMatch(/83\.0\.4103\.106.*111/);
    expect(webViewProblem(AFTER, 111)).toBeNull();
    expect(webViewProblem("", 111)).toMatch(/no current WebView/);
  });
});

describe("the pinned SystemWebView.apk", () => {
  it("is one file of a Chromium snapshot, pinned by its object generation and its sha256", () => {
    expect(PINNED.url).toMatch(/^https:\/\/www\.googleapis\.com\/download\/storage\/v1\/b\/chromium-browser-snapshots\/o\/AndroidDesktop_x64%2F\d+%2Fchrome-android-desktop\.zip\?generation=\d+&alt=media$/);
    expect(PINNED.entry).toBe("chrome-android-desktop/apks/SystemWebView.apk");
    expect(PINNED.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The one provider a userdebug Google APIs image takes besides Google's own: Chromium's SystemWebView.
    expect(PINNED.pkg).toBe("com.android.webview");
    expect(Number(PINNED.version.split(".")[0])).toBeGreaterThanOrEqual(minWebView());
  });

  it("is fetched alone from the archive, by range", async () => {
    const apk = Buffer.from("an APK, ".repeat(50_000));
    // Random, so it stays large deflated: the archive is bigger than the 64 KB its end record is looked for in.
    const other = randomBytes(400_000);
    const archive = zip({ "chrome-android-desktop/apks/ChromePublic.apk": other, [PINNED.entry]: apk });
    const { fetch, served } = rangeServer(archive);
    const got = await fetchEntry("https://snapshot", PINNED.entry, sha256(apk), fetch);
    expect(got.equals(apk)).toBe(true);
    expect(served.bytes).toBeLessThan(archive.length / 2);
  });

  it("is refused when its sha256 is not the pinned one, or the archive has no such file", async () => {
    const archive = zip({ [PINNED.entry]: Buffer.from("another build") });
    const { fetch } = rangeServer(archive);
    await expect(fetchEntry("https://snapshot", PINNED.entry, "0".repeat(64), fetch)).rejects.toThrow(/sha256/);
    await expect(fetchEntry("https://snapshot", "apks/Nothing.apk", "0".repeat(64), fetch)).rejects.toThrow(/no apks\/Nothing\.apk/);
  });
});
