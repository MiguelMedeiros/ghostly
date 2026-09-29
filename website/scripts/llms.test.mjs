import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KEY_DOCS, SITE, llmsFull, llmsIndex, wispsOf } from "./llms.mjs";

// The reference index and the published copies come from `npm run sync:references` (CI runs it before `npm test`).
const root = fileURLToPath(new URL("../../", import.meta.url));
const numbering = JSON.parse(readFileSync(resolve(root, "docs/wisps/numbering.json"), "utf8"));
const entries = JSON.parse(readFileSync(resolve(root, "website/lib/reference-index.json"), "utf8"));
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("the sync writes llms.txt and llms-full.txt, as the generator makes them", () => {
  for (const name of ["llms.txt", "llms-full.txt"]) assert.ok(existsSync(resolve(root, "website/public", name)), `website/public/${name}: run npm run sync:references`);
  assert.equal(read("website/public/llms.txt"), llmsIndex(entries, numbering));
  assert.equal(read("website/public/llms-full.txt"), llmsFull(entries, numbering, read));
});

test("llms.txt follows the convention: an H1, a summary, then sections of links", () => {
  const index = llmsIndex(entries, numbering);
  assert.match(index, /^# Ghostly\n\n> \S/);
  for (const section of ["Ghostly", "How it works", "Developers", "WISPs", "CLI", "AI agents", "Optional"]) assert.match(index, new RegExp(`^## ${section}$`, "m"));
  for (const row of index.split("\n").filter((l) => l.startsWith("- "))) assert.match(row, /^- \[[^\]]+\]\(https:\/\/[^)\s]+\)(: \S.*)?$/, row);
  assert.ok(index.includes(`(${SITE}/developers/agents)`), "the AI agents page");
  assert.ok(index.includes("/packages/cli/SKILL.md)"), "the agent skill");
});

test("every WISP is in llms.txt with its title, page and line, and in llms-full.txt", () => {
  const index = llmsIndex(entries, numbering);
  const full = llmsFull(entries, numbering, read);
  const wisps = wispsOf(entries, numbering);
  assert.equal(wisps.length, numbering.length);
  for (const wisp of wisps) {
    assert.ok(wisp.benefit, `${wisp.file}: its header's Summary row`);
    assert.ok(index.includes(`- [${wisp.title}](${SITE}/wisps/${wisp.slug}): ${wisp.benefit}`), `${wisp.file} in llms.txt`);
    assert.ok(full.includes(`<!-- Source: ${SITE}/reference/${wisp.file} -->\n\n# ${wisp.title}\n`), `${wisp.file} in llms-full.txt`);
  }
  for (const path of KEY_DOCS) assert.ok(full.includes(read(path).trim()), `${path} in llms-full.txt`);
});
