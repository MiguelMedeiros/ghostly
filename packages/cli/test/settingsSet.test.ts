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
    expect(error(await usage(["relays", "wss://relay.example"]), "usage", 2).message).toBe(`relays takes a JSON list of strings, like '["https://relay.example.org"]': ${settings}`);
    const ice = `iceServers takes a JSON list of ICE servers, each an object, like '[{"urls":"stun:stun.example.org:3478"}]' (a TURN one also has "username" and "credential"): ${settings}`;
    expect(error(await usage(["iceServers", "[1]"]), "usage", 2).message).toBe(ice);
    // A list of addresses, as relays takes, or one server alone: the refusal shows the shape. Before, both read "takes a
    // JSON list of ICE servers" to a person who had just given a list of them.
    expect(error(await usage(["iceServers", '["stun:127.0.0.1:3478"]']), "usage", 2).message).toBe(ice);
    expect(error(await usage(["iceServers", '{"urls":"stun:127.0.0.1:3478"}']), "usage", 2).message).toBe(ice);
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
    // The address is named without its user and password, which bots would log from stderr.
    const login = [{ urls: "turns:user:s3cr3t@turn.example:5349", username: "u", credential: "c" }];
    const said = await ghostly(["--home", dir, "settings", "set", "iceServers", "-"], { input: JSON.stringify(login) });
    ok(said);
    expect(said.stderr).toContain("it does not use turns:turn.example:5349");
    expect(said.stderr).not.toContain("s3cr3t");
  });

  it("refuses a HyperDHT relay with a login or a token, which every contact would be told, and keeps none", { timeout: 60_000 }, async () => {
    const dir = home("settings-hyperdht-relay");
    for (const bad of ["wss://alice:hunter2@relay.example", "wss://relay.example/?token=s3cr3t", "wss://relay.example/#s3cr3t"]) {
      // The refusal names the relay without its login, password, query or fragment.
      const { message } = error(await ghostly(["--home", dir, "settings", "set", "hyperdhtRelay", bad]), "bad_request", 1);
      expect(message).toMatch(/^hyperdhtRelay: not a relay address: wss:\/\/relay\.example\/?$/);
      expect(message).not.toMatch(/alice|hunter2|s3cr3t/);
    }
    // None kept: the default (none) is what `settings get` shows.
    expect(ok(await ghostly(["--home", dir, "settings", "get"])).hyperdhtRelay).toBe("");
    expect(ok(await ghostly(["--home", dir, "settings", "set", "hyperdhtRelay", "wss://relay.example"])).hyperdhtRelay).toBe("wss://relay.example");
  });

  it("says on stderr that the CLI's own HyperDHT does not dial through the HyperDHT relay it keeps", { timeout: 60_000 }, async () => {
    // It answered ok and showed the relay as in effect, while the CLI kept dialling HyperDHT from its own address.
    const dir = home("settings-hyperdht-relay-unused");
    const result = await ghostly(["--home", dir, "settings", "set", "hyperdhtRelay", "wss://relay.example"]);
    const set = ok(result);
    expect(set.hyperdhtRelay).toBe("wss://relay.example");
    expect(Object.hasOwn(set, "warning")).toBe(false);
    expect(result.stderr).toContain("ghostly: This CLI runs HyperDHT itself and does not dial through hyperdhtRelay");
    // Clearing it says nothing.
    expect((await ghostly(["--home", dir, "settings", "set", "hyperdhtRelay", '""'])).stderr).not.toContain("hyperdhtRelay");
  });

  it("says on stderr that GHOSTLY_PKARR_RELAYS or GHOSTLY_IROH_RELAYS pins the relays, and keeps the setting", { timeout: 60_000 }, async () => {
    // Taken with exit 0 and nothing said, while `status` went on naming the variable's relays (every test runs pinned).
    const dir = home("settings-relays-pinned");
    const relays = await ghostly(["--home", dir, "settings", "set", "relays", '["https://relay.example"]']);
    expect(ok(relays).relays).toEqual(["https://relay.example"]);
    expect(Object.hasOwn(relays.json, "warning")).toBe(false);
    expect(relays.stderr).toContain("ghostly: GHOSTLY_PKARR_RELAYS is set where this profile runs, and only its relays are used: relays is kept for when the profile runs without it");
    const iroh = await ghostly(["--home", dir, "settings", "set", "irohRelays", '["https://iroh.example/"]']);
    expect(ok(iroh).irohRelays).toEqual(["https://iroh.example/"]);
    expect(iroh.stderr).toContain("ghostly: GHOSTLY_IROH_RELAYS is set where this profile runs, and only its relays are used: irohRelays is kept for when the profile runs without it");
    // Another key says nothing of them.
    const other = await ghostly(["--home", dir, "settings", "set", "sendTyping", "false"]);
    expect(ok(other).sendTyping).toBe(false);
    expect(other.stderr).not.toContain("GHOSTLY_");
  });
});
