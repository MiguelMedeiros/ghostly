import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { END, README, START, expectedReadme, familyOf, wispIndex, withIndex } from "./wisp-index.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = resolve(root, "docs/wisps");

test("the committed WISP index is the one the WISPs' headers give", () => {
  const committed = readFileSync(resolve(root, README), "utf8");
  assert.equal(committed, expectedReadme(root), `${README} is out of date: run \`npm run sync:references\` in website/ and commit it`);
});

test("every WISP in numbering.json has one row, in number order", () => {
  const numbering = JSON.parse(readFileSync(resolve(source, "numbering.json"), "utf8"));
  const table = wispIndex(numbering, (file) => readFileSync(resolve(source, file), "utf8"));
  const links = [...table.matchAll(/\]\(([^)]+\.md)\)/g)].map((m) => m[1]);
  assert.equal(links.length, numbering.length);
  const ids = links.map((file) => Number(numbering.find((e) => e.file === file).id));
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
});

test("a row reads its title, type, status and availability from the WISP", () => {
  const numbering = [{ id: "205", displayNumber: "205", file: "205-x.md", kind: "Adapter" }];
  const body = "# WISP 205: Pay | split\n\n| Field | Value |\n|---|---|\n| Status | Draft |\n| Availability | Planned |\n";
  const table = wispIndex(numbering, () => body);
  assert.match(table, /^\| 205 \| Payments \| \[Pay \\\| split\]\(205-x\.md\) \| Adapter \| Draft \| Planned \|$/m);
  assert.throws(() => wispIndex(numbering, () => "# WISP 205: x\n\n| Field | Value |\n|---|---|\n| Status | Draft |\n"), /Availability/);
});

test("families follow the number ranges", () => {
  assert.equal(familyOf("00"), "Foundations");
  assert.equal(familyOf("99"), "Foundations");
  assert.equal(familyOf("312"), "Identity");
  assert.equal(familyOf("903"), "Groups");
  assert.equal(familyOf("1100"), "Headless");
});

test("the table goes between the markers, and a README without them fails", () => {
  assert.equal(withIndex(`a\n${START}\nold\n${END}\nb`, "T"), `a\n${START}\n\nT\n\n${END}\nb`);
  assert.throws(() => withIndex("no markers", "T"), /markers/);
});
