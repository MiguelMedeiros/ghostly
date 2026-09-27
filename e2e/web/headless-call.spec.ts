import { connect, type Socket } from "node:net";
import type { Page } from "@playwright/test";
import { pasteInvite } from "../support/clipboard";
import { chat, expect, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * A person on the web app calls a bot on the headless Ghostly (packages/cli, WISP 11xx § Calls), and the bot calls
 * back: calls/1 signals on the chat session, Chromium's WebRTC against libdatachannel, Opus both ways. The bot's
 * "program" is this test, on the call's audio socket (raw s16le mono PCM): it must hear the tone the page plays into
 * the call, and the page must hear the tone the program writes.
 */
test.describe.configure({ timeout: 4 * 60_000 });

const PAGE_HZ = 440;
const BOT_HZ = 660;
const RATE = 48000;

/** The page's microphone is a tone, and the contact's audio is kept where the test can measure it. */
async function tapCallAudio(page: Page, hz: number): Promise<void> {
  await page.evaluate((hz) => {
    const w = window as unknown as { __ctx: AudioContext; __remote: MediaStream | null };
    w.__ctx = new AudioContext();
    w.__remote = null;
    // On the prototype: an instance override was sometimes bypassed (#230).
    MediaDevices.prototype.getUserMedia = async function () {
      await w.__ctx.resume();
      const osc = w.__ctx.createOscillator();
      osc.frequency.value = hz;
      const gain = w.__ctx.createGain();
      gain.gain.value = 0.3;
      const out = w.__ctx.createMediaStreamDestination();
      osc.connect(gain).connect(out);
      osc.start();
      return out.stream;
    };
    const Native = window.RTCPeerConnection;
    const Tapped = function (this: unknown, config?: RTCConfiguration) {
      const pc = new Native(config);
      pc.addEventListener("track", (event) => { if (event.track.kind === "audio") w.__remote = new MediaStream([event.track]); });
      return pc;
    } as unknown as typeof RTCPeerConnection;
    Tapped.prototype = Native.prototype;
    window.RTCPeerConnection = Tapped;
  }, hz);
}

/** The loudest frequency the page hears from the contact, over about a second. */
async function pageHears(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const w = window as unknown as { __ctx: AudioContext; __remote: MediaStream | null };
    if (!w.__remote) return 0;
    const analyser = w.__ctx.createAnalyser();
    analyser.fftSize = 8192;
    w.__ctx.createMediaStreamSource(w.__remote).connect(analyser);
    await new Promise((r) => setTimeout(r, 1200));
    const bins = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(bins);
    const hz = (i: number) => (i * w.__ctx.sampleRate) / analyser.fftSize;
    let best = -1;
    for (let i = 1; i < bins.length; i++) if (hz(i) >= 100 && hz(i) <= 2000 && (best < 0 || bins[i] > bins[best])) best = i;
    return bins[best] > -80 ? hz(best) : 0;
  });
}

/** The loudest frequency in s16le mono PCM (a DFT scan in 5 Hz steps). */
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

/** The bot's program: connected to the call's audio socket, keeping what it hears. */
async function program(path: string): Promise<{ socket: Socket; heard: () => Buffer; ended: Promise<void> }> {
  const socket = connect(path);
  const chunks: Buffer[] = [];
  socket.on("data", (d: Buffer) => chunks.push(d));
  const ended = new Promise<void>((resolve) => socket.on("end", () => resolve()));
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  return { socket, heard: () => Buffer.concat(chunks), ended };
}

test("a person on the web calls a headless bot, and the bot calls back: audio both ways", { tag: ["@feature:headless.calls", "@feature:headless.web-interop", "@feature:calls.paired", "@feature:calls.audio"] }, async ({ peer, relay }, testInfo) => {
  const url = await relay.listen();
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Voice bot");
    await bot.run("call", "auto", "on");
    const person = await peer("caller");

    const invite = await bot.run("invite", "create", "--label", "person");
    await person.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(person.page, invite.invite as string);
    await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
    // The bot's app offers calls/1: the person's call button is on.
    await expect(person.page.getByTestId("call-audio")).toBeEnabled({ timeout: 90_000 });
    await tapCallAudio(person.page, PAGE_HZ);

    // The person calls; the bot answers by itself.
    await person.page.getByTestId("call-audio").click();
    expect(await bot.event((e) => e.type === "call.incoming")).toMatchObject({ chat: invite.chat, video: false, auto: true });
    const connected = await bot.event((e) => e.type === "call.connected");
    const audio = connected.audio as { socket: string; rate: number; channels: number; format: string; frameMs: number };
    expect(audio).toMatchObject({ rate: RATE, channels: 1, format: "s16le", frameMs: 20 });
    await expect(person.page.getByText(/^\d{1,2}:\d{2}$/).first()).toBeVisible();

    const bot1 = await program(audio.socket);
    bot1.socket.write(tone(BOT_HZ, RATE, 6000));
    // The program hears the page's tone...
    await expect.poll(() => bot1.heard().length, { timeout: 20_000 }).toBeGreaterThan(1920 * 100);
    expect(dominantHz(bot1.heard().subarray(-1920 * 50), RATE)).toBeCloseTo(PAGE_HZ, -1);
    // ...and the page hears the program's.
    await expect.poll(() => pageHears(person.page), { timeout: 20_000 }).toBeGreaterThan(BOT_HZ - 15);
    expect(await pageHears(person.page)).toBeLessThan(BOT_HZ + 15);
    await person.page.screenshot({ path: testInfo.outputPath("in-call.png") });

    // The person hangs up: the bot's program reads EOF, and the stream says why.
    await person.page.getByTitle("End call").click();
    await bot1.ended;
    expect(await bot.event((e) => e.type === "call.ended")).toMatchObject({ chat: invite.chat, reason: "remote-hangup", duration: expect.any(Number) });

    // The bot calls the person back, and hangs up itself.
    await bot.run("call", "auto", "off");
    await expect(person.page.getByTestId("call-audio")).toBeEnabled();
    const placed = await bot.run("call", "start", invite.chat as string, "--rate", "16000");
    expect(placed).toMatchObject({ direction: "out", state: "ringing", audio: { rate: 16000 } });
    await expect(person.page.getByText("Incoming audio call...")).toBeVisible();
    await person.page.getByTitle("Accept audio call").click();
    await bot.event((e) => e.type === "call.connected" && e.call === placed.call);
    const bot2 = await program((placed.audio as { socket: string }).socket);
    bot2.socket.write(tone(BOT_HZ, 16000, 6000));
    await expect.poll(() => bot2.heard().length, { timeout: 20_000 }).toBeGreaterThan(640 * 100);
    expect(dominantHz(bot2.heard().subarray(-640 * 50), 16000)).toBeCloseTo(PAGE_HZ, -1);
    await expect.poll(() => pageHears(person.page), { timeout: 20_000 }).toBeGreaterThan(BOT_HZ - 15);

    await bot.run("call", "hangup");
    await bot2.ended;
    await expect(person.page.getByTitle("End call")).toHaveCount(0);
    // One line per call, in the person's chat.
    await expect(chat(person).getByText("Audio call ended")).toHaveCount(2);
    expect(await bot.event((e) => e.type === "call.ended" && e.call === placed.call)).toMatchObject({ reason: "hangup" });
  } finally {
    await bot.stop();
  }
});
