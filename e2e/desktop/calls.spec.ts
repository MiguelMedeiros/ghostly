import { test, expect } from "@playwright/test";
import { attachDesktopLogs, desktopHome } from "../support/desktop";
import { LocalRelay } from "../support/relay";
import { desktopNetwork } from "../matrix/desktop";
import { desktopPerson, type DesktopPerson } from "../matrix/people";

/**
 * Two Linux Desktops call each other, through the call window as a person uses it.
 *
 * WebKitGTK has no WebRTC (Ubuntu, Debian and Fedora build it without), so the call media runs in Rust:
 * webrtc-rs for the connection, GStreamer for the camera, the microphone and the codecs
 * (apps/desktop/src/native_call). The page drives it through apps/ui/src/desktop/nativeCalls.ts, which has the
 * RTCPeerConnection shape the call hook expects. Here both apps use it, with a test picture and a test tone
 * (GHOSTLY_FAKE_MEDIA, set by support/desktop.ts), and what they exchange is read back from Rust
 * (`native_call_stats`) and from the call window's own <video>.
 *
 * The pair first goes live on Iroh or HyperDHT, as in native-upgrade.spec.ts: calls ride a live session.
 * Interop with a browser's WebRTC is calls-interop.spec.ts.
 */

interface Stats {
  audioSent: number;
  videoSent: number;
  audioReceived: number;
  videoReceived: number;
  ice: string;
  muted: boolean;
}

/** What Rust says about the call in progress, or null when there is none. */
const stats = (p: DesktopPerson) => p.app.executeAsync<Stats | null>(`
  const done = arguments[arguments.length - 1];
  window.__TAURI_INTERNALS__.invoke("native_call_stats", {}).then(done, (error) => done({ error: String(error) }));`);

/** The call window's picture of the other side: its size, how far it has played, and whether it shows. */
const picture = (p: DesktopPerson) => p.app.execute<{ width: number; time: number; shown: boolean } | null>(`
  const video = document.querySelector('[data-testid="remote-video"]');
  return video ? { width: video.videoWidth, time: video.currentTime, shown: !video.classList.contains("hidden") } : null;`);

/** The call window's own camera (the self view): its size, how far it has played, and whether it is paused. */
const selfView = (p: DesktopPerson) => p.app.execute<{ width: number; time: number; paused: boolean; ready: number } | null>(`
  const video = document.querySelector('[data-testid="call-self-view"] video');
  return video ? { width: video.videoWidth, time: video.currentTime, paused: video.paused, ready: video.readyState } : null;`);

/** The self view plays: it has a picture, and its clock moves. */
async function selfViewPlays(p: DesktopPerson, when: string): Promise<void> {
  await expect.poll(async () => (await selfView(p))?.width ?? 0, { timeout: 30_000, message: `${p.name} sees their own camera ${when}` }).toBeGreaterThan(0);
  const before = (await selfView(p))!.time;
  await expect.poll(async () => (await selfView(p))!.time, { timeout: 15_000, message: `${p.name}'s own camera plays ${when}` }).toBeGreaterThan(before + 0.5);
}

const callWindows = (p: DesktopPerson) => p.app.execute<number>(`return document.querySelectorAll('[data-testid="call-window"]').length;`);

/** The call window's clock: the call is connected. No word boundary: WebKit's innerText runs the title into it. */
const connected = (p: DesktopPerson) => p.app.execute<boolean>(`
  return /\\d{1,2}:\\d{2}/.test(document.querySelector('[data-testid="call-window"]')?.innerText ?? "");`);

const button = (p: DesktopPerson, selector: string) => p.app.execute<{ disabled: boolean; title: string | null } | null>(`
  const button = document.querySelector(arguments[0]);
  return button ? { disabled: button.disabled, title: button.getAttribute("title") } : null;`, selector);

