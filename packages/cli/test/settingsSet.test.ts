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
      expect(error(await ghostly(["--home", dir, "settings", "set", name, "5"]), "bad_request", 1).message).toContain(`${name} is not a setting the CLI changes`);
    }
    const shown = ok(await ghostly(["--home", dir, "settings", "get"]));
    for (const name of names) expect(Object.hasOwn(shown, name), name).toBe(false);
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
});
