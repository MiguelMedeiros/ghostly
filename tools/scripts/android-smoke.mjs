// The native Android app on an emulator (.github/workflows/android-native.yml): it launches, the UI renders and the
// engine starts, then the probe measures what the native app depends on, from inside its own WebView:
// - the WebView itself (version), WebCrypto Ed25519 and X25519, WebRTC and its permissions (no microphone is opened);
// - native Iroh: an endpoint binds, gets an address, and a second endpoint connects to it (netwatch on Android);
// - Pkarr over UDP: a packet written to and read from the Mainline DHT only (no relay), then through the relays;
// - HTTPS from Rust, which checks certificates with Android's own verifier;
// - the `ghostly-file` scheme: a range request, and a <video> playing from it;
// - JavaScript timers while the screen is off (an emulator's answer, which a phone has to confirm).
// Every result goes to $ANDROID_SMOKE_OUT/results.json and results.md, with screenshots and the logs. Only the smoke
// test fails the job (the app does not start or its UI does not render); a measurement records what it saw.
//
//   ANDROID_SMOKE_APK=<apk> ANDROID_SMOKE_OUT=<dir> node tools/scripts/android-smoke.mjs
import { _android } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PKG = "tools.ghostly.app";
const apk = process.env.ANDROID_SMOKE_APK;
const out = resolve(process.env.ANDROID_SMOKE_OUT ?? "android-smoke");
if (!apk) throw new Error("ANDROID_SMOKE_APK: the APK to install");
mkdirSync(out, { recursive: true });

