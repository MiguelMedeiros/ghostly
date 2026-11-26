import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heardCallSignal } from "@ghostly/core";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { CallManager } from "../src/calls/manager";
// covers: headless.calls

/**
 * Auto-answer with Hide my IP from contacts on: the CLI answers no call then, so `call.incoming` says `auto: false`
 * and the daemon does not try (its answer only failed, and the call rang on). No media: the stack is missing.
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

let logged: string[] = [];
let quiet: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logged = [];
  quiet = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { logged.push(String(chunk)); return true; });
});
afterEach(() => quiet.mockRestore());

interface Daemon { calls: CallManager; events: { type: string; [k: string]: unknown }[]; signals: (string | null)[]; stacks: () => number }

/** A daemon's manager on one fake chat (`chat-ba`), Hide my IP on or off. */
function daemon(relayOnly: boolean): Daemon {
  const dir = mkdtempSync(join(tmpdir(), "gcar-"));
  dirs.push(dir);
  const link = { id: "chat-ba", profile: "paired-chat/1", callsUnavailable: null, label: "to chat-ba" } as Partial<LinkView>;
  const state = () => ({ links: [link], groups: [], settings: { iceServers: [], ...(relayOnly ? { relayOnly } : {}) } }) as unknown as EngineState;
  const events: Daemon["events"] = [], signals: Daemon["signals"] = [];
  let stacks = 0;
  const calls = new CallManager({
    engine: { getState: state, chatView: (id) => state().links.find((l) => l.id === id), getSettings: () => state().settings, setCallSignal: ({ signal }) => { signals.push(signal); } },
    emit: (type, _id, fields) => events.push({ type, ...fields }), profileDir: dir,
    stack: async () => { stacks++; return "no media in this test"; },
  });
  return { calls, events, signals, stacks: () => stacks };
}

function ring(calls: CallManager): void {
  const offer = { t: "o", ts: Date.now(), u: "ufra", p: "p".repeat(22), f: "ab".repeat(32), s: "actpass", c: [], v: 0 };
  calls.onSignal("chat-ba", heardCallSignal(JSON.stringify(offer), Date.now()));
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("call.incoming's auto with Hide my IP from contacts on", () => {
  it("says auto: false, and the daemon tries no answer: the call rings on for the program to decline", async () => {
    const d = daemon(true);
    d.calls.setAuto({ on: true, from: [] });
    ring(d.calls);
    await settle();
    expect(d.events).toEqual([expect.objectContaining({ type: "call.incoming", chat: "chat-ba", auto: false })]);
    expect(logged.join(""), "no auto-answer was tried").not.toContain("auto-answer failed");
    expect(logged.join("")).toContain("not answered by itself: Calls are off while Hide my IP from contacts is on");
    expect(d.stacks(), "no media stack was loaded").toBe(0);
    expect(d.signals, "nothing went to the contact").toEqual([]);
    expect(d.calls.list()).toEqual([expect.objectContaining({ direction: "in", state: "ringing" })]);
    // The program declines it.
    await d.calls.hangup(undefined);
    expect(d.events.at(-1)).toMatchObject({ type: "call.ended", reason: "hangup" });
    await d.calls.stopAll();
  });

  it("from a chat auto-answer lists, says auto: false too; with auto-answer off, auto: false and no log line", async () => {
    const listed = daemon(true);
    listed.calls.setAuto({ on: true, from: ["chat-ba"] });
    ring(listed.calls);
    await settle();
    expect(listed.events[0]).toMatchObject({ type: "call.incoming", auto: false });
    await listed.calls.stopAll();

    logged = [];
    const off = daemon(true);
    ring(off.calls);
    await settle();
    expect(off.events[0]).toMatchObject({ type: "call.incoming", auto: false });
    expect(logged.join("")).not.toContain("not answered by itself");
    await off.calls.stopAll();
  });

  it("with Hide my IP off, auto-answer still says auto: true and answers", async () => {
    const d = daemon(false);
    d.calls.setAuto({ on: true, from: [] });
    ring(d.calls);
    await settle();
    expect(d.events[0]).toMatchObject({ type: "call.incoming", auto: true });
    // It tried: the stack this test lacks is what failed it.
    expect(d.stacks()).toBeGreaterThan(0);
    expect(logged.join("")).toContain("auto-answer failed: no media in this test");
    await d.calls.stopAll();
  });
});
