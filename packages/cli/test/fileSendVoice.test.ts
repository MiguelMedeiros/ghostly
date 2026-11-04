import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.files

/**
 * `file send --voice` on a file that is not a voice note: an empty file, a text, bytes no decoder reads as sound, a
 * sound longer than 15 minutes. Each is refused naming what is wrong, and the `--voice <ms>` hint is given only when
 * the sound could not be measured here (no ffmpeg): followed for a file that is not sound, it sent a voice bubble that
 * cannot play.
 */
const link = { id: "chat-one", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "idle",
  capabilities: { files: true }, pairing: { status: "ready" } } as unknown as LinkView;
const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-voice-"));
  await openPersistentIndexedDb(join(dir, "db"));
  registerFileBytes("native", async () => new NodeFileBytes(join(dir, "files")), true);
});
afterEach(() => { vi.unstubAllEnvs(); });

function chat() {
  const node = {
    getState: () => ({ links: [link], groups: [], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState,
    getMessages: vi.fn(async () => []),
    sendFile: vi.fn(async () => {}),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { node, send: (path: string, voice: number | true = true) => callApi(ctx, "file.send", { chat: "Alice", path, voice }) };
}

function file(name: string, bytes: string | Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

/** 20 minutes of 8 kHz, 8-bit mono WAV: a small file, longer than any voice note. */
function longWav(): Buffer {
  const data = Buffer.alloc(8_000 * 20 * 60, 128);
  for (let i = 0; i < data.length; i += 97) data[i] = 200;
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(8_000, 24); head.writeUInt32LE(8_000, 28); head.writeUInt16LE(1, 32); head.writeUInt16LE(8, 34);
  head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

describe("file send --voice on a file that is not a voice note", () => {
  it("an empty file is refused, with or without a length, and nothing is sent", async () => {
    const { node, send } = chat();
    const empty = file("empty.wav", "");
    for (const voice of [true, 2000] as const) {
      await expect(send(empty, voice)).rejects.toMatchObject({ code: "bad_request", message: "empty.wav is empty: a voice note is audio" });
    }
    expect(node.sendFile).not.toHaveBeenCalled();
  });

  it("a text and a 20-minute WAV each say what is wrong: the type, the length", async () => {
    const { node, send } = chat();
    await expect(send(file("notes.txt", "shopping list"))).rejects.toMatchObject({ code: "bad_request", message: "notes.txt is text/plain, not audio (webm, ogg, mp4, mpeg, aac, m4a or wav)" });
    await expect(send(file("long.wav", longWav()))).rejects.toMatchObject({ code: "bad_request", message: "long.wav is longer than 15 minutes: a voice note is at most 15" });
    expect(node.sendFile).not.toHaveBeenCalled();
  });

  it.skipIf(!hasFfmpeg)("bytes ffmpeg reads as no sound are refused as not audio: no --voice <ms> hint, no ffmpeg address, nothing sent with a length either", async () => {
    const { node, send } = chat();
    for (const [name, bytes] of [["bad.wav", "RIFF\0\0\0\0WAVEgarbage"], ["bad.m4a", "not a sound at all"]] as const) {
      const path = file(name, bytes);
      for (const voice of [true, 2000] as const) {
        const refused = await send(path, voice).then(() => { throw new Error(`${name} was sent`); }, (error: Error) => error);
        expect(refused).toMatchObject({ code: "bad_request", message: expect.stringMatching(new RegExp(`^${name.replace(".", "\\.")} is not audio \\(`)) });
        expect(refused.message).not.toMatch(/--voice <ms>/);
        expect(refused.message).not.toMatch(/@ 0x|\[in#/);
      }
    }
    expect(node.sendFile).not.toHaveBeenCalled();
  });

  it("without ffmpeg, a kind only ffmpeg reads could not be measured: the hint stays, and with a length it is sent flat", async () => {
    vi.stubEnv("GHOSTLY_FFMPEG", "ghostly-no-such-ffmpeg");
    const { node, send } = chat();
    const path = file("note.m4a", "maybe AAC, unread here");
    await expect(send(path)).rejects.toMatchObject({ code: "bad_request", message: expect.stringMatching(/^Could not measure the voice note \(.*install ffmpeg.*\): give its length as --voice <ms>$/) });
    expect(await send(path, 2000)).toMatchObject({ file: { voice: true }, warning: expect.stringMatching(/^Sent without a waveform: could not read the sound/) });
    expect(node.sendFile).toHaveBeenCalledOnce();
  });

  it("without ffmpeg, a WAV with no sound in it is still not audio", async () => {
    vi.stubEnv("GHOSTLY_FFMPEG", "ghostly-no-such-ffmpeg");
    const { node, send } = chat();
    await expect(send(file("hollow.wav", "RIFF\0\0\0\0WAVEgarbage"), 2000)).rejects.toMatchObject({ code: "bad_request", message: expect.stringMatching(/^hollow\.wav is not audio \(a WAV without sound/) });
    expect(node.sendFile).not.toHaveBeenCalled();
  });
});