test("two Linux Desktops call each other: decline, then sound and pictures both ways, mute, camera off, hang up, a video call answered with voice", {
  tag: ["@feature:calls.linux-native", "@feature:calls.paired", "@feature:calls.video", "@feature:calls.decline"],
}, async () => {
  test.setTimeout(10 * 60_000);
  const relay = new LocalRelay();
  const network = await desktopNetwork(relay);
  const cleanup: (() => Promise<void> | void)[] = [() => relay.close(), () => network.close()];
  try {
    const open = async (name: string): Promise<DesktopPerson> => {
      const home = desktopHome(name);
      const person = await desktopPerson(name, { home: home.dir, env: network.env });
      cleanup.push(async () => {
        // What each side's call looked like at the end, for a failure's report.
        const seen = await stats(person).catch((error) => String(error));
        const window = await person.app.execute<string>(`return document.querySelector('[data-testid="call-window"]')?.innerText ?? "(no call window)";`).catch(() => "");
        test.info().annotations.push({ type: `${name} at the end`, description: `${JSON.stringify(seen)} ${window}` });
        await person.stop();
        attachDesktopLogs(name, home.dir);
        home.remove();
      });
      return person;
    };
    const a = await open("ana");
    const b = await open("bia");
    for (const p of [a, b]) {
      // The premise: no WebRTC in this WebView, and calls anyway.
      expect(await p.app.execute<boolean>(`return typeof RTCPeerConnection !== "undefined";`), `${p.name} has no WebRTC`).toBe(false);
    }

    await a.press("New Chat");
    await b.join(await a.copyInvite());
    for (const p of [a, b]) {
      await expect.poll(() => p.canWrite(), { timeout: 120_000, message: `${p.name}'s chat is open` }).toBe(true);
      p.chatHash = await p.hash();
    }
    for (const p of [a, b]) {
      await expect.poll(() => p.connection(), { timeout: 180_000, message: `${p.name} goes live on a native transport` })
        .toMatch(/Connected · (Iroh|HyperDHT)/);
    }
    // Both sides offer calls/1: the buttons are on.
    for (const p of [a, b]) {
      await expect.poll(() => button(p, '[data-testid="call-video"]'), { timeout: 60_000, message: `${p.name} can call` })
        .toEqual({ disabled: false, title: "Video call" });
    }

    // Declined: neither side is left on a call, and nothing is left running in Rust.
    await a.press("Audio call");
    await b.press("Decline");
    for (const p of [a, b]) {
      await expect.poll(() => callWindows(p), { timeout: 60_000, message: `${p.name} is off the call` }).toBe(0);
      await expect.poll(() => stats(p), { message: `${p.name}'s media stopped` }).toBeNull();
    }

    // A video call: both cameras on.
    await a.press("Video call");
    await b.press("Accept video call");
    for (const p of [a, b]) {
      await expect.poll(() => connected(p), { timeout: 60_000, message: `${p.name}'s call connects` }).toBe(true);
      await expect.poll(async () => {
        const s = await stats(p);
        return !!s && s.audioReceived > 50 && s.videoReceived > 10;
      }, { timeout: 60_000, message: `${p.name} hears and sees the other` }).toBe(true);
      // The picture reaches the call window, and moves.
      await expect.poll(async () => (await picture(p))?.width ?? 0, { timeout: 30_000, message: `${p.name}'s window shows a picture` }).toBeGreaterThan(0);
      const before = (await picture(p))!.time;
      await expect.poll(async () => (await picture(p))!.time, { message: `${p.name}'s picture plays` }).toBeGreaterThan(before);
      // And the caller's own camera, in the corner, from the start: no need to turn it off and on.
      await selfViewPlays(p, "from the start");
    }

    // Mute reaches the microphone in Rust, and back.
    await a.press("Mute");
    await expect.poll(async () => (await stats(a))?.muted, { message: "ana's microphone is muted" }).toBe(true);
    await a.press("Unmute");
    await expect.poll(async () => (await stats(a))?.muted, { message: "ana's microphone is back" }).toBe(false);

    // Camera off: ana stops sending pictures, and bia's window stops showing one.
    await a.press("Turn camera off");
    await expect.poll(async () => (await picture(b))?.shown, { timeout: 30_000, message: "bia no longer shows ana's picture" }).toBe(false);
    const sent = (await stats(a))!.videoSent;
    await new Promise((done) => setTimeout(done, 2_000));
    expect((await stats(a))!.videoSent - sent, "ana sends no pictures with the camera off").toBeLessThan(5);
    await a.press("Turn camera on");
    await expect.poll(async () => (await picture(b))?.shown, { timeout: 30_000, message: "bia shows ana's picture again" }).toBe(true);
    await selfViewPlays(a, "with the camera back on");

    // No screen to share on Linux yet: the button is there, off, and says why.
    for (const p of [a, b]) {
      expect(await button(p, '[data-testid="share-screen"]')).toEqual({ disabled: true, title: "Screen sharing is not available on Linux yet" });
    }

    // Hung up by bia: both windows close, and both sides' media stops.
    await b.press("End call");
    for (const p of [a, b]) {
      await expect.poll(() => callWindows(p), { timeout: 60_000, message: `${p.name}'s call window closes` }).toBe(0);
      await expect.poll(() => stats(p), { message: `${p.name}'s media stopped` }).toBeNull();
    }

    // A video call answered with voice only, as the Linux interop of 2026-09-29 did: bia still sees ana, and once
    // bia's camera comes on, ana sees bia, with no new offer.
    await a.press("Video call");
    await b.press("Accept audio call");
    await expect.poll(() => connected(b), { timeout: 60_000, message: "bia's call connects" }).toBe(true);
    await expect.poll(async () => (await stats(b))?.videoReceived ?? 0, { timeout: 60_000, message: "bia sees ana" }).toBeGreaterThan(10);
    await expect.poll(async () => (await picture(b))?.width ?? 0, { timeout: 30_000, message: "bia's window shows ana" }).toBeGreaterThan(0);
    await b.press("Turn camera on");
    await expect.poll(async () => (await stats(a))?.videoReceived ?? 0, { timeout: 60_000, message: "ana sees bia" }).toBeGreaterThan(10);
    await expect.poll(async () => (await picture(a))?.width ?? 0, { timeout: 30_000, message: "ana's window shows bia" }).toBeGreaterThan(0);
    await selfViewPlays(b, "once the camera is turned on in a voice answer");
    await a.press("End call");
    for (const p of [a, b]) {
      await expect.poll(() => callWindows(p), { timeout: 60_000, message: `${p.name}'s second call window closes` }).toBe(0);
    }
  } finally {
    for (const done of cleanup.reverse()) await done();
  }
});
