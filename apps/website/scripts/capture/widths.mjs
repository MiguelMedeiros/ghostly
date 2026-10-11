#!/usr/bin/env node
// The narrower copies of each site shot, for `srcset` (lib/shots.ts): a capture is 2560 wide (780 on a phone), and a
// page draws it at a third of that or less. Beside chat.webp stand chat-1280.webp and chat-2000.webp; beside
// chat-mobile.webp, chat-mobile-300.webp. The widths are lib/shot-widths.json; the widest is the capture itself.
//
// run.mjs calls this for each shot it writes. Alone, it writes the copies of every shot in the folder again:
//   node scripts/capture/widths.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const WEBSITE = fileURLToPath(new URL("../..", import.meta.url));
const OUT = join(WEBSITE, "public/screenshots/current");
const WIDTHS = JSON.parse(readFileSync(join(WEBSITE, "lib/shot-widths.json"), "utf8"));

/** A narrower copy's name ends in its width; a capture's never does. */
export const isCopy = (file) => /-\d+\.webp$/.test(file);

/** The copies a shot gets, by its file name: `[{ file, width }]`, without the capture itself. */
export function copiesOf(file) {
  const widths = WIDTHS[file.endsWith("-mobile.webp") ? "phone" : "desktop"];
  return widths.slice(0, -1).map((width) => ({ file: file.replace(/\.webp$/, `-${width}.webp`), width }));
}

/** Writes the copies of `file` (a name in `dir`) from `source`, the capture or the PNG it came from. */
export async function writeCopies(file, source, dir = OUT) {
  const sharp = createRequire(join(WEBSITE, "package.json"))("sharp");
  const written = [];
  for (const copy of copiesOf(file)) {
    await sharp(source).resize({ width: copy.width }).webp({ quality: 82, effort: 6 }).toFile(join(dir, copy.file));
    written.push(copy.file);
  }
  return written;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const file of readdirSync(OUT).filter((n) => n.endsWith(".webp") && !isCopy(n)).sort()) {
    for (const copy of await writeCopies(file, join(OUT, file))) console.log(`[widths] wrote ${copy}`);
  }
}
