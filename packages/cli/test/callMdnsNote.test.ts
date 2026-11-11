import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CallSignal } from "@ghostly/core";

// A resolver that never answers, as a `.local` name nobody claims holds one of libuv's two DNS threads for 5 s.
const lookups = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:dns/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:dns/promises")>();
  const lookup = () => { lookups.count++; return new Promise(() => {}); };
  return { ...real, lookup, default: { ...real, lookup } };
});

const { CallMedia, loadCallStack } = await import("../src/calls/media");
type CallStack = import("../src/calls/media").CallStack;

let bindBefore: string | undefined;
beforeAll(() => { bindBefore = process.env.GHOSTLY_CALL_BIND; process.env.GHOSTLY_CALL_BIND = "127.0.0.1"; });
afterAll(() => {
  if (bindBefore === undefined) delete process.env.GHOSTLY_CALL_BIND; else process.env.GHOSTLY_CALL_BIND = bindBefore;
});

describe("a contact's mDNS candidates", () => {
  it("are logged, never resolved: an offer with 8 `.local` names answered 5 times, and an answer with 8, look up none", async () => {
    const stack = await loadCallStack() as CallStack;
    const names = Array.from({ length: 8 }, (_, i) => `1 1 UDP ${2122260223 - i} ${randomUUID()}.local ${50000 + i} typ host`);
    const lines: string[] = [];
    const options = { rate: 48000 as const, onFrame: () => {}, onState: () => {}, log: (line: string) => lines.push(line) };

    const contact = await CallMedia.offer(stack, options);
    try {
      const offer = { ...contact.local, c: names } as CallSignal;
      // The first answer and each re-answer of a newer offer (`MAX_REDIALS`).
      for (let i = 0; i < 5; i++) (await CallMedia.answer(stack, offer, options)).close();
      // This side's own call: the contact's answer carries the same names. The contact's side gets the offer without
      // its candidates: with them, its checks and its DTLS hello reach this side before the answer, and libdatachannel
      // 0.24.5 can refuse that answer (the race CallManager's `redial` describes).
      const own = await CallMedia.offer(stack, options);
      const theirs = await CallMedia.answer(stack, { ...own.local, c: [] } as CallSignal, options);
      try {
        own.applyAnswer({ ...theirs.local, c: names } as CallSignal);
      } finally {
        own.close();
        theirs.close();
      }
    } finally {
      contact.close();
    }

    expect(lookups.count).toBe(0);
    expect(lines.filter((line) => line.includes(".local") && line.includes("not resolved here")).length).toBe(6 * 8);
  }, 60_000);
});
