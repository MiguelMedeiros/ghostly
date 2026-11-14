import { test } from "node:test";
import assert from "node:assert/strict";
import { qrModules, qrPath } from "../lib/qr.ts";
import { ANDROID_PAGE_URL } from "../lib/release.ts";

// The /android page's QR code (lib/qr.ts) is drawn on the server, with no QR package. Its symbol for the page's link is
// the one qrcode.react (the app's encoder) draws at level M; the rows below are that symbol, so a change to the encoder
// that would make phones read another link, or none, fails here. Checked on 2026-11-08: jsQR read it back, and the
// same encoder gave qrcode.react's own symbol for links of 1 to 180 bytes.
const ANDROID_PAGE_QR = [
  "#######.##..#..##.###.#######",
  "#.....#.##..#.##.#....#.....#",
  "#.###.#..###.###..#.#.#.###.#",
  "#.###.#.#..#....##.#..#.###.#",
  "#.###.#..#.#.#.....##.#.###.#",
  "#.....#..###..#..####.#.....#",
  "#######.#.#.#.#.#.#.#.#######",
  "........#..####..#.##........",
  "#.##.###.###.##.#####.#..#.##",
  ".#####.######..##.###.###...#",
  "...####.##.##.##.##.##..#.##.",
  "##.##..#.##.####...##.#.....#",
  "..######...#....##.#...#.##..",
  ".##.##.#..#.##...###..#...###",
  "#..#..#..##...#..#.###.##.###",
  "##.#.#.###.#.#.#..####.#...#.",
  "##.#.##.##.#......####.###.#.",
  "..##.#.##.#.##...#..##.#.###.",
  "#..#####.#.##....#..###.#.#..",
  "..###....#..#..#####.#.##.#..",
  ".#.####...####.#.##.#######..",
  "........#....###.##.#...#####",
  "#######.###..#..##.##.#.##.#.",
  "#.....#.#..#....#.#.#...##.##",
  "#.###.#....#..##.#..#####.#.#",
  "#.###.#.###.###.##..#..###.#.",
  "#.###.#.##..#####.#....#..#.#",
  "#.....#..######.#.###.##.#.#.",
  "#######.###..#.#.#.##.#....#.",
];

const rows = (modules) => modules.map((row) => row.map((dark) => (dark ? "#" : ".")).join(""));

test("the /android link's QR code is version 3 at level M, the symbol qrcode.react draws", () => {
  assert.equal(ANDROID_PAGE_URL, "https://ghostly.tools/android");
  assert.deepEqual(rows(qrModules(ANDROID_PAGE_URL)), ANDROID_PAGE_QR);
});

test("a symbol's fixed patterns sit where a reader looks for them", () => {
  for (const [text, size] of [
    ["a", 21],
    ["x".repeat(60), 33],
    ["x".repeat(170), 53],
  ]) {
    const m = qrModules(text);
    assert.equal(m.length, size, `${text.length} bytes`);
    // The three finders: a dark ring, a light ring, a dark 3x3 core.
    for (const [ox, oy] of [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ]) {
      for (let y = 0; y < 7; y++)
        for (let x = 0; x < 7; x++) {
          const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
          assert.equal(m[oy + y][ox + x], d !== 2, `finder at ${ox},${oy}`);
        }
    }
    // The timing rows alternate, and the dark module is dark.
    for (let i = 8; i < size - 8; i++) {
      assert.equal(m[6][i], i % 2 === 0);
      assert.equal(m[i][6], i % 2 === 0);
    }
    assert.equal(m[size - 8][8], true);
  }
});

test("a text past version 9 is refused, not cut", () => {
  assert.throws(() => qrModules("x".repeat(181)), /Too long/);
});

test("the path draws each run of dark modules once, inside the quiet zone", () => {
  assert.equal(qrPath([[true, true, false, true]], 4), "M4 4h2v1H4zM7 4h1v1H7z");
});
