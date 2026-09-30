import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../public/manifest.json";

// covers: extension.engine, app.i18n

/**
 * The extension's name and description, as Chrome and the Chrome Web Store show them, in the app's 8 languages:
 * `__MSG_…__` in the manifest, one `_locales/<locale>/messages.json` per language (Chrome's folder names, not the
 * app's), copied into the build as they are from public/.
 */
const LOCALES = join(import.meta.dirname, "..", "public", "_locales");
const FOLDERS = ["ar", "en", "es", "fr", "it", "ja", "pt_BR", "zh_CN"];
const KEYS = ["appDescription", "appName", "appShortName"];

type Messages = Record<string, { message: string; description?: string }>;
const messages = (folder: string): Messages => JSON.parse(readFileSync(join(LOCALES, folder, "messages.json"), "utf8"));

describe("the manifest's words, in every language the app ships", () => {
  it("names, shortens and describes the extension through _locales, English by default", () => {
    expect(manifest.default_locale).toBe("en");
    expect(manifest.name).toBe("__MSG_appName__");
    expect(manifest.short_name).toBe("__MSG_appShortName__");
    expect(manifest.description).toBe("__MSG_appDescription__");
  });

  it("has one folder per app language, and no other", () => {
    expect(readdirSync(LOCALES).sort()).toEqual(FOLDERS);
    for (const folder of FOLDERS) expect(existsSync(join(LOCALES, folder, "messages.json"))).toBe(true);
  });

  it("keeps the English words the store has shown so far", () => {
    const en = messages("en");
    expect(en.appName.message).toBe("Ghostly");
    expect(en.appShortName.message).toBe("Ghostly");
    expect(en.appDescription.message).toBe("Your services exist while you are online. Ephemeral, identity-addressed peer-to-peer chat and local web apps over WebRTC.");
  });

  it.each(FOLDERS)("%s has every key, filled, within Chrome's limits", (folder) => {
    const words = messages(folder);
    expect(Object.keys(words).sort()).toEqual(KEYS);
    for (const key of KEYS) expect(words[key].message.trim()).not.toBe("");
    expect(words.appName.message).toBe("Ghostly");
    expect(words.appShortName.message.length).toBeLessThanOrEqual(12);
    expect(words.appDescription.message.length).toBeLessThanOrEqual(132);
    if (folder !== "en") expect(words.appDescription.message).not.toBe(messages("en").appDescription.message);
  });
});
