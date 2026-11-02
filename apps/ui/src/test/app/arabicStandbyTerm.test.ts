import { describe, expect, it } from "vitest";

// covers: app.i18n

/*
 * A device on standby is ready, not pending. Arabic names that state "وضع الاستعداد" everywhere: the devices list,
 * the standby screen, Add a device and the profile switcher. "انتظار" is kept for lines that really wait on
 * something ("في انتظار جهازك الآخر…"); a row reading "في الانتظار" looks like it is still waiting.
 */

const english = import.meta.glob<Record<string, unknown>>("../../locales/en/*.json", { eager: true, import: "default" });
const arabic = import.meta.glob<Record<string, unknown>>("../../locales/ar/*.json", { eager: true, import: "default" });

const strings = (value: unknown, path: string): [string, string][] => {
  if (typeof value === "string") return [[path, value]];
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, inner]) => strings(inner, path ? `${path}.${key}` : key));
  return [];
};

const flat = (files: Record<string, Record<string, unknown>>) =>
  new Map(Object.entries(files).flatMap(([file, json]) => strings(json, file.replace(/^.*\/(\w+)\.json$/, "$1"))));

const en = flat(english);
const ar = flat(arabic);
const standby = [...en].filter(([, text]) => /\bstandby\b/i.test(text)).map(([key]) => key);

describe("Arabic names standby one way", () => {
  it("finds the standby strings", () => {
    expect(standby).toEqual(expect.arrayContaining(["devices.section.standby", "devices.section.thisStandby", "devices.add.done", "devices.standby.hint.standby", "profileSwitcher.standby"]));
  });

  it("says وضع الاستعداد, never انتظار, where English says standby", () => {
    const wrong = standby.map((key) => [key, ar.get(key) ?? ""] as const).filter(([, text]) => !text.includes("الاستعداد") || text.includes("انتظار"));
    expect(wrong.map(([key, text]) => `${key}: ${text}`)).toEqual([]);
  });
});
