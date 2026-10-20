import { describe, expect, it } from "vitest";
import { TEXT_COMMANDS } from "../src/commands";
import { ghostly, home } from "./support/cli";
// covers: headless.cli

/** Where `send`, `edit`, `group send` and `group edit` take their text from when stdin is not a terminal. */
describe("text from stdin", () => {
  it("an empty text argument is no text, not a cue to read stdin", async () => {
    // `while read line; do ghostly send bob "$line"; done < file`: an empty line sent the rest of the file as one message.
    const dir = home("empty-text");
    for (const [name, args] of [
      ["send", ["send", "bob", ""]],
      ["edit", ["edit", "bob", "me_w", ""]],
      ["group send", ["group", "send", "Crew", ""]],
      ["group edit", ["group", "edit", "Crew", "mekey:1:0", ""]],
    ] as const) {
      const result = await ghostly(["--home", dir, ...args], { input: "line three\nline four\n" });
      expect(result.code, name).toBe(2);
      expect(result.json, name).toEqual({ error: { code: "usage", message: `No text: ghostly ${TEXT_COMMANDS[name].usage}` } });
    }
  });
});
