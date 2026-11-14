import { describe, expect, it } from "vitest";
import { SETTABLE } from "../src/api";
import { SPECIAL } from "../src/main";
import { ghostly, home, ok, type Result } from "./support/cli";
// covers: headless.cli

/** `--pretty` prints the JSON over several lines: the whole output is the answer. */
const pretty = (result: Result) => { ok(result); return JSON.parse(result.stdout) as Record<string, unknown>; };

/**
 * `settings get` answered the settings as the engine keeps them, and the engine keeps an on-by-default switch only
 * while it is off (node.ts `updateSettings` deletes `sendTyping: true`): a switch that is on was never shown, and a
 * fresh profile showed 4 of the 11 keys `settings set` takes. It now shows each of them with its value in effect.
 */
describe("settings get", () => {
  it("names every key settings set takes, and only those are what settings set's help lists", () => {
    // One table (api.ts SETTABLE) says what `settings set` takes and what `settings get` fills in; the help says it too.
    const help = SPECIAL.find(([usage]) => usage.startsWith("settings set "))![1];
    const listed = /^Change one: ([^.]+)\./.exec(help)![1].split(", ");
    expect([...listed].sort()).toEqual(Object.keys(SETTABLE).sort());
  });

  it("shows each key settings set takes on a fresh profile, a switch that is on and the default relays included", { timeout: 60_000 }, async () => {
    const dir = home("settings-get-fresh");
    const shown = ok(await ghostly(["--home", dir, "settings", "get"]));
    expect(Object.keys(SETTABLE).filter((key) => !Object.hasOwn(shown, key))).toEqual([]);
    expect(shown).toMatchObject({ sendTyping: true, autoDownloads: true, serveFiles: true, shareProfile: true, publicProfiles: true, daemonPresence: false, hyperdhtRelay: "" });
    expect(Array.isArray(shown.irohRelays) && shown.irohRelays.length > 0).toBe(true);
    expect(pretty(await ghostly(["--home", dir, "--pretty", "settings", "get"]))).toEqual(shown);
  });

  it("shows each key with the value settings set gave it, a switch turned back on included", { timeout: 180_000 }, async () => {
    const dir = home("settings-get-each");
    const values: [key: string, value: unknown][] = [
      ["relays", ["http://127.0.0.1:9"]],
      ["irohRelays", ["https://iroh.example.org"]],
      ["hyperdhtRelay", "wss://relay.example.org"],
      ["iceServers", [{ urls: "stun:stun.example.org:3478" }]],
      ["nick", "Bot"],
      ...["publicProfiles", "online", "shareProfile", "sendTyping", "autoDownloads", "serveFiles"].flatMap((key) => [[key, false], [key, true]] as [string, boolean][]),
      // Off by default: turned on, then back off.
      ["daemonPresence", true], ["daemonPresence", false],
    ];
    // Each key of the table is set at least once.
    expect([...new Set(values.map(([key]) => key))].sort()).toEqual(Object.keys(SETTABLE).sort());
    for (const [key, value] of values) {
      const set = ok(await ghostly(["--home", dir, "settings", "set", key, JSON.stringify(value)]));
      expect(set[key], `settings set ${key}`).toEqual(value);
      const shown = ok(await ghostly(["--home", dir, "settings", "get"]));
      expect(shown[key], `settings get after ${key} ${JSON.stringify(value)}`).toEqual(value);
      expect(pretty(await ghostly(["--home", dir, "--pretty", "settings", "get"]))[key], `settings get --pretty after ${key}`).toEqual(value);
      expect(set).toEqual(shown);
    }
  });
});
