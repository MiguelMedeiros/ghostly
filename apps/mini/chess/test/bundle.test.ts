// covers: apps.chess
// The built app: one self-contained HTML file that loads nothing by URL, carries the notices of what it bundles,
// and stays small.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
let out: string;
let page: string;

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "mini-chess-"));
  await build({ configFile: join(root, "vite.config.ts"), logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
  page = readFileSync(join(out, "index.html"), "utf8");
}, 60_000);

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("the Chess bundle", () => {
  it("is one HTML file with its script and styles inline", () => {
    expect(readdirSync(out)).toEqual(["index.html"]);
    expect(page).not.toMatch(/<script\b[^>]*\bsrc=/i);
    expect(page).not.toMatch(/<link\b/i);
    expect(page).not.toMatch(/\b(?:src|href|srcset|action|poster)\s*=/i);
    expect(page).not.toMatch(/type="module"/);
    expect(page.match(/<script\b/g)).toHaveLength(1);
    expect(page.match(/<style\b/g)).toHaveLength(1);
    expect(page.match(/<\/head>/g)).toHaveLength(1);
    expect(page.match(/<\/body>/g)).toHaveLength(1);
  });

  it("keeps the license notices of chess.js and @noble/hashes", () => {
    const notice = page.slice(page.indexOf("/*!"), page.indexOf("*/", page.indexOf("/*!")) + 2);
    expect(notice).toContain("chess.js 1.4.0 (BSD-2-Clause)");
    expect(notice).toContain("Copyright (c) 2025, Jeff Hlywa");
    expect(notice).toContain("Redistributions of source code must retain the above copyright notice");
    expect(notice).toContain("@noble/hashes 2.4.0 (MIT)");
    expect(notice).toContain("Copyright (c) 2022 Paul Miller");
  });

  it("names no address and no way to reach the network", () => {
    const start = page.indexOf("/*!");
    const code = page.slice(0, start) + page.slice(page.indexOf("*/", start) + 2);
    expect(code).not.toMatch(/\b(?:https?|wss?):\/\//i);
    expect(code).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|RTCPeerConnection)\b/);
    expect(code).not.toMatch(/\bimport\s*\(/);
  });

  // The web runner locks the page with a nonce once the entry is written (WISP 1200, "The runner and the broker"):
  // markup handlers and scripts made later never run there.
  it("runs under the runner's lock: no inline event handler, no script made after start", () => {
    expect(page).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(page).not.toMatch(/createElement\(\s*["'`]script["'`]/);
    expect(page).not.toMatch(/\b(?:insertAdjacentHTML|outerHTML|document\.write)\b|setAttribute\(\s*["'`]on/);
  });

  it("stays small", () => {
    expect(Buffer.byteLength(page)).toBeLessThan(160 * 1024);
  });
});
