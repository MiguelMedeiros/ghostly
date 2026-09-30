import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MEMBER_TEXT, memberColorIndex, memberText, rosterColors } from "../../lib/memberColors";
import { RUN_GAP_MS, authorsOf } from "../../lib/senderRuns";

// covers: groups.member-colors

/** A key as members have them: 52 z-base-32 characters. */
const Z32 = "ybndrfg8ejkmcpqxot1uwisza345h769";
function keyOf(seed: number): string {
  let x = seed * 2654435761 >>> 0, key = "";
  for (let i = 0; i < 52; i++) { x = Math.imul(x ^ (x >>> 13), 1103515245) + 12345 >>> 0; key += Z32[x % 32]; }
  return key;
}

describe("a member's colour, from their key", () => {
  it("is the same for the same key, every time and on every device (a pure function of the key)", () => {
    const key = keyOf(1);
    expect(memberColorIndex(key)).toBe(memberColorIndex(key.slice()));
    expect(memberText(key)).toBe(MEMBER_TEXT[memberColorIndex(key)]);
    // Fixed answers: a change here changes everyone's colour in every group.
    expect(["alice".padEnd(52, "y"), "bob".padEnd(52, "y"), "carol".padEnd(52, "y"), keyOf(7)].map(memberColorIndex)).toMatchInlineSnapshot(`
      [
        8,
        6,
        8,
        7,
      ]
    `);
  });

  it("is one of the twelve hues, each written out for Tailwind", () => {
    expect(MEMBER_TEXT).toHaveLength(12);
    MEMBER_TEXT.forEach((cls, i) => expect(cls).toBe(`text-member-${i}`));
    for (let i = 0; i < 200; i++) expect(memberColorIndex(keyOf(i))).toBeGreaterThanOrEqual(0);
  });

  it("spreads keys across the whole palette", () => {
    const counts = new Array(MEMBER_TEXT.length).fill(0);
    const n = 12_000;
    for (let i = 0; i < n; i++) counts[memberColorIndex(keyOf(i))]++;
    // About 1000 each: none empty, none more than a fifth off.
    for (const count of counts) expect(Math.abs(count - n / MEMBER_TEXT.length)).toBeLessThan(n / MEMBER_TEXT.length / 5);
  });

  it("tells apart keys that differ only at the end", () => {
    const base = keyOf(3).slice(0, 51);
    const hues = new Set([...Z32].map(c => memberColorIndex(base + c)));
    expect(hues.size).toBeGreaterThanOrEqual(8);
  });
});

describe("the members' colours in a group, given out over its roster", () => {
  const roster = (n: number, from = 0) => Array.from({ length: n }, (_, i) => keyOf(from + i));
  const shuffled = <T,>(list: readonly T[], seed: number) => [...list].sort((a, b) => memberColorIndex(`${seed}${a}`) - memberColorIndex(`${seed}${b}`) || (a < b ? -1 : 1));

  it("never gives two members of a group of up to twelve the same colour", () => {
    for (let n = 2; n <= 12; n++) for (let from = 0; from < 400; from += 20) {
      const colors = rosterColors(roster(n, from));
      expect(new Set(colors.values()).size).toBe(n);
    }
  });

  it("is the same on every device: the same roster, in whatever order it comes, gives the same colours", () => {
    const keys = roster(9, 50);
    const here = rosterColors(keys);
    for (const seed of [1, 2, 3]) expect(rosterColors(shuffled(keys, seed))).toEqual(here);
    // As the page asks for it: by class.
    for (const key of keys) expect(memberText(key, here)).toBe(MEMBER_TEXT[here.get(key)!]);
  });

  it("past twelve, comes round again: each twelve (in key order) distinct among themselves", () => {
    const keys = roster(30, 7);
    const colors = rosterColors(keys);
    const sorted = [...keys].sort();
    for (let i = 0; i < 24; i += 12) expect(new Set(sorted.slice(i, i + 12).map(k => colors.get(k))).size).toBe(12);
    expect(new Set(sorted.slice(24).map(k => colors.get(k))).size).toBe(6);
  });

  it("a member keeps the hue their key points to unless someone before them in the roster took it", () => {
    const keys = roster(5, 90);
    const colors = rosterColors(keys);
    const first = [...keys].sort()[0];
    expect(colors.get(first)).toBe(memberColorIndex(first));
    // Someone the roster no longer has goes by their key alone.
    expect(memberText("gone".padEnd(52, "y"), colors)).toBe(MEMBER_TEXT[memberColorIndex("gone".padEnd(52, "y"))]);
  });
});

/* ---------- The palette's contrast, as src/index.css sets it ---------- */

const CSS = readFileSync(join(fileURLToPath(import.meta.url), "../../../index.css"), "utf8");

