import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GhostlyEvent } from "../src/events";

// covers: headless.cli

// Each cursor write is a file written and renamed over the last: about 0.17 ms of a blocked loop and a disk block.
const fs = vi.hoisted(() => ({ renames: [] as string[] }));
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  return { ...real, renameSync: (from: string, to: string) => { fs.renames.push(to); real.renameSync(from, to); } };
});

const { eventHandler, CURSOR_WRITE_MS } = await import("../src/listen");

let seq = 0;
const event = (type: string, fields: Record<string, unknown> = {}, at = ++seq): GhostlyEvent => ({ seq: at, id: `${type}:${at}`, type, at: 5, ...fields });

afterEach(() => { fs.renames.length = 0; });

describe("listen --cursor writes", () => {
  // A busy group not on --group, or a contact's app frames (48 a second): each dropped event wrote the cursor, one
  // write and rename per event, so a listen spent 0.2 ms per event it was never asked for.
  it("writes the cursor past events it drops at most once per CURSOR_WRITE_MS, and past the last of them", async () => {
    const cursor = join(mkdtempSync(join(tmpdir(), "ghostly-cursor-")), "cursor");
    const handle = eventHandler({ types: ["message.received"], print: false, cursor, write: () => {} });
    const frames = Array.from({ length: 1_000 }, () => event("app.message", { chat: "c1" }));
    for (const frame of frames) handle(frame);
    expect(fs.renames.length).toBeLessThanOrEqual(1);
    await vi.waitFor(() => expect(Number(readFileSync(cursor, "utf8").trim())).toBe(frames.at(-1)!.seq), { timeout: CURSOR_WRITE_MS * 10 });
    expect(fs.renames.length).toBeLessThanOrEqual(2);
  });

  // Typing and app frames are not journaled: they carry the number of the last event that was, and each one passed
  // wrote that same number again.
  it("does not write a number the cursor already holds", async () => {
    const cursor = join(mkdtempSync(join(tmpdir(), "ghostly-cursor-")), "cursor");
    const handle = eventHandler({ types: [], print: false, cursor, write: () => {} });
    const at = ++seq;
    for (let i = 0; i < 200; i++) handle(event("app.message", { chat: "c1" }, at));
    await handle.idle();
    expect(readFileSync(cursor, "utf8")).toBe(`${at}\n`);
    expect(fs.renames.length).toBe(1);
  });

  it("a stop writes the cursor past the events dropped since the last write, not one wait later", async () => {
    const cursor = join(mkdtempSync(join(tmpdir(), "ghostly-cursor-")), "cursor");
    const handle = eventHandler({ types: ["message.received"], print: false, cursor, write: () => {} });
    const first = event("app.message", { chat: "c1" }), last = event("app.message", { chat: "c1" });
    handle(first);
    handle(last);
    await handle.stop();
    expect(readFileSync(cursor, "utf8")).toBe(`${last.seq}\n`);
  });
});
