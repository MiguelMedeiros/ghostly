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

  // `send bob --stdin < big.log` read it all first: 1 GiB took 3 GB and answered V8's "Cannot create a string longer
  // than 0x1fffffe8 characters", 128 MiB to `settings set nick -` ran the CLI out of memory, and past 16 MiB a daemon
  // cut the line, answered "The daemon went away".
  it("more than a daemon's request line on stdin is refused before the profile opens", { timeout: 60_000 }, async () => {
    const dir = home("stdin-bound");
    const most = 16 * 1024 * 1024;
    const refusal = { error: { code: "bad_request", message: "More than 16 MiB came on stdin, more than any command takes (a long text goes as a file: ghostly file send <chat|group> <path>)" } };
    for (const args of [["send", "bob", "--stdin"], ["group", "send", "Crew"], ["settings", "set", "nick", "-"], ["engine", "getState", "-"]]) {
      const result = await ghostly(["--home", dir, ...args], { input: "a".repeat(most + 1) });
      expect(result.json, args.join(" ")).toEqual(refusal);
      expect(result.code, args.join(" ")).toBe(1);
    }
    // 16 MiB itself is read: what answers is the command's own check.
    expect((await ghostly(["--home", dir, "settings", "set", "nick", "-"], { input: "a".repeat(most) })).json).not.toEqual(refusal);
  });
});
