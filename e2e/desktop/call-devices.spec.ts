import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { attachDesktopLogs, desktopHome } from "../support/desktop";
import { LocalRelay } from "../support/relay";
import { desktopNetwork } from "../matrix/desktop";
import { desktopPerson, type DesktopPerson } from "../matrix/people";

/**
 * The Linux Desktop's calls use the microphone, camera and speaker chosen in Settings, and switch them live.
 *
 * Its calls capture and play in GStreamer (apps/desktop/src/native_call), which knows devices by name, not by the
 * WebView's deviceId: Rust lists them (`native_call_devices`) and the page passes the chosen one's name. Here the
 * devices are PulseAudio's: null sources for microphones and null sinks for speakers, named, which GStreamer's
 * device monitor lists as it would a headset. The cameras are the test pictures GHOSTLY_FAKE_MEDIA names ("Test
 * camera", "Test bars"): a container has no V4L2 device. Which device each call uses is read back from Rust
 * (`native_call_stats`) and from PulseAudio itself (who records from which source, who plays on which sink).
 * Settings tries them where the calls run: Rust meters the microphone and plays a tone on the speaker.
 *
 * Skipped where PulseAudio is not installed.
 */

interface Stats {
  audioSent: number;
  audioReceived: number;
  videoReceived: number;
  microphone: string | null;
  speaker: string | null;
  camera: string | null;
}

const MICS = { a: "Ghostly mic A", b: "Ghostly mic B" };
const SPEAKERS = { a: "Ghostly speaker A", b: "Ghostly speaker B" };

/** Where this test's PulseAudio listens (`pulseAudio`): `unix:<socket>`. */
let server = "";

/** PulseAudio's client, on the server this test uses. */
const pactl = (...args: string[]) => execFileSync("pactl", ["-s", server, ...args], { encoding: "utf8" });

/** Loads a module, and returns its index for unloading. */
const load = (module: string, ...args: string[]) => pactl("load-module", module, ...args).trim();

/** A named null source (a microphone) or null sink (a speaker). */
const mic = (name: string, description: string) => load("module-null-source", `source_name=${name}`, `description='${description}'`);
const speaker = (name: string, description: string) => load("module-null-sink", `sink_name=${name}`, `sink_properties='device.description="${description}"'`);

/** The names of the sources something records from, and of the sinks something plays on. */
function inUse(): { sources: string[]; sinks: string[] } {
  const names = (list: string) => new Map(pactl("list", "short", list).trim().split("\n").filter(Boolean).map((l) => l.split("\t")).map(([index, name]) => [index, name]));
  const used = (list: string, of: Map<string, string>) => pactl("list", "short", list).trim().split("\n").filter(Boolean).map((l) => of.get(l.split("\t")[1]) ?? "?");
  return { sources: used("source-outputs", names("sources")), sinks: used("sink-inputs", names("sinks")) };
}

/**
 * A PulseAudio of this test's own, always: its folder and socket, no module but the socket (`-n`), so no hardware,
 * ended by `stop`. Never the machine's running server: this test sets the default microphone and speaker, which on a
 * desktop would be the person's own, and a PipeWire server's PulseAudio face has no null source. Null without PulseAudio.
 */
