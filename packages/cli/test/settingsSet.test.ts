import { describe, expect, it } from "vitest";
import { ghostly, home, ok } from "./support/cli";
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
});
