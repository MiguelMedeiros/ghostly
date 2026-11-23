import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { headerRows } from "./wisp-header.mjs";
import { roadmapTracks } from "./roadmap-tracks.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const file = (path) => readFileSync(resolve(root, path), "utf8");

// The pages that say what groups and calls do: the home cards, /developers' notes and the composition map.
const CONTENT = ["apps/website/content/home.ts", "apps/website/content/developers.ts", "apps/website/lib/composition.ts"];
// And the documents the site renders or links for them: the WISPs' headers and the chat guide's group section.
const PAGES = [...CONTENT, "docs/wisps/602-group-calls.md", "docs/wisps/600-media.md", "docs/CHAT.md"];

/** What a page says about groups: a WISP's header (the site shows it), CHAT.md's group section, a content file whole. */
function read(path) {
  const text = file(path);
  if (path.startsWith("docs/wisps/")) return headerRows(text).map((row) => row.join(" | ")).join("\n");
  if (path === "docs/CHAT.md") return text.slice(text.indexOf("### Files and voice messages in a group")).split(/\n#{2,3} /)[0];
  return text;
}

test("while a group's header has Join call, no page says groups have no calls", () => {
  assert.match(read("apps/ui/src/pages/GroupChat.tsx"), /<GroupCallButton\b/, "the group header mounts GroupCallButton");
  const stale = PAGES.flatMap((file) =>
    [...read(file).matchAll(/[^."|]*\b(?:no (?:group )?calls|not in groups)\b[^."|]*/gi)].map((m) => `${file}: ${m[0].trim()}`),
  );
  assert.deepEqual(stale, []);
});

test("/roadmap shows calls in communities as available and plans only calls in private groups", () => {
  const items = roadmapTracks(file("docs/wisps/ADAPTER-ROADMAP.md")).flatMap((t) => [...t.now, ...t.next]);
  const calls = items.filter((i) => /\bcalls?\b/i.test(i.text) && /\b(?:groups?|communit(?:y|ies))\b/i.test(i.text));
  assert.ok(calls.some((i) => i.level === "available" && /\bcommunities\b/i.test(i.text) && /\b1\.12\b/.test(i.text)), "no Available item for calls in communities since 1.12");
  for (const i of calls.filter((i) => i.level !== "available")) assert.match(i.text, /\bprivate groups?\b/i, `${i.level}: ${i.text}`);
});

test("the roadmap's inventory rows have calls in communities since 1.12, not from Linux or the CLI, and calls in private groups next", () => {
  const row = (name) => file("docs/wisps/ADAPTER-ROADMAP.md").split("\n").find((line) => line.startsWith(`| ${name}`));
  const sentence = (text, start) => text.split(/(?<=\.)\s/).find((s) => s.startsWith(start)) ?? "";
  const media = row("Voice/video");
  assert.match(sentence(media, "Group calls in communities since 1.12"), /\bLinux\b.*\bCLI\b/, "Voice/video row");
  assert.match(media, /Private groups have no calls/, "Voice/video row");
  const groups = row("Private groups");
  assert.match(groups, /Calls in communities since 1\.12/, "Private groups row");
  assert.match(sentence(groups, "Next:"), /\bcalls in private groups\b/, "Private groups row");
});

test("WISP 602's header says group calls are built and available", () => {
  const header = Object.fromEntries(headerRows(file("docs/wisps/602-group-calls.md")));
  assert.equal(header.Availability, "Available");
  assert.doesNotMatch(header.Implementation, /not built/i);
});

test("where the site says what group calls do, the same sentence names the Linux desktop app and the CLI, which cannot join them", () => {
  assert.match(read("apps/ui/src/desktop/groupCallSupport.ts"), /GROUP_CALLS_NOT_ON_LINUX/, "groupCallSupport refuses the Linux Desktop");
  for (const file of CONTENT) {
    // One sentence of one string at a time, so another string's "CLI" does not count. The plural only: "(group call --sfu)" is the CLI command, not a claim about who joins.
    const said = read(file).split(/(?<=\.)\s|"/).filter((s) => /\bgroup calls\b/i.test(s));
    assert.ok(said.length > 0, `${file} says what group calls do`);
    for (const s of said) {
      assert.match(s, /\bLinux\b/, `${file}: ${s.slice(0, 80)}`);
      assert.match(s, /\bCLI\b/, `${file}: ${s.slice(0, 80)}`);
    }
  }
});

test("who joins a group call is named app by app, and the CLI is not one of them", () => {
  assert.doesNotMatch(read("packages/cli/src/commands/groups.ts"), /joinGroupCall|GroupCallButton/, "the CLI has no group call media");
  for (const file of PAGES) {
    const text = read(file);
    assert.doesNotMatch(text, /joined from anywhere/i, `${file} says group calls are joined from anywhere`);
    for (const [sentence] of text.matchAll(/[^."|]*\bjoined from\b[^."|]*/gi)) {
      assert.match(sentence, /\bCLI\b/, `${file}: "${sentence.trim().slice(0, 100)}" does not say the CLI cannot join`);
      for (const app of ["web app", "extension", "Android", "macOS", "Windows"]) assert.ok(sentence.includes(app), `${file}: "${sentence.trim().slice(0, 100)}" does not name ${app}`);
    }
  }
});
