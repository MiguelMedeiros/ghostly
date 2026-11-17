import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (file) => readFileSync(resolve(root, file), "utf8");

// The pages that say what groups and calls do: the home cards, /developers' notes and the composition map.
const PAGES = ["apps/website/content/home.ts", "apps/website/content/developers.ts", "apps/website/lib/composition.ts"];

test("while a group's header has Join call, no page says groups have no calls", () => {
  assert.match(read("apps/ui/src/pages/GroupChat.tsx"), /<GroupCallButton\b/, "the group header mounts GroupCallButton");
  const stale = PAGES.flatMap((file) =>
    [...read(file).matchAll(/[^."]*\b(?:no (?:group )?calls|not in groups)\b[^."]*/gi)].map((m) => `${file}: ${m[0].trim()}`),
  );
  assert.deepEqual(stale, []);
});

test("where the site names group calls, it names the Linux desktop app, which cannot join them", () => {
  assert.match(read("apps/ui/src/desktop/groupCallSupport.ts"), /GROUP_CALLS_NOT_ON_LINUX/, "groupCallSupport refuses the Linux Desktop");
  for (const file of PAGES) {
    const said = [...read(file).matchAll(/[^"]*\bgroup calls?\b[^"]*/gi)].map((m) => m[0]);
    assert.ok(said.length > 0, `${file} says what group calls do`);
    for (const text of said) assert.match(text, /\bLinux\b/, `${file}: ${text.slice(0, 80)}`);
  }
});
