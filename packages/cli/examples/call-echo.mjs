#!/usr/bin/env node
// A voice bot on the daemon's socket, no dependencies: it answers every call, plays a WAV greeting, and then
// echoes what the caller says one second later. Speaking over the greeting stops it at once (barge-in: call.flush).
//
//   ghostly daemon --detach
//   node call-echo.mjs [greeting.wav]
//
// GHOSTLY_SOCKET names the daemon's socket (`ghostly daemon status` prints it; left out, the bot asks). The call's
// audio is raw PCM on a socket of its own: s16le, mono, at the call's rate, 20 ms frames from the call, any amount to
// it (WISP 11xx § Calls).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";

const RATE = 48000;
const ECHO_MS = 1000;
const greeting = process.argv[2] ? wavToPcm(readFileSync(process.argv[2]), RATE) : null;

// GHOSTLY_SOCKET, else the socket `ghostly daemon status` names: where it is depends on GHOSTLY_HOME, the profile
// (--profile or GHOSTLY_PROFILE) and the path's length, so it is asked, never guessed.
const socket = connect(process.env.GHOSTLY_SOCKET ?? JSON.parse(execFileSync("ghostly", ["daemon", "status"], { encoding: "utf8" })).socket);
let nextId = 1;
const waiting = new Map();
function call(method, params) {
  const id = nextId++;
  socket.write(JSON.stringify({ id, method, params }) + "\n");
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
}

createInterface({ input: socket }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && waiting.has(message.id)) {
    const { resolve, reject } = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`)); else resolve(message.result);
    return;
  }
  const event = message.event;
  if (event?.type === "call.incoming") {
    try {
      const answered = await call("call.answer", { call: event.call, rate: RATE });
      talk(answered.call, answered.audio.socket);
    } catch (error) {
      console.error("answer:", error.message);
    }
  }
  if (event?.type === "call.ended") console.log(`call ${event.call} ended: ${event.reason}`);
});

/** One call: the greeting, then the echo. */
function talk(id, path) {
  const audio = connect(path);
  let greetingUntil = 0;
  audio.on("connect", () => {
    console.log(`call ${id}: connected`);
    if (greeting) {
      // Written at once: the call plays it at real time and sends silence after it.
      audio.write(greeting);
      greetingUntil = Date.now() + (greeting.length / 2 / RATE) * 1000;
    }
  });
  audio.on("data", (frame) => {
    if (Date.now() < greetingUntil) {
      // The caller speaks over the greeting: stop it, and start echoing.
      if (rms(frame) > 0.05) { greetingUntil = 0; void call("call.flush", { call: id }); }
      return;
    }
    setTimeout(() => { if (!audio.destroyed) audio.write(frame); }, ECHO_MS);
  });
  audio.on("end", () => audio.destroy());
  audio.on("error", (error) => console.error(`call ${id}:`, error.message));
}

function rms(pcm) {
  let sum = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) { const v = pcm.readInt16LE(i) / 32768; sum += v * v; }
  return Math.sqrt(sum / Math.max(1, pcm.length / 2));
}

/** A 16-bit PCM WAV as the call's audio: mixed to mono, resampled (linearly) to `rate`. */
function wavToPcm(wav, rate) {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAV file");
  let offset = 12, format = null, data = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4), size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") format = { code: wav.readUInt16LE(offset + 8), channels: wav.readUInt16LE(offset + 10), rate: wav.readUInt32LE(offset + 12), bits: wav.readUInt16LE(offset + 22) };
    if (id === "data") data = wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  if (!format || !data || format.code !== 1 || format.bits !== 16) throw new Error("Only 16-bit PCM WAV files");
  const frames = Math.floor(data.length / 2 / format.channels);
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < format.channels; c++) sum += data.readInt16LE((i * format.channels + c) * 2);
    mono[i] = sum / format.channels;
  }
  const length = Math.floor((frames * rate) / format.rate);
  const out = Buffer.alloc(length * 2);
  for (let i = 0; i < length; i++) {
    const at = (i * format.rate) / rate, j = Math.floor(at), t = at - j;
    const v = (mono[j] ?? 0) * (1 - t) + (mono[j + 1] ?? mono[j] ?? 0) * t;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return out;
}

socket.on("error", (error) => { console.error("Cannot reach the daemon:", error.message); process.exit(1); });
call("events.subscribe", {});
