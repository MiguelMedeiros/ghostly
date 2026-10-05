import { writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { expect, test } from "@playwright/test";
import { desktopPerson, type DesktopPerson } from "../matrix/people";
import { HYPERDHT_TESTNET } from "../matrix/desktop";
import { forgetSharedData, openMacDesktop, type MacDesktop } from "../support/desktopMac";
import { HeadlessBot } from "../support/headless";
import { LocalRelay } from "../support/relay";

/**
 * The Desktop app on a Mac (the system WKWebView, WebKit's WebRTC) and a bot on the headless Ghostly (packages/cli,
 * WISP 1100 § Calls: libdatachannel and Opus in WebAssembly) call each other. The app calls, the bot answers by
 * itself; then the bot calls, and the app answers. The bot's "program" is this test, on the call's audio socket (raw
 * s16le mono PCM): it hears the app's microphone (a 440 Hz tone) and writes a 660 Hz tone the app must receive.
 *
 * The app's microphone is an oscillator (support as in calls-services.spec.ts: WKWebView has no fake devices), put on
 * `MediaDevices.prototype`. Whether WebKit plays a remote track into Web Audio is not what this checks: the app side
 * asserts the bot's audio arriving in its connection's stats, and reports the frequency it measures.
 */

// 49720-49729: this test's ports.
const PORTS = { relay: 49721, dht: 49722, a: 49725 };
const APP_HZ = 440;
const BOT_HZ = 660;

/** The app's microphone is a tone; each peer connection is kept, and the contact's audio is measurable. Idempotent. */
const TONE_MEDIA = `
  if (window.__e2eTone) return;
  window.__e2eTone = true;
  window.__e2ePeers = [];
  window.__e2eLog = [];
  window.__e2eRemote = null;
  const context = new AudioContext();
  window.__e2eContext = context;
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Native {
    constructor(...args) {
      super(...args);
      window.__e2ePeers.push(this);
      this.addEventListener("track", (event) => { if (event.track.kind === "audio") window.__e2eRemote = new MediaStream([event.track]); });
    }
  };
  MediaDevices.prototype.getUserMedia = async (constraints = {}) => {
    void context.resume();
    const tone = context.createOscillator();
    tone.frequency.value = ${APP_HZ};
    const gain = context.createGain();
    gain.gain.value = 0.3;
    const out = context.createMediaStreamDestination();
    tone.connect(gain).connect(out);
    tone.start();
    window.__e2eLog.push("getUserMedia " + JSON.stringify(constraints) + " context " + context.state);
    return new MediaStream(out.stream.getAudioTracks());
  };
`;

/** Audio bytes the app's live peer connections receive and send. */
const AUDIO = `
  const done = arguments[arguments.length - 1];
  Promise.all((window.__e2ePeers ?? []).filter((pc) => pc.connectionState !== "closed").map(async (pc) => {
    let got = 0, sent = 0;
    (await pc.getStats()).forEach((s) => {
      if (s.type === "inbound-rtp" && s.kind === "audio") got += s.bytesReceived ?? 0;
      if (s.type === "outbound-rtp" && s.kind === "audio") sent += s.bytesSent ?? 0;
    });
    return { got, sent };
  })).then((all) => done(all.reduce((sum, x) => ({ got: sum.got + x.got, sent: sum.sent + x.sent }), { got: 0, sent: 0 })));
`;

/** The loudest frequency in the contact's audio, as Web Audio hears it here (0 when silent or not playing). */
const HEARD_HZ = `
  const done = arguments[arguments.length - 1];
  const context = window.__e2eContext;
  if (!window.__e2eRemote || !context) { done(0); return; }
  void context.resume();
  const analyser = context.createAnalyser();
  analyser.fftSize = 8192;
  context.createMediaStreamSource(window.__e2eRemote).connect(analyser);
  setTimeout(() => {
    const bins = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(bins);
    let best = 1;
    for (let i = 1; i < bins.length; i++) if (bins[i] > bins[best]) best = i;
    done(bins[best] > -80 ? best * context.sampleRate / analyser.fftSize : 0);
  }, 1200);
`;

type Audio = { got: number; sent: number };

function dominantHz(pcm: Buffer, rate: number): number {
  const n = Math.floor(pcm.length / 2);
  let best = 0, bestHz = 0;
  for (let hz = 100; hz <= 2000; hz += 5) {
    let re = 0, im = 0;
    const step = (2 * Math.PI * hz) / rate;
    for (let i = 0; i < n; i++) { const x = pcm.readInt16LE(i * 2); re += x * Math.cos(step * i); im -= x * Math.sin(step * i); }
    if (re * re + im * im > best) { best = re * re + im * im; bestHz = hz; }
  }
  return bestHz;
}

function tone(hz: number, rate: number, ms: number): Buffer {
  const n = Math.round((rate * ms) / 1000);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * hz * i) / rate)), i * 2);
  return out;
}

