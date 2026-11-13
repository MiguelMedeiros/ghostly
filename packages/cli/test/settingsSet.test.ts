import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";
// covers: headless.cli

/**
 * `settings set <key> <value>` reads the value as JSON, and the word itself when it is not JSON. A nick is text: a word
 * that also reads as JSON (2024, true, null) was a number or a boolean and refused, while `nick Bob` went through.
 */
describe("settings set", () => {
  it("takes a nick as the word given, also one that reads as JSON", { timeout: 60_000 }, async () => {
    const dir = home("settings-nick");
    const nick = async (value: string) => ok(await ghostly(["--home", dir, "settings", "set", "nick", value])).nick;
    expect(await nick("Bob")).toBe("Bob");
    for (const word of ["2024", "true", "false", "null", "007"]) expect(await nick(word)).toBe(word);
    // Quoted as JSON, it is the text inside the quotes, as before.
    expect(await nick('"2024"')).toBe("2024");
  });

  it("refuses a name every object has (constructor, toString), and stores nothing under it", { timeout: 60_000 }, async () => {
    // `settings set constructor 5` answered with the settings, `"constructor":5` among them, and kept it for good.
    const dir = home("settings-own-names");
    const names = ["constructor", "toString", "hasOwnProperty"];
    for (const name of names) {
      expect(error(await ghostly(["--home", dir, "settings", "set", name, "5"]), "usage", 2).message).toContain(`${name} is not a setting the CLI changes`);
    }
    const shown = ok(await ghostly(["--home", dir, "settings", "get"]));
    for (const name of names) expect(Object.hasOwn(shown, name), name).toBe(false);
  });

  it("refuses an unknown key or a value of the wrong kind as a usage error, before the profile opens", { timeout: 60_000 }, async () => {
    // Both opened the profile, asked the Pkarr relays, then answered bad_request (exit 1) with no "did you mean".
    const dir = home("settings-usage");
    const keys = "relays, irohRelays, hyperdhtRelay, iceServers, publicProfiles, online, shareProfile, sendTyping, nick, autoDownloads, serveFiles, daemonPresence";
    const usage = (args: string[]) => ghostly(["--home", dir, "settings", "set", ...args]);
    expect(error(await usage(["sendtyping", "false"]), "usage", 2).message).toBe(`sendtyping is not a setting the CLI changes (did you mean sendTyping?): ghostly settings set takes ${keys} (ghostly help settings set)`);
    expect(error(await usage(["SENDTYPING", "false"]), "usage", 2).message).toContain("(did you mean sendTyping?)");
    expect(error(await usage(["nothing", "false"]), "usage", 2).message).toBe(`nothing is not a setting the CLI changes: ghostly settings set takes ${keys} (ghostly help settings set)`);
    // Before stdin is read: the key alone is wrong.
    expect(error(await ghostly(["--home", dir, "settings", "set", "sendtyping", "-"], { input: "false\n" }), "usage", 2).message).toContain("did you mean sendTyping?");
    const settings = "ghostly settings set <key> <json-value> [--force]";
    expect(error(await usage(["online", "maybe"]), "usage", 2).message).toBe(`online takes true or false, not "maybe": ${settings}`);
    expect(error(await usage(["online", "1"]), "usage", 2).message).toBe(`online takes true or false, not "1": ${settings}`);
    expect(error(await usage(["relays", "wss://relay.example"]), "usage", 2).message).toBe(`relays takes a JSON list of strings: ${settings}`);
    expect(error(await usage(["iceServers", "[1]"]), "usage", 2).message).toBe(`iceServers takes a JSON list of ICE servers: ${settings}`);
    // Nothing was made of the home: the profile never opened.
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it("says a TURN server the CLI does not use on stderr: stdout holds the settings alone", { timeout: 60_000 }, async () => {
    // The warning was a `warning` key of the settings JSON, with nothing on stderr.
    const dir = home("settings-ice-warning");
    const servers = [{ urls: "turns:turn.example:5349", username: "u", credential: "c" }];
    const result = await ghostly(["--home", dir, "settings", "set", "iceServers", JSON.stringify(servers)]);
    const set = ok(result);
    expect(Object.hasOwn(set, "warning")).toBe(false);
    expect(result.stderr).toContain("ghostly: The CLI reaches TURN over UDP only: it does not use turns:turn.example:5349");
    expect(set).toEqual(ok(await ghostly(["--home", dir, "settings", "get"])));
  });

  it("refuses a HyperDHT relay with a login or a token, which every contact would be told, and keeps none", { timeout: 60_000 }, async () => {
    const dir = home("settings-hyperdht-relay");
    for (const bad of ["wss://alice:hunter2@relay.example", "wss://relay.example/?token=s3cr3t", "wss://relay.example/#s3cr3t"]) {
      expect(error(await ghostly(["--home", dir, "settings", "set", "hyperdhtRelay", bad]), "bad_request", 1).message).toBe(`hyperdhtRelay: not a relay address: ${bad}`);
    }
    // None kept: the default (none) is what `settings get` shows.
    expect(ok(await ghostly(["--home", dir, "settings", "get"])).hyperdhtRelay).toBe("");
    expect(ok(await ghostly(["--home", dir, "settings", "set", "hyperdhtRelay", "wss://relay.example"])).hyperdhtRelay).toBe("wss://relay.example");
  });
});
