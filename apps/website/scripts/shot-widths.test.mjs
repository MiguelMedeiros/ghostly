import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { copiesOf, isCopy } from "./capture/widths.mjs";

// Each app screenshot's narrower copies are files in the repository, written by scripts/capture/widths.mjs: a page's
// `srcset` (lib/shots.ts) names them, and a missing one is a broken picture on every screen of that size.
const website = fileURLToPath(new URL("..", import.meta.url));
const dir = join(website, "public/screenshots/current");
const sharp = createRequire(join(website, "package.json"))("sharp");
const files = readdirSync(dir).filter((n) => n.endsWith(".webp"));
const captures = files.filter((n) => !isCopy(n));

test("a capture gets two narrower copies, and a phone's one", () => {
  assert.deepEqual(copiesOf("chat.webp"), [{ file: "chat-1280.webp", width: 1280 }, { file: "chat-2000.webp", width: 2000 }]);
  assert.deepEqual(copiesOf("chat-mobile.webp"), [{ file: "chat-mobile-300.webp", width: 300 }]);
  assert.ok(isCopy("chat-1280.webp") && !isCopy("chat.webp") && !isCopy("identities-chat-mobile.webp"));
});

test("every screenshot has its copies, each of its width, the capture's shape and fewer bytes", async () => {
  assert.ok(captures.length >= 19, `${captures.length} captures in public/screenshots/current`);
  for (const file of captures) {
    const full = await sharp(join(dir, file)).metadata();
    let bytes = statSync(join(dir, file)).size;
    for (const copy of copiesOf(file).reverse()) {
      assert.ok(files.includes(copy.file), `${copy.file} is missing: node scripts/capture/widths.mjs`);
      const meta = await sharp(join(dir, copy.file)).metadata();
      assert.equal(meta.width, copy.width, copy.file);
      assert.ok(Math.abs(meta.height - (full.height * copy.width) / full.width) <= 1, `${copy.file} has the shape of ${file}`);
      const size = statSync(join(dir, copy.file)).size;
      assert.ok(size < bytes, `${copy.file} is lighter than the next one up`);
      bytes = size;
    }
  }
});

test("no copy is left without its capture", () => {
  const expected = new Set(captures.flatMap((file) => copiesOf(file).map((copy) => copy.file)));
  assert.deepEqual(files.filter((n) => isCopy(n) && !expected.has(n)), []);
});