async function program(path: string): Promise<{ socket: Socket; heard: () => Buffer; ended: Promise<void> }> {
  const socket = connect(path);
  const chunks: Buffer[] = [];
  socket.on("data", (d: Buffer) => chunks.push(d));
  const ended = new Promise<void>((resolve) => socket.on("end", () => resolve()));
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  return { socket, heard: () => Buffer.concat(chunks), ended };
}

test("the Desktop app on a Mac and a headless bot call each other, with audio both ways", {
  tag: ["@client:desktop", "@feature:headless.calls", "@feature:calls.audio", "@feature:calls.paired"],
}, async ({}, testInfo) => {
  test.skip(process.platform !== "darwin", "macOS only: the system WKWebView");
  const relay = new LocalRelay();
  const { default: testnet } = (await import(HYPERDHT_TESTNET)) as { default: (size: number, opts?: { port?: number }) => Promise<{ bootstrap: { host: string; port: number }[]; destroy(): Promise<void> }> };
  const dht = await testnet(3, { port: PORTS.dht });
  const relayUrl = await relay.listen(PORTS.relay);
  const bootstrap = dht.bootstrap.map((node) => `${node.host}:${node.port}`).join(",");
  const env = { GHOSTLY_PKARR_RELAYS: relayUrl, GHOSTLY_HYPERDHT_BOOTSTRAP: bootstrap };
  // The bot's processes inherit this: the same HyperDHT network as the app.
  process.env.GHOSTLY_HYPERDHT_BOOTSTRAP = bootstrap;
  const bot = new HeadlessBot();
  const apps: MacDesktop[] = [];
  let alice: DesktopPerson | undefined;
  const keep = async (name: string, body: string) => {
    writeFileSync(testInfo.outputPath(name), body);
    await testInfo.attach(name, { path: testInfo.outputPath(name), contentType: "text/plain" });
  };
  forgetSharedData();
  try {
    await bot.start(relayUrl, "Voice bot");
    await bot.run("call", "auto", "on");
    alice = await desktopPerson("a", {
      env,
      open: async () => {
        const desktop = await openMacDesktop({ name: "a", port: PORTS.a, env });
        apps.push(desktop);
        return { app: desktop.app, stop: () => desktop.stop() };
      },
    });
    const app = alice;
    let chat = "";

    await test.step("pair: the bot's invite, joined by the app, goes live", async () => {
      const invite = await bot.run("invite", "create", "--label", "mac");
      chat = invite.chat as string;
      await app.join(invite.link as string);
      await expect.poll(() => app.canWrite(), { timeout: 120_000 }).toBe(true);
      await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
      await expect.poll(() => app.callButton(), { timeout: 120_000, message: "the app may call the bot" }).toMatchObject({ disabled: false, title: "Audio call" });
      testInfo.annotations.push({ type: "transport", description: await app.connection() });
    });

    await test.step("the app calls, the bot answers by itself: each hears the other's tone", async () => {
      await app.app.execute(TONE_MEDIA);
      await app.app.click('[data-testid="call-audio"]');
      const connected = await bot.event((e) => e.type === "call.connected", 90_000);
      const audio = connected.audio as { socket: string; rate: number };
      const bot1 = await program(audio.socket);
      bot1.socket.write(tone(BOT_HZ, audio.rate, 8000));
      await expect.poll(() => bot1.heard().length, { timeout: 30_000, message: "the bot hears the app" }).toBeGreaterThan(1920 * 100);
      const botHeard = dominantHz(bot1.heard().subarray(-1920 * 50), audio.rate);
      testInfo.annotations.push({ type: "the bot hears (Hz)", description: String(botHeard) });
      expect(botHeard).toBeGreaterThan(APP_HZ - 15);
      expect(botHeard).toBeLessThan(APP_HZ + 15);
      const received = () => app.app.executeAsync<Audio>(AUDIO);
      const first = await received();
      await expect.poll(async () => (await received()).got, { timeout: 30_000, message: "the app keeps receiving the bot's audio" }).toBeGreaterThan(first.got + 5000);
      testInfo.annotations.push({ type: "the app hears (Hz, Web Audio)", description: String(await app.app.executeAsync<number>(HEARD_HZ)) });
      testInfo.annotations.push({ type: "app audio bytes", description: JSON.stringify(await received()) });

      await app.press("End call");
      await bot1.ended;
      expect(await bot.event((e) => e.type === "call.ended")).toMatchObject({ reason: "remote-hangup" });
    });

    await test.step("the bot calls, the app answers, the bot hangs up", async () => {
      await bot.run("call", "auto", "off");
      await expect.poll(() => app.callButton(), { timeout: 30_000 }).toMatchObject({ disabled: false });
      const placed = await bot.run("call", "start", chat, "--rate", "16000");
      await expect.poll(() => app.snapshot(), { timeout: 60_000 }).toContain("Incoming audio call");
      await app.app.click('[title="Accept audio call"]');
      await bot.event((e) => e.type === "call.connected" && e.call === placed.call, 60_000);
      const bot2 = await program((placed.audio as { socket: string }).socket);
      bot2.socket.write(tone(BOT_HZ, 16000, 6000));
      await expect.poll(() => bot2.heard().length, { timeout: 30_000 }).toBeGreaterThan(640 * 100);
      const botHeard = dominantHz(bot2.heard().subarray(-640 * 50), 16000);
      expect(botHeard).toBeGreaterThan(APP_HZ - 15);
      expect(botHeard).toBeLessThan(APP_HZ + 15);
      await bot.run("call", "hangup");
      await bot2.ended;
      await expect.poll(() => app.app.text('[title="End call"]'), { timeout: 30_000 }).toBeNull();
      await expect.poll(() => app.snapshot(), { timeout: 30_000 }).toContain("Audio call ended");
    });
  } catch (error) {
    if (alice) {
      const log = await alice.app.execute<string[] | null>(`return window.__e2eLog ?? null;`).catch(() => null);
      const sdp = await alice.app.execute<string[] | null>(`return (window.__e2ePeers ?? []).map((pc) => pc.connectionState + "\\n" + (pc.localDescription?.sdp ?? "") + "\\n---remote---\\n" + (pc.remoteDescription?.sdp ?? ""));`).catch(() => null);
      if (sdp?.length) await keep("app-call-sdp.txt", sdp.join("\n\n======\n\n"));
      await keep("app-page.txt", `${await alice.snapshot().catch((e: unknown) => String(e))}\n\n--- console ---\n${(log ?? []).join("\n")}`);
    }
    await keep("bot-events.txt", bot.events.map((e) => JSON.stringify(e)).join("\n"));
    for (const d of apps) await keep(`${d.bundleId}-log.txt`, d.log.join(""));
    throw error;
  } finally {
    await Promise.all(apps.map((d) => d.stop()));
    await bot.stop();
    forgetSharedData();
    relay.close();
    await dht.destroy();
  }
});
