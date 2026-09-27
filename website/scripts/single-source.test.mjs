import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { siteFields } from "./wisp-header.mjs";
import { roadmapTracks } from "./roadmap-tracks.mjs";
import { singleSourceProblems } from "./check-single-source.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const header = (rows) => `# WISP 999: Example\n\n| Field | Value |\n|---|---|\n| Number | 999 |\n| Status | Draft |\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join("\n")}\n\n## Purpose\n\n| Summary | a table in the body is not the header |\n`;
const full = [
  ["Summary", "Send a thing to a contact."],
  ["Availability", "Available"],
  ["Notes", "Experimental. Desktop only."],
  ["Feature", "[Wallets](https://ghostly.tools/#wallets)"],
];

test("a WISP's header gives the site its line, level, caveat and feature link", () => {
  assert.deepEqual(siteFields(header(full), "999-example.md"), {
    benefit: "Send a thing to a contact.",
    level: "available",
    note: "Experimental. Desktop only.",
    feature: { label: "Wallets", href: "/#wallets" },
  });
  assert.deepEqual(siteFields(header([["Summary", "How WISPs are written."], ["Availability", "Not applicable"]]), "00.md"), {
    benefit: "How WISPs are written.",
    level: null,
  });
});

test("a WISP without the required rows is refused", () => {
  const without = (name) => header(full.filter(([k]) => k !== name));
  assert.throws(() => siteFields(without("Summary"), "999-example.md"), /999-example\.md.*"Summary"/);
  assert.throws(() => siteFields(without("Availability"), "999-example.md"), /"Availability"/);
  assert.throws(() => siteFields(header([["Summary", "x"], ["Availability", "Shipping soon"]]), "f.md"), /one of: Available, Planned, Research/);
  assert.throws(() => siteFields(header([...full, ["Summary", "again"]]), "f.md"), /2 "Summary" rows/);
  assert.throws(() => siteFields(header([["Summary", "See [200](200-payments.md)"], ["Availability", "Planned"]]), "f.md"), /plain text/);
  assert.throws(() => siteFields(header([["Summary", "x"], ["Availability", "Planned"], ["Feature", "[Elsewhere](https://example.com/)"]]), "f.md"), /"Feature"/);
});

test("every WISP of the catalogue has the rows the site reads", () => {
  const numbering = JSON.parse(readFileSync(resolve(root, "docs/wisps/numbering.json"), "utf8"));
  assert.ok(numbering.length > 50);
  for (const { file } of numbering) {
    const fields = siteFields(readFileSync(resolve(root, "docs/wisps", file), "utf8"), file);
    assert.ok(fields.benefit.length > 10, file);
  }
});

const tracks = `# Roadmap\n\n### Tracks\n\nHow to read them.\n\n#### 01 Talk\n\nWhy talk.\n\n- **Available**: Chats\n- **Planned**: Typing\n- **Research**: Tor\n\nGate: Tested.\n\n#### 02 Pay\n\nWhy pay.\n\n- **Planned**: Liquid\n\nGate: Settled.\n\nBuilds on: 01\n\n## Next section\n\n- not a track\n`;

test("the roadmap's tracks are read from the document", () => {
  assert.deepEqual(roadmapTracks(tracks), [
    { n: "01", title: "Talk", why: "Why talk.", gate: "Tested.", after: [], now: [{ text: "Chats", level: "available" }], next: [{ text: "Typing", level: "planned" }, { text: "Tor", level: "research" }] },
    { n: "02", title: "Pay", why: "Why pay.", gate: "Settled.", after: ["01"], now: [], next: [{ text: "Liquid", level: "planned" }] },
  ]);
  assert.throws(() => roadmapTracks(tracks.replace("**Planned**: Typing", "Typing")), /one status in bold/);
  assert.throws(() => roadmapTracks(tracks.replace("**Planned**: Typing", "**Soon**: Typing")), /one status in bold/);
  assert.throws(() => roadmapTracks(tracks.replace("Gate: Settled.\n", "")), /"Gate:"/);
  assert.throws(() => roadmapTracks(tracks.replace("Builds on: 01", "Builds on: 07")), /not a track/);
  assert.throws(() => roadmapTracks("# Roadmap\n"), /Tracks/);
  assert.ok(roadmapTracks(readFileSync(resolve(root, "docs/wisps/ADAPTER-ROADMAP.md"), "utf8")).length >= 9);
});

test("the site holds no WISP content of its own", () => {
  assert.deepEqual(singleSourceProblems(), []);
});

test("the guard sees WISP content written on the site", () => {
  const site = mkdtempSync(join(tmpdir(), "single-source-"));
  try {
    for (const dir of ["lib", "content"]) mkdirSync(join(site, dir));
    writeFileSync(join(site, "lib/wisp-numbering.json"), JSON.stringify([{ file: "202-arkade.md" }]));
    writeFileSync(join(site, "lib/composition.ts"), 'b("arkade", "pay", "Ark", ["202-arkade"], "Pointing at a WISP is fine."),\n');
    assert.deepEqual(singleSourceProblems(site), []);
    writeFileSync(join(site, "lib/notes.ts"), 'export const notes = { "202-arkade": { benefit: "Ark payments" } };\n');
    writeFileSync(join(site, "lib/wisp-editorial.ts"), "export const editorial = {};\n");
    writeFileSync(join(site, "lib/composition.ts"), 'b("arkade", "pay", "Ark", "available", ["202-arkade"], "x"),\n');
    writeFileSync(join(site, "content/roadmap.ts"), 'export const roadmap = { tracks: [{ now: [{ text: "Chats", level: "available" }] }] };\n');
    const problems = singleSourceProblems(site).join("\n");
    assert.match(problems, /lib\/notes\.ts: an entry keyed by WISP "202-arkade"/);
    assert.match(problems, /wisp-editorial\.ts is back/);
    assert.match(problems, /composition\.ts: a block states its own level/);
    assert.match(problems, /content\/roadmap\.ts: roadmap items/);
  } finally {
    rmSync(site, { recursive: true, force: true });
  }
  assert.ok(readdirSync(fileURLToPath(new URL("../lib", import.meta.url))).includes("wisp-groups.ts"));
});
