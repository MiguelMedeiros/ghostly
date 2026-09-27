import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildSdpFromSignal, extractParamsFromSdp, parseCallSignal } from "@ghostly/core";
import { desktopHome, openDesktop, type DesktopApp } from "../support/desktop";

/**
 * A Linux Desktop's calls against a browser's own WebRTC: Chromium, with its fake camera and microphone.
 *
 * The Linux Desktop has no WebRTC in its WebView and runs calls in Rust (webrtc-rs, GStreamer). Two Linux apps
 * calling each other (calls.spec.ts) prove it talks to itself; this proves it talks to the browsers. Each
 * description goes the way it goes in a call, as `useWebRTC` sends it: cut down to the signal
 * (`extractParamsFromSdp`), checked on arrival (`parseCallSignal`) and rebuilt (`buildSdpFromSignal`). The
 * signal itself travels through this test instead of a chat, which calls.spec.ts covers.
 *
 * The Linux side is driven through its commands (`native_call_*`), the ones src/desktop/nativeCalls.ts uses,
 * with a test picture and tone (GHOSTLY_FAKE_MEDIA). Each side reads what it received: Rust's counters, and
 * Chromium's `getStats()`.
 */

interface NativeStats { audioReceived: number; videoReceived: number; ice: string }

/** An offer or answer, as the other side rebuilds it from the signal. */
function throughTheSignal(sdp: string, t: "o" | "a"): string {
  const signal = parseCallSignal(JSON.stringify({ t, ts: Date.now(), ...extractParamsFromSdp(sdp), v: 1, k: "c" }));
  expect(signal, `the ${t === "o" ? "offer" : "answer"}'s signal is valid`).not.toBeNull();
  expect(signal!.c?.some((c) => / typ host$/.test(c)), "the signal carries a host candidate").toBe(true);
  return buildSdpFromSignal(signal!);
}

/** Starts the Linux side's call `id` with its camera on; `offer` makes it answer that offer instead of offering. */
function startNative(app: DesktopApp, id: string, offer?: string): Promise<string> {
  return app.executeAsync<string>(`
    const [id, offer] = arguments; const done = arguments[arguments.length - 1];
    const T = window.__TAURI_INTERNALS__;
    const bytes = (m) => m instanceof ArrayBuffer ? new Uint8Array(m) : Array.isArray(m) ? Uint8Array.from(m) : new Uint8Array();
    window.qaCall = { pictures: 0 };
    // The peer's pictures arrive as JPEGs on the call's channel, as they do for the call window.
    const events = T.transformCallback((raw) => { if (bytes(raw?.message)[0] === 0xff) qaCall.pictures++; });
    const frames = T.transformCallback(() => {});
    (async () => {
      await T.invoke("native_call_open", { id, events: "__CHANNEL__:" + events });
      const camera = await T.invoke("native_camera_open", { frames: "__CHANNEL__:" + frames });
      return offer === null
        ? await T.invoke("native_call_offer", { id, camera })
        : await T.invoke("native_call_answer", { id, offer, camera });
    })().then(done, (error) => done("error: " + error));`, id, offer ?? null);
}

const nativeStats = (app: DesktopApp, id: string) => app.executeAsync<NativeStats & { pictures: number }>(`
  const [id] = arguments; const done = arguments[arguments.length - 1];
  window.__TAURI_INTERNALS__.invoke("native_call_stats", { id })
    .then((stats) => done({ ...stats, pictures: window.qaCall.pictures }), (error) => done({ error: String(error) }));`, id);

