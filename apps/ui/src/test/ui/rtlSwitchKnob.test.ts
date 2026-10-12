import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// covers: app.i18n, chat.dht.fallback

/**
 * The connection panel's switches (Fallback) move their knob with `translateX` when on. Right to left the knob starts at
 * the track's right end, so the same move took it 16 px past the track in Arabic, and the switch looked like it had no
 * knob. Each knob's move needs its right-to-left mirror; layout itself is checked in a browser, not here.
 */
const CSS = readFileSync(join(fileURLToPath(import.meta.url), "../../../index.css"), "utf8");

/** Each rule moving a checked switch's knob: its selector and its move in px. */
const moves = (rtl: boolean) =>
  [...CSS.matchAll(/^(\[dir="rtl"\] )?(\.\S*switch input:checked \+ \S*::after) \{[^}]*transform: translateX\((-?\d+)px\)/gm)]
    .filter(([, dir]) => !!dir === rtl)
    .map(([, , selector, px]) => [selector, Number(px)] as const);

describe("a switch that is on, right to left", () => {
  it("moves its knob the other way, so it stays inside its track", () => {
    const ltr = moves(false), rtl = new Map(moves(true));
    expect(ltr.length).toBeGreaterThan(0);
    expect(ltr.map(([selector]) => [selector, rtl.get(selector)])).toEqual(ltr.map(([selector, px]) => [selector, -px]));
  });
});
