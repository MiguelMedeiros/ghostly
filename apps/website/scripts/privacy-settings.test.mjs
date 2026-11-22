import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (file) => readFileSync(resolve(root, file), "utf8");

/** A translation key's English text: "settings.media.title" is settings.json's media.title. */
function english(key) {
  const [file, ...path] = key.split(".");
  const strings = JSON.parse(read({ settings: "apps/ui/src/locales/en/settings.json", network: "apps/ui/src/locales/en/network.json" }[file]));
  return path.reduce((at, part) => at?.[part], strings);
}

/** The names of the app's Settings sections, as its menu shows them (SECTION_TITLE in settingsSections.ts). */
function sections() {
  const map = read("apps/ui/src/lib/settingsSections.ts").match(/SECTION_TITLE[^=]*=\s*\{([\s\S]*?)\};/);
  assert.ok(map, "SECTION_TITLE is in apps/ui/src/lib/settingsSections.ts");
  return [...map[1].matchAll(/\w+:\s*"([^"]+)"/g)].map((m) => {
    const name = english(m[1]);
    assert.ok(typeof name === "string", `${m[1]} has an English text`);
    return name;
  });
}

test("every Settings path the privacy page gives starts with a section the app's Settings menu has", () => {
  const names = sections();
  assert.ok(names.includes("Network"), `the sections read: ${names.join(", ")}`);
  const text = read("apps/website/app/privacy/page.tsx").replace(/\s+/g, " ").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const paths = [...text.matchAll(/\bSettings, ([^.]*)/g)].map((m) => m[1]);
  assert.ok(paths.length >= 4, "the page gives its Settings paths as \"Settings, <section>, ...\"");
  const lost = paths.filter((path) => !names.some((name) => path.startsWith(name))).map((path) => `Settings, ${path.slice(0, 60)}`);
  assert.deepEqual(lost, [], `these name no section of Settings (${names.join(", ")})`);
});
