import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkLocales } from "../locales-sort.mjs";

// guards: #8398

/**
 * `npm run locales:sort -- --check` (CI's lint job) fails on what reads the locale files alone: a key out of order, a
 * European-Portuguese word in the app's Brazilian Portuguese, Arabic standby said as waiting. Each line names the file
 * and the key.
 */
const root = resolve(import.meta.dirname, "../../..");
const LOCALES = join(root, "apps/ui/src/locales");

/** A copy of the locale files with `edit` applied to `<language>/<file>`'s JSON text. */
function copyWith(file: string, edit: (text: string) => string) {
  const dir = mkdtempSync(join(tmpdir(), "locales-"));
  cpSync(LOCALES, dir, { recursive: true, filter: (path) => !/\.(ts|tsx)$/.test(path) });
  writeFileSync(join(dir, file), edit(readFileSync(join(dir, file), "utf8")));
  return dir;
}

describe("npm run locales:sort -- --check", () => {
  it("passes on the app's locale files and writes nothing", () => {
    const result = spawnSync(process.execPath, ["tools/scripts/locales-sort.mjs", "--check"], { cwd: root, encoding: "utf8", timeout: 60_000 });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("names the file and the key out of order", () => {
    const dir = copyWith("en/common.json", (text) => text.replace("{\n", '{\n  "zzz": "Last",\n'));
    expect(checkLocales(dir)).toEqual(["en/common.json: common.zzz before anonymous: out of order (npm run locales:sort)"]);
  });

  it("names a file written otherwise, sorted", () => {
    const dir = copyWith("fr/common.json", (text) => text.trimEnd());
    expect(checkLocales(dir)).toEqual([expect.stringMatching(/^fr\/common\.json:\d+: not written as npm run locales:sort writes it$/)]);
  });

  it.each([
    ["Cancelar o ficheiro", "ficheiro"],
    ["A tentar de novo", "a + infinitive for an ongoing action"],
    ["Partilhar", "partilhar for share"],
  ])("names a European-Portuguese word: %s", (text, form) => {
    const dir = copyWith("pt/common.json", (json) => json.replace('"cancel": "Cancelar"', `"cancel": "${text}"`));
    expect(checkLocales(dir)).toEqual([`pt/common.json: common.cancel: European Portuguese (${form}), the app's is Brazilian: ${text}`]);
  });

  it("names Arabic standby said as waiting", () => {
    const dir = copyWith("ar/profileSwitcher.json", (json) => json.replace('"standby": "وضع الاستعداد"', '"standby": "في الانتظار"'));
    expect(checkLocales(dir)).toEqual(["ar/profileSwitcher.json: profileSwitcher.standby: says standby as وضع الاستعداد, never انتظار: في الانتظار"]);
  });

  it("fails when English no longer says standby where the check looks", () => {
    const dir = copyWith("en/profileSwitcher.json", (json) => json.replace(/"standby": "[^"]*"/, '"standby": "Ready"'));
    expect(checkLocales(dir)).toEqual(["en: profileSwitcher.standby: no longer says standby (locales-sort.mjs STANDBY_KEYS)"]);
  });
});