/** Chromium's side: a peer connection with the fake camera and microphone, as `useWebRTC` makes one. */
async function startBrowser(page: Page, offer?: string): Promise<string> {
  return page.evaluate(async (offer) => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    (window as unknown as { pc: RTCPeerConnection }).pc = pc;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    if (offer) await pc.setRemoteDescription({ type: "offer", sdp: offer });
    await pc.setLocalDescription(offer ? await pc.createAnswer() : await pc.createOffer());
    // As `waitForIceGathering`: the reflexive candidate and a moment more, or complete, or 10 s.
    await new Promise<void>((done) => {
      const finish = () => done();
      setTimeout(finish, 10_000);
      pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && finish());
      pc.addEventListener("icecandidate", (e) => e.candidate?.candidate.includes(" typ srflx") && setTimeout(finish, 400));
      if (pc.iceGatheringState === "complete") finish();
    });
    return pc.localDescription!.sdp;
  }, offer ?? null);
}

const browserStats = (page: Page) => page.evaluate(async () => {
  const pc = (window as unknown as { pc: RTCPeerConnection }).pc;
  let audio = 0;
  let video = 0;
  (await pc.getStats()).forEach((s) => {
    if (s.type !== "inbound-rtp") return;
    if (s.kind === "audio") audio = s.packetsReceived ?? 0;
    if (s.kind === "video") video = s.framesDecoded ?? 0;
  });
  return { audio, video, state: pc.connectionState };
});

let server: Server;
let origin: string;
let browser: Browser;

test.beforeAll(async () => {
  // A page on localhost: a secure context, where getUserMedia is allowed.
  server = createServer((_, response) => response.end("<!doctype html><title>peer</title>"));
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
});

test.afterAll(async () => {
  await browser?.close();
  await new Promise((closed) => server?.close(closed));
});

for (const offerer of ["linux", "chromium"] as const) {
  test(`a Linux Desktop and Chromium call each other, ${offerer === "linux" ? "the Linux Desktop" : "Chromium"} calling: sound and pictures both ways`, {
    tag: ["@feature:calls.linux-native", "@feature:calls.signal"],
  }, async () => {
    test.setTimeout(3 * 60_000);
    const home = desktopHome(`interop-${offerer}`);
    const { app, stop } = await openDesktop({ home: home.dir, profile: `interop-${offerer}` });
    const page = await browser.newPage();
    const id = `interop-${offerer}`;
    try {
      await expect.poll(() => app.text('[title="New Chat"]'), { timeout: 90_000 }).not.toBeNull();
      await page.goto(origin);
      if (offerer === "linux") {
        const offer = await startNative(app, id);
        expect(offer).not.toMatch(/^error/);
        const answer = await startBrowser(page, throughTheSignal(offer, "o"));
        const accepted = await app.executeAsync<string | null>(`
          const [id, answer] = arguments; const done = arguments[arguments.length - 1];
          window.__TAURI_INTERNALS__.invoke("native_call_accept", { id, answer }).then(() => done(null), (e) => done(String(e)));`,
        id, throughTheSignal(answer, "a"));
        expect(accepted).toBeNull();
      } else {
        const offer = await startBrowser(page);
        const answer = await startNative(app, id, throughTheSignal(offer, "o"));
        expect(answer).not.toMatch(/^error/);
        await page.evaluate((sdp) => (window as unknown as { pc: RTCPeerConnection }).pc.setRemoteDescription({ type: "answer", sdp }),
          throughTheSignal(answer, "a"));
      }

      await expect.poll(async () => {
        const s = await nativeStats(app, id);
        return s.audioReceived > 50 && s.videoReceived > 10 && s.pictures > 5;
      }, { timeout: 60_000, message: "the Linux Desktop hears and sees Chromium" }).toBe(true);
      await expect.poll(async () => {
        const s = await browserStats(page);
        return s.audio > 50 && s.video > 10;
      }, { timeout: 60_000, message: "Chromium hears and sees the Linux Desktop" }).toBe(true);
      test.info().annotations.push({ type: "received", description: JSON.stringify({ linux: await nativeStats(app, id), chromium: await browserStats(page) }) });
    } finally {
      await app.executeAsync(`
        const done = arguments[arguments.length - 1];
        window.__TAURI_INTERNALS__.invoke("native_call_close", { id: arguments[0] }).then(done, done);`, id).catch(() => {});
      await page.close();
      await stop();
      home.remove();
    }
  });
}
