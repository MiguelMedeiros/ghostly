import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// scripts/og-image.mjs writes each card to `out`, resolved from apps/website. The social preview is the repository's
// docs/assets/social-preview.png (the file e2e/launch-checklist.spec.ts checks), not a copy under apps/: after the
// site moved from website/ to apps/website, "../docs/assets" pointed at apps/docs/assets, a folder that does not exist.
const website = fileURLToPath(new URL("..", import.meta.url));
const root = join(website, "../..");
const outs = Object.fromEntries(
  [...readFileSync(join(website, "scripts/og-image.mjs"), "utf8").matchAll(/^ {2}(\w+): \{\n\s+w: \d+, h: \d+, out: "([^"]+)"/gm)].map((m) => [m[1], join(website, m[2])]),
);

test("og-image writes the share image and the repository's social preview", () => {
  assert.deepEqual(outs, {
    og: join(website, "public/og-image.png"),
    social: join(root, "docs/assets/social-preview.png"),
  });
});

test("every card's folder exists, so no card is left half written", () => {
  for (const [card, out] of Object.entries(outs)) assert.ok(existsSync(dirname(out)), `${card}: ${dirname(out)} exists`);
});