const adb = (...args) => execFileSync("adb", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const results = [];
/** One line of the table: `ok` true (works), false (does not), or null (not measured / unknown). */
const record = (area, check, ok, detail) => {
  results.push({ area, check, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
  console.log(`${ok === true ? "yes" : ok === false ? "NO " : " ? "} ${area}: ${check}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
};
/** Runs one measurement; an exception is its result, not the end of the probe. */
const measure = async (area, check, run) => {
  try {
    await run();
  } catch (error) {
    record(area, check, false, String(error?.message ?? error).slice(0, 400));
  }
};

const write = () => {
  writeFileSync(resolve(out, "results.json"), JSON.stringify(results, null, 2));
  const cell = (text) => String(text).replaceAll("|", "\\|").replaceAll("\n", " ");
  const rows = results.map((r) => `| ${r.area} | ${r.check} | ${r.ok === true ? "yes" : r.ok === false ? "**no**" : "?"} | ${cell(r.detail)} |`);
  writeFileSync(resolve(out, "results.md"), ["## Android emulator", "", "| Area | Check | Works | Detail |", "|---|---|---|---|", ...rows, ""].join("\n"));
};

let smokeFailed = false;
let device;
try {
  record("device", "Android", true, `${adb("shell", "getprop", "ro.build.version.release").trim()} (API ${adb("shell", "getprop", "ro.build.version.sdk").trim()}), ${adb("shell", "getprop", "ro.product.cpu.abi").trim()}`);
  adb("install", "-r", apk);
  adb("logcat", "-c");
  // `ghostly_e2e`: a debug build's switch for GHOSTLY_E2E=1 (MainActivity.kt): no name step, no default wallets.
  const started = adb("shell", "am", "start", "-W", "-n", `${PKG}/.MainActivity`, "--ez", "ghostly_e2e", "true");
  record("smoke", "activity starts", /Status: ok/.test(started), started.match(/TotalTime: \d+/)?.[0] ?? started.trim().split("\n").pop());

  [device] = await _android.devices();
  if (!device) throw new Error("no device from adb");
  const t0 = Date.now();
  const webview = await device.webView({ pkg: PKG }, { timeout: 120_000 });
  const page = await webview.page();
  const consoleLines = [];
  page.on("console", (message) => consoleLines.push(`${message.type()}: ${message.text()}`.slice(0, 500)));
  page.setDefaultTimeout(120_000);
  record("smoke", "WebView found over adb", true, `${Date.now() - t0} ms, ${page.url()}`);

  // The UI rendered: the same marks as the Desktop smoke test (e2e/desktop/smoke.spec.ts).
  await measure("smoke", "UI renders", async () => {
    await page.locator('[title="New chat"]').first().waitFor({ state: "attached" });
    record("smoke", "UI renders", true, `"New chat" after ${Date.now() - t0} ms`);
  });
  await page.screenshot({ path: resolve(out, "home.png") }).catch(() => {});
  if (!results.some((r) => r.check === "UI renders" && r.ok)) smokeFailed = true;

  const env = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    tauri: "__TAURI_INTERNALS__" in window,
    origin: location.origin,
    secure: window.isSecureContext,
    coarse: matchMedia("(any-pointer: coarse)").matches,
    fine: matchMedia("(any-pointer: fine)").matches,
    viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
  }));
  // The UI leaves the composer unfocused (no keyboard) only on a touch-only screen (apps/ui/src/lib/touchOnly.ts).
  record("webview", "touch only (no autofocus, no keyboard on open)", env.coarse && !env.fine, `any-pointer coarse ${env.coarse}, fine ${env.fine}; viewport ${env.viewport}`);
  record("webview", "version", env.tauri, `${env.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? env.userAgent}; ${env.origin}; secure context ${env.secure}`);

  // The engine started with the Desktop host: only apps/ui/src/desktop/host.ts describes Pkarr this way.
  await measure("smoke", "engine starts (Desktop host, direct DHT)", async () => {
    // Settings, Network, by its address (the phone layout reaches it through the tab bar and the section list).
    await page.evaluate(() => { location.hash = "#/settings/network"; });
    const protocol = page.locator('[data-testid="network-protocol"]').first();
    await protocol.waitFor({ state: "attached", timeout: 60_000 });
    const text = (await protocol.textContent())?.trim();
    record("smoke", "engine starts (Desktop host, direct DHT)", /Direct UDP/.test(text ?? ""), text);
    await page.screenshot({ path: resolve(out, "settings.png") }).catch(() => {});
    await page.evaluate(() => { location.hash = "#/"; });
  });

  // From here on, the page's own Tauri bridge: what the app's code would call.
  const invoke = (cmd, args, options) => page.evaluate(([cmd, args, options]) => window.__TAURI_INTERNALS__.invoke(cmd, args, options), [cmd, args, options]);

  await measure("webcrypto", "Ed25519 generate/sign/verify", async () => {
    const r = await page.evaluate(async () => {
      const key = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
      const data = new TextEncoder().encode("ghostly");
      const signature = await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, data);
      return { extractable: key.privateKey.extractable, verified: await crypto.subtle.verify({ name: "Ed25519" }, key.publicKey, signature, data) };
    });
    record("webcrypto", "Ed25519 generate/sign/verify", r.verified, `non-extractable private key: ${!r.extractable}`);
  });
  await measure("webcrypto", "X25519 derive", async () => {
    const bits = await page.evaluate(async () => {
      const a = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
      const b = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
      return (await crypto.subtle.deriveBits({ name: "X25519", public: b.publicKey }, a.privateKey, 256)).byteLength;
    });
    record("webcrypto", "X25519 derive", bits === 32, `${bits} bytes`);
  });

  await measure("webrtc", "RTCPeerConnection, data channel, ICE", async () => {
    const r = await page.evaluate(async () => {
      if (typeof RTCPeerConnection !== "function") return { present: false };
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel("probe");
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((done) => {
        if (pc.iceGatheringState === "complete") return done();
        pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && done());
        setTimeout(done, 5_000);
      });
      const candidates = (pc.localDescription?.sdp ?? "").split("\n").filter((l) => l.startsWith("a=candidate"));
      pc.close();
      return { present: true, candidates: candidates.length, types: [...new Set(candidates.map((c) => c.split(" ")[7]))] };
    });
    record("webrtc", "RTCPeerConnection, data channel, ICE", r.present && r.candidates > 0, r);
  });
  await measure("webrtc", "getUserMedia and permissions (not opened)", async () => {
    const r = await page.evaluate(async () => {
      const state = async (name) => {
        try {
          return (await navigator.permissions.query({ name })).state;
        } catch (error) {
          return `query failed: ${error?.name}`;
        }
      };
      return {
        getUserMedia: typeof navigator.mediaDevices?.getUserMedia === "function",
        enumerateDevices: (await navigator.mediaDevices?.enumerateDevices?.())?.map((d) => d.kind) ?? null,
        microphone: await state("microphone"),
        camera: await state("camera"),
      };
    });
    record("webrtc", "getUserMedia and permissions (not opened)", r.getUserMedia, r);
  });

  // Native Iroh (paired_transport.rs): two endpoints in the app, the second dialing the first by its address.
  await measure("iroh", "endpoint binds", async () => {
    const seed = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const start = (seedB64) =>
      page.evaluate(async (seedB64) => {
        const id = window.__TAURI_INTERNALS__.transformCallback(() => {});
        return await window.__TAURI_INTERNALS__.invoke("paired_iroh_start", { seedB64, events: `__CHANNEL__:${id}` });
      }, seedB64);
    const t = Date.now();
    const a = await start(seed());
    record("iroh", "endpoint binds", true, { ms: Date.now() - t, started: a });
    let address;
    for (let i = 0; i < 20; i++) {
      address = await invoke("paired_iroh_address", { endpointId: a.endpointId ?? a.id ?? a });
      if (JSON.stringify(address).includes("http")) break;
      await sleep(500);
    }
    record("iroh", "address (direct + relay)", !!address, address);
    await measure("iroh", "second endpoint connects to the first", async () => {
      const b = await start(seed());
      const t2 = Date.now();
      const connection = await invoke("paired_iroh_connect", { endpointId: b.endpointId ?? b.id ?? b, descriptor: address });
      record("iroh", "second endpoint connects to the first", true, { ms: Date.now() - t2, connection });
      await invoke("paired_iroh_stop", { endpointId: b.endpointId ?? b.id ?? b }).catch(() => {});
    });
    await invoke("paired_iroh_stop", { endpointId: a.endpointId ?? a.id ?? a }).catch(() => {});
  });

  // Pkarr (pkarr_network.rs): no relay to write to or read from, so the packet goes through the DHT over UDP only.
  await measure("pkarr", "DHT write (UDP)", async () => {
    await invoke("set_pkarr_relays", { relays: [], readRelays: false });
    const seedB64 = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const t = Date.now();
    await invoke("publish_records", { seedB64, records: [{ label: "_probe", value: `android-${Date.now()}`, ttl: 300 }] });
    record("pkarr", "DHT write (UDP)", true, `${Date.now() - t} ms`);
    const key = await invoke("get_public_key", { seedB64 });
    const t2 = Date.now();
    const packet = await invoke("resolve_records", { publicKeyZ32: key, urgent: true });
    record("pkarr", "DHT read (UDP)", !!packet, `${Date.now() - t2} ms, ${packet ? "found" : "not found"}`);
    record("pkarr", "status", null, await invoke("pkarr_status"));
  });

  // HTTPS from Rust: reqwest checks certificates with Android's verifier (rustls-platform-verifier, `android_tls`).
  await measure("https", "HTTPS from Rust (link preview GET)", async () => {
    const t = Date.now();
    const page_ = await invoke("link_preview_fetch", { url: "https://example.com/", kind: "page" });
    record("https", "HTTPS from Rust (link preview GET)", !!page_?.bodyB64, `${Date.now() - t} ms, ${page_?.contentType}`);
  });
  // Where a slow relay write goes: a new TLS connection (and Android's certificate check) against a warm one.
  await measure("https", "TLS to a Pkarr relay, cold then warm", async () => {
    const times = [];
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      await invoke("link_preview_fetch", { url: "https://pkarr.pubky.app/", kind: "page" }).catch((e) => e);
      times.push(Date.now() - t);
    }
    record("https", "TLS to a Pkarr relay, cold then warm", null, `${times.join(" ms, ")} ms (GET https://pkarr.pubky.app/)`);
  });
  await measure("pkarr", "relay write (HTTPS)", async () => {
    await invoke("set_pkarr_relays", { relays: ["https://pkarr.pubky.org", "https://pkarr.pubky.app"], readRelays: true });
    const seedB64 = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const t = Date.now();
    await invoke("publish_records", { seedB64, records: [{ label: "_probe", value: `android-relay-${Date.now()}`, ttl: 300 }] });
    record("pkarr", "relay write (HTTPS)", true, { ms: Date.now() - t, status: await invoke("pkarr_status") });
  });

  // The `ghostly-file` scheme (file_stream.rs): a stored video, read in ranges and played by the WebView.
  await measure("files", "ghostly-file", async () => {
    const video = readFileSync(resolve("e2e/support/video-fixtures/ghosts-h264.mp4"));
    const space = "android-probe";
    const id = "probe-video";
    await page.evaluate(async ([b64, space, id]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await window.__TAURI_INTERNALS__.invoke("file_bytes_append", bytes, { headers: { "x-space": space, "x-id": id, "x-offset": "0" } });
      await window.__TAURI_INTERNALS__.invoke("file_bytes_close", { space, id });
    }, [video.toString("base64"), space, id]);
    const read = await page.evaluate(async ([space, id]) => {
      const answer = await window.__TAURI_INTERNALS__.invoke("file_bytes_read", { space, id, offset: 0, length: 16 });
      return { type: Object.prototype.toString.call(answer), length: answer?.byteLength ?? answer?.length };
    }, [space, id]);
    record("files", "file_bytes_append (JSON bytes over postMessage) + file_bytes_read", read.length === 16, read);
    const opened = await invoke("file_bytes_stream_open", { space, id, mime: "video/mp4" });
    // From the page: the scheme is another origin (http://ghostly-file.localhost), so a fetch needs CORS, which a
    // media element does not. Recorded, not required.
    const r = await page.evaluate(async (url) => {
      try {
        const response = await fetch(url, { headers: { Range: "bytes=0-99" } });
        return { url, status: response.status, contentRange: response.headers.get("content-range"), length: (await response.arrayBuffer()).byteLength };
      } catch (error) {
        return { url, error: String(error) };
      }
    }, opened.url);
    record("files", "ghostly-file fetch with Range from the page", r.status === 206 ? true : null, r);
    const played = await page.evaluate(
      (url) =>
        new Promise((done) => {
          const v = document.createElement("video");
          v.muted = true;
          v.preload = "auto";
          const finish = (what) => {
            done({ what, duration: v.duration, readyState: v.readyState, error: v.error?.code ?? null });
            v.remove();
          };
          v.addEventListener("loadedmetadata", () => {
            v.currentTime = Math.min(1, v.duration / 2);
          });
          v.addEventListener("seeked", () => finish("seeked"));
          v.addEventListener("error", () => finish("error"));
          setTimeout(() => finish("timeout"), 20_000);
          v.src = url;
          document.body.append(v);
        }),
      opened.url,
    );
    record("files", "<video> from ghostly-file (metadata + seek)", played.what === "seeked", played);
    // What the scheme answered the media player (MainActivity sets GHOSTLY_STREAM_LOG in a debug e2e start).
    const served = adb("shell", "run-as", PKG, "cat", "files/ghostly-file.log").trim().split("\n").filter(Boolean);
    record("files", "ghostly-file range requests (206)", served.some((l) => / -> 206 /.test(l)), served.slice(0, 6).join(" / ") || "no request reached the scheme");
  });

  // Timers with the screen off: an emulator's answer only. A phone (Doze, the maker's battery rules) can differ.
  await measure("background", "JS timers with the screen off (60 s, emulator)", async () => {
    await page.evaluate(() => {
      window.__probeTicks = 0;
      window.__probeTimer = setInterval(() => window.__probeTicks++, 1_000);
    });
    adb("shell", "input", "keyevent", "KEYCODE_SLEEP");
    await sleep(60_000);
    adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
    const ticks = await page.evaluate(() => window.__probeTicks);
    record("background", "JS timers with the screen off (60 s, emulator)", ticks >= 50, `${ticks} ticks of 60`);
  });

  writeFileSync(resolve(out, "console.txt"), consoleLines.join("\n"));
} catch (error) {
  smokeFailed = true;
  record("smoke", "probe", false, String(error?.stack ?? error).slice(0, 800));
} finally {
  // What Rust and Android said: netwatch/netlink trouble shows here, and the app's own log (diagnostics.rs).
  try {
    const logcat = adb("logcat", "-d", "-v", "time");
    writeFileSync(resolve(out, "logcat.txt"), logcat);
    const pid = adb("shell", "pidof", PKG).trim();
    const ours = logcat.split("\n").filter((l) => pid && l.includes(`(${pid.padStart(5)})`));
    writeFileSync(resolve(out, "logcat-app.txt"), ours.join("\n"));
    const netlink = ours.filter((l) => /netlink|netwatch|EACCES|Permission denied|avc: denied/i.test(l));
    record("iroh", "netlink / netwatch in logcat", netlink.length === 0 ? true : null, netlink.length ? netlink.slice(0, 5).join(" / ").slice(0, 600) : "no netlink, netwatch or permission errors");
    // Each publish's sources and when each answered (pkarr_network.rs: "pkarr publish <key> done dht=ok@<ms> ...").
    const publishes = ours.map((l) => l.match(/pkarr publish \w+ done (.*)$/)?.[1]).filter(Boolean);
    record("pkarr", "publish timings (app log)", null, publishes.join(" / ") || "none");
    const crash = logcat.split("\n").filter((l) => /FATAL EXCEPTION|panicked at|SIGSEGV|SIGABRT/.test(l));
    record("smoke", "no crash in logcat", crash.length === 0, crash.slice(0, 3).join(" / ").slice(0, 600) || "none");
    if (crash.length) smokeFailed = true;
  } catch (error) {
    record("smoke", "logcat", null, String(error));
  }
  try {
    writeFileSync(resolve(out, "app-files.txt"), adb("shell", "run-as", PKG, "find", ".", "-maxdepth", "4"));
    // The app's own log (diagnostics.rs), not the WebView's storage files.
    const logs = adb("shell", "run-as", PKG, "find", ".", "-name", "'*.log'", "-not", "-path", "'./app_webview/*'").trim().split("\n").filter(Boolean);
    for (const [i, file] of logs.entries()) writeFileSync(resolve(out, `app-log-${i}.txt`), adb("shell", "run-as", PKG, "cat", `'${file.trim()}'`));
  } catch (error) {
    record("smoke", "app log", null, String(error).slice(0, 200));
  }
  try {
    if (device) await device.screenshot({ path: resolve(out, "device.png") });
  } catch {}
  write();
  await device?.close().catch(() => {});
}
process.exit(smokeFailed ? 1 : 0);