/** Each theme block's custom properties, by its selector list. */
function blocks(): { selector: string; vars: Record<string, string> }[] {
  const out: { selector: string; vars: Record<string, string> }[] = [];
  for (const match of CSS.matchAll(/((?::root[^{,]*,?\s*)+)\{([^}]*)\}/g)) {
    const vars: Record<string, string> = {};
    for (const [, name, value] of match[2].matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[name] = value.trim();
    out.push({ selector: match[1].trim(), vars });
  }
  return out;
}

/** What each of the 8 themes (4 colour themes, dark and light) resolves its tokens to: its own block over the base one. */
function themes(): { name: string; vars: Record<string, string> }[] {
  const all = blocks();
  const base = (scheme: "dark" | "light") => all.find(b => scheme === "dark" ? b.selector.startsWith(":root,") : b.selector.startsWith(':root[data-theme="light"],'))!.vars;
  return ["classic", "monochrome", "cyan", "purple"].flatMap(color => (["dark", "light"] as const).map(scheme => {
    const own = all.find(b => b.selector.includes(`[data-theme="${scheme}"][data-color-theme="${color}"]`))!.vars;
    return { name: `${color} ${scheme}`, vars: { ...base(scheme), ...own } };
  }));
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe("the members' hues (index.css)", () => {
  const list = themes();

  it("are set for dark and light apart, twelve each, and differ between them", () => {
    expect(list).toHaveLength(8);
    const dark = list.find(t => t.name === "classic dark")!.vars, light = list.find(t => t.name === "classic light")!.vars;
    for (let i = 0; i < 12; i++) {
      expect(dark[`theme-member-${i}`]).toMatch(/^#[0-9a-f]{6}$/);
      expect(light[`theme-member-${i}`]).toMatch(/^#[0-9a-f]{6}$/);
      expect(dark[`theme-member-${i}`]).not.toBe(light[`theme-member-${i}`]);
    }
    for (let i = 0; i < 12; i++) expect(CSS).toContain(`--color-member-${i}: var(--theme-member-${i});`);
  });

  it("read at WCAG AA (4.5:1) on the received and sent bubbles and the header, in every theme", () => {
    const failures: string[] = [];
    for (const { name, vars } of list) {
      for (const surface of ["theme-received-bg", "theme-sent-bg", "theme-panel-header"]) {
        for (let i = 0; i < 12; i++) {
          const ratio = contrast(vars[`theme-member-${i}`], vars[surface]);
          if (ratio < 4.5) failures.push(`${name}: member-${i} ${vars[`theme-member-${i}`]} on ${surface} ${vars[surface]} is ${ratio.toFixed(2)}:1`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("runs of a member's messages (authorsOf)", () => {
  const A = "a".repeat(52), B = "b".repeat(52);
  const group = { members: [{ key: A, nick: "Ana", role: "member" as const, me: false, online: true, missing: 0 }, { key: B, role: "member" as const, me: false, online: true, missing: 0 }], formerNames: { ["c".repeat(52)]: "Cy" } };
  // Noon on a fixed day, a minute a message: well inside a run's pause.
  const NOON = new Date(2026, 8, 29, 12, 0).getTime();
  let clock = NOON;
  const msg = (id: string, member?: string, extra: object = {}) => ({ id, sender: member ? "peer" : "me", timestamp: (clock += 60_000), ...(member && { member }), ...extra });
  const marks = (authors: Map<string, { key: string; first: boolean; last: boolean }>) =>
    [...authors].map(([id, a]) => `${id}:${a.key[0]}:${a.first ? "F" : "-"}${a.last ? "L" : "-"}`);

  it("marks the first (the name) and the last (the picture) message of each run, and none of mine", () => {
    clock = NOON;
    const authors = authorsOf([msg("1", A), msg("2", A), msg("3", A), msg("4", B), msg("5"), msg("6", B), msg("7", A)], group, new Set(), () => undefined);
    expect(marks(authors)).toEqual(["1:a:F-", "2:a:--", "3:a:-L", "4:b:FL", "6:b:FL", "7:a:FL"]);
    expect(authors.has("5")).toBe(false);
  });

  it("ends a run at a line of the group or a payment note in the timeline, not at a note shown under its bubble", () => {
    clock = NOON;
    const rows = [msg("1", A), { id: "e", sender: "system", event: "joined", timestamp: clock }, msg("2", A), { id: "n", sender: "peer", member: A, groupPay: { id: "hidden" }, timestamp: clock }, msg("3", A),
      { id: "m", sender: "peer", member: A, groupPay: { id: "shown" }, timestamp: clock }, msg("4", A)];
    const authors = authorsOf(rows, group, new Set(["hidden"]), () => undefined);
    expect(marks(authors)).toEqual(["1:a:FL", "2:a:F-", "3:a:-L", "4:a:FL"]);
    expect(authors.has("n")).toBe(false);
  });

  it("ends a run at a pause of more than five minutes, and at midnight", () => {
    const at = (id: string, time: number) => ({ id, sender: "peer", member: A, timestamp: time });
    const late = new Date(2026, 8, 29, 23, 58).getTime();
    const authors = authorsOf([at("1", NOON), at("2", NOON + RUN_GAP_MS), at("3", NOON + 2 * RUN_GAP_MS + 1), at("4", late), at("5", late + 3 * 60_000)], group, new Set(), () => undefined);
    expect(marks(authors)).toEqual(["1:a:F-", "2:a:-L", "3:a:FL", "4:a:FL", "5:a:FL"]);
  });

  it("names the member as the roster or the group's memory does, with their picture", () => {
    clock = NOON;
    const C = "c".repeat(52);
    const authors = authorsOf([msg("1", A), msg("2", B), msg("3", C)], group, new Set(), key => key === A ? "data:image/png;base64,AA" : undefined);
    expect(authors.get("1")).toEqual({ key: A, name: "Ana", picture: "data:image/png;base64,AA", first: true, last: true });
    expect(authors.get("2")).toEqual({ key: B, name: "", first: true, last: true });
    expect(authors.get("3")).toEqual({ key: C, name: "Cy", first: true, last: true });
  });
});