async function pulseAudio(): Promise<{ server: string; stop: () => void } | null> {
  if (spawnSync("pulseaudio", ["--version"]).status !== 0) return null;
  const dir = mkdtempSync(join(tmpdir(), "ghostly-pulse-"));
  const socket = join(dir, "native");
  const address = `unix:${socket}`;
  const daemon = spawn("pulseaudio", [
    "-n", "--daemonize=no", "--exit-idle-time=-1", "--use-pid-file=no", "--realtime=no", "--high-priority=no", "--log-target=stderr",
    "-L", `module-native-protocol-unix socket=${socket} auth-anonymous=1`,
  ], { env: { PATH: process.env.PATH, HOME: dir, XDG_RUNTIME_DIR: dir, XDG_CONFIG_HOME: dir }, stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  daemon.stderr!.on("data", (chunk: Buffer) => (log += chunk.toString()));
  const up = () => spawnSync("pactl", ["-s", address, "info"]).status === 0;
  for (let i = 0; i < 100 && !up() && daemon.exitCode === null; i++) await new Promise((done) => setTimeout(done, 100));
  const stop = () => { daemon.kill("SIGTERM"); rmSync(dir, { recursive: true, force: true }); };
  if (!up()) { stop(); throw new Error(`PulseAudio did not start: ${log}`); }
  return { server: address, stop };
}

const stats = (p: DesktopPerson) => p.app.executeAsync<Stats | null>(`
  const done = arguments[arguments.length - 1];
  window.__TAURI_INTERNALS__.invoke("native_call_stats", {}).then(done, (error) => done({ error: String(error) }));`);

const connected = (p: DesktopPerson) => p.app.execute<boolean>(`
  return /\\d{1,2}:\\d{2}/.test(document.querySelector('[data-testid="call-window"]')?.innerText ?? "");`);

/** The labels of a select's options, opening it and closing it again. */
const optionsOf = (p: DesktopPerson, testId: string) => p.app.executeAsync<string[]>(`
  const [testId, done] = arguments;
  const select = document.querySelector('[data-testid="' + testId + '"]');
  if (!select) return done([]);
  select.click();
  setTimeout(() => {
    const list = document.getElementById(select.getAttribute("aria-controls") ?? "");
    const labels = [...(list?.querySelectorAll('[role="option"]') ?? [])].map((o) => o.getAttribute("data-value"));
    select.click();
    done(labels);
  }, 300);`, testId);

/** Chooses an option of a select, as a person does: opens it and clicks the option. */
const choose = (p: DesktopPerson, testId: string, value: string) => expect(async () => {
  const chosen = await p.app.executeAsync<string | null>(`
    const [testId, value, done] = arguments;
    const select = document.querySelector('[data-testid="' + testId + '"]');
    if (select.getAttribute("aria-expanded") !== "true") select.click();
    setTimeout(() => {
      const list = document.getElementById(select.getAttribute("aria-controls") ?? "");
      [...(list?.querySelectorAll('[role="option"]') ?? [])].find((o) => o.getAttribute("data-value") === value)?.click();
      setTimeout(() => done(select.getAttribute("data-value")), 200);
    }, 300);`, testId, value);
  expect(chosen).toBe(value);
}).toPass({ timeout: 30_000 });

/** Picks a device from the call's device menu. */
const pick = (p: DesktopPerson, kind: MediaDeviceKind, id: string) => expect(async () => {
  const picked = await p.app.executeAsync<boolean>(`
    const [kind, id, done] = arguments;
    if (!document.querySelector('[data-testid="call-devices-menu"]')) document.querySelector('[data-testid="call-devices"]').click();
    setTimeout(() => {
      const item = [...document.querySelectorAll('[data-testid="call-device-' + kind + '"]')].find((i) => i.getAttribute("data-device-id") === id);
      item?.click();
      done(!!item);
    }, 300);`, kind, id);
  expect(picked).toBe(true);
}).toPass({ timeout: 30_000 });

/** Clicks the element with this test id. */
const click = (p: DesktopPerson, testId: string) => p.app.execute(`document.querySelector('[data-testid="' + arguments[0] + '"]').click();`, testId);

/** What Settings' microphone meter shows, 0 to 100 (-1: no meter). */
const level = (p: DesktopPerson) => p.app.execute<number>(`
  return Number(document.querySelector('[data-testid="settings-microphone-level"]')?.getAttribute("aria-valuenow") ?? -1);`);

const notice = (p: DesktopPerson) => p.app.execute<{ type: string | null; text: string } | null>(`
  const bar = document.querySelector('[data-testid="call-device-notice"]');
  return bar ? { type: bar.getAttribute("data-type"), text: bar.innerText } : null;`);

test("a Linux Desktop call uses the devices chosen in Settings, and switches them from the call's menu", {
  tag: ["@feature:calls.devices-linux", "@feature:settings.media", "@feature:calls.devices"],
}, async () => {
  test.setTimeout(10 * 60_000);
  const pulse = await pulseAudio();
  test.skip(!pulse, "PulseAudio is not installed");
  server = pulse!.server;
  const cleanup: (() => Promise<void> | void)[] = [() => pulse!.stop()];
  try {
    // A room microphone and speaker as the defaults, so the chosen ones are only ever used by the calls.
    mic("ghostly_room_mic", "Room microphone");
    speaker("ghostly_room", "Room speaker");
    speaker("ghostly_speaker_a", SPEAKERS.a);
    speaker("ghostly_speaker_b", SPEAKERS.b);
    mic("ghostly_mic_b", MICS.b);
    let micA = mic("ghostly_mic_a", MICS.a);
    pactl("set-default-source", "ghostly_room_mic");
    pactl("set-default-sink", "ghostly_room");

    const relay = new LocalRelay();
    const network = await desktopNetwork(relay);
    cleanup.push(() => relay.close(), () => network.close());
    const env = { ...network.env, PULSE_SERVER: server };
    const open = async (name: string): Promise<DesktopPerson> => {
      const home = desktopHome(name);
      const person = await desktopPerson(name, { home: home.dir, env });
      cleanup.push(async () => {
        const seen = await stats(person).catch((error) => String(error));
        test.info().annotations.push({ type: `${name} at the end`, description: JSON.stringify(seen) });
        await person.stop();
        attachDesktopLogs(name, home.dir);
        home.remove();
      });
      return person;
    };
    const a = await open("ana");
    const b = await open("bia");

    // Settings lists GStreamer's devices by name: the PulseAudio ones, and the test cameras.
    await a.go("#/settings");
    await expect.poll(() => optionsOf(a, "settings-microphone"), { timeout: 30_000, message: "the microphones are PulseAudio's" })
      .toEqual(expect.arrayContaining(["", MICS.a, MICS.b, "Room microphone"]));
    expect(await optionsOf(a, "settings-microphone")).not.toContain("Monitor of Room speaker");
    expect(await optionsOf(a, "settings-camera")).toEqual(expect.arrayContaining(["Test camera", "Test bars"]));
    expect(await optionsOf(a, "settings-speaker")).toEqual(expect.arrayContaining([SPEAKERS.a, SPEAKERS.b]));
    // The page cannot hear GStreamer's microphone or play on its speaker: Rust meters the one and plays a tone on
    // the other. The default microphone is the test tone (GHOSTLY_FAKE_MEDIA), which the meter hears.
    await click(a, "settings-microphone-test");
    await expect.poll(() => level(a), { timeout: 30_000, message: "the meter hears the default microphone" }).toBeGreaterThan(30);
    await click(a, "settings-microphone-test");
    await choose(a, "settings-microphone", MICS.b);
    await click(a, "settings-microphone-test");
    await expect.poll(() => inUse().sources, { timeout: 30_000, message: "the meter records from mic B" }).toEqual(["ghostly_mic_b"]);
    // A null source is silence.
    expect(await level(a)).toBe(0);
    await click(a, "settings-microphone-test");
    await expect.poll(() => inUse().sources, { message: "and lets it go on Stop" }).toEqual([]);
    await choose(a, "settings-speaker", SPEAKERS.b);
    await click(a, "settings-speaker-test");
    await expect.poll(() => inUse().sinks, { timeout: 10_000, intervals: [50], message: "the tone plays on speaker B" }).toContain("ghostly_speaker_b");
    await expect.poll(() => inUse().sinks, { message: "and ends" }).not.toContain("ghostly_speaker_b");
    expect(await a.app.execute<number>(`return document.querySelectorAll('[role="alert"]').length;`)).toBe(0);
    await choose(a, "settings-camera", "Test bars");
    await a.press("Preview");
    await expect.poll(() => a.app.execute<number>(`return document.querySelector('[data-testid="settings-camera-video"]')?.videoWidth ?? 0;`), {
      timeout: 30_000, message: "the camera's preview shows the chosen camera",
    }).toBeGreaterThan(0);
    await a.press("Stop");
    await a.go("#/");

    await a.press("New chat");
    await b.join(await a.copyInvite());
    for (const p of [a, b]) {
      await expect.poll(() => p.canWrite(), { timeout: 120_000, message: `${p.name}'s chat is open` }).toBe(true);
      await expect.poll(() => p.connection(), { timeout: 180_000, message: `${p.name} goes live on a native transport` })
        .toMatch(/Connected · (Iroh|HyperDHT)/);
    }

    await a.press("Video call");
    await b.press("Accept video call");
    for (const p of [a, b]) await expect.poll(() => connected(p), { timeout: 60_000, message: `${p.name}'s call connects` }).toBe(true);

    // Ana's call started on her choices: Rust says so, and PulseAudio shows it recording and playing there.
    await expect.poll(async () => {
      const s = await stats(a);
      return s && { microphone: s.microphone, speaker: s.speaker, camera: s.camera };
    }, { timeout: 60_000, message: "ana's call uses her devices" }).toEqual({ microphone: MICS.b, speaker: SPEAKERS.b, camera: "Test bars" });
    await expect.poll(() => inUse(), { message: "PulseAudio records mic B and plays on speaker B" })
      .toEqual({ sources: ["ghostly_mic_b"], sinks: expect.arrayContaining(["ghostly_speaker_b"]) });

    /** Bia goes on hearing and seeing ana. */
    const flowing = async (what: string) => {
      const before = (await stats(b))!;
      await expect.poll(async () => {
        const now = (await stats(b))!;
        return now.audioReceived - before.audioReceived > 20 && now.videoReceived - before.videoReceived > 5;
      }, { timeout: 30_000, message: `bia still hears and sees ana ${what}` }).toBe(true);
    };
    await flowing("at the start");

    // Switched from the call's menu: another microphone, speaker and camera, each live, the call going on.
    await pick(a, "audioinput", MICS.a);
    await expect.poll(async () => (await stats(a))?.microphone, { message: "ana sends mic A" }).toBe(MICS.a);
    await expect.poll(() => inUse().sources, { message: "PulseAudio records mic A, and no longer mic B" }).toEqual(["ghostly_mic_a"]);
    await pick(a, "audiooutput", SPEAKERS.a);
    await expect.poll(async () => (await stats(a))?.speaker, { message: "ana plays on speaker A" }).toBe(SPEAKERS.a);
    await expect.poll(() => inUse().sinks.filter((s) => s.startsWith("ghostly_speaker")), { message: "PulseAudio plays on speaker A only" }).toEqual(["ghostly_speaker_a"]);
    await pick(a, "videoinput", "Test camera");
    await expect.poll(async () => (await stats(a))?.camera, { message: "ana shows the other camera" }).toBe("Test camera");
    await flowing("after the switches");
    // The choices made in the call are hers from now on.
    expect(await a.app.execute<string>(`return Object.keys(localStorage).filter((k) => k.endsWith("media_devices")).map((k) => localStorage.getItem(k)).join();`))
      .toContain(MICS.a);

    // Mic A is unplugged: the call goes on with the default, says so, and offers mic A back when it returns.
    pactl("unload-module", micA);
    await expect.poll(() => notice(a), { timeout: 30_000, message: "ana is told mic A went" })
      .toEqual({ type: "lost", text: expect.stringContaining(MICS.a) });
    await expect.poll(async () => (await stats(a))?.microphone, { message: "ana sends the default microphone" }).toBeNull();
    await flowing("on the default microphone");
    micA = mic("ghostly_mic_a", MICS.a);
    await expect.poll(async () => (await notice(a))?.type, { timeout: 30_000, message: "ana is offered mic A back" }).toBe("back");
    await a.app.execute(`document.querySelector('[data-testid="call-device-switch-back"]').click();`);
    await expect.poll(async () => (await stats(a))?.microphone, { message: "ana sends mic A again" }).toBe(MICS.a);
    await expect.poll(() => inUse().sources, { message: "PulseAudio records mic A again" }).toEqual(["ghostly_mic_a"]);

    await b.press("End call");
    for (const p of [a, b]) await expect.poll(() => stats(p), { timeout: 60_000, message: `${p.name}'s media stopped` }).toBeNull();
    await expect.poll(() => inUse().sources, { message: "nothing records any more" }).toEqual([]);
  } finally {
    for (const done of cleanup.reverse()) await done();
  }
});
