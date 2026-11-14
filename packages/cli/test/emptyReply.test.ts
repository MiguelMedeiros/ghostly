import { describe, expect, it } from "vitest";
import { error, ghostly, home } from "./support/cli";

// covers: headless.cli

/**
 * An empty `--reply` or `--chosen` (an unset variable in a script: `ghostly send bob --reply "$ID" …`) is a usage error
 * before anything opens. Taken as not given, `--reply ""` sent a plain message and `button update --close --chosen ""`
 * closed the buttons with no answer shown, both exit 0, where an id the chat lacks is exit 3.
 */
describe("an empty --reply or --chosen", { timeout: 60_000 }, () => {
  it("is a usage error, not a message without its reply or buttons without their answer", async () => {
    const dir = home("empty-reply");
    for (const [args, message] of [
      [["send", "bob", "hi", "--reply", ""], "--reply needs a message id"],
      [["send", "bob", "hi", "--reply="], "--reply needs a message id"],
      [["group", "send", "Crew", "hi", "--reply", ""], "--reply needs a message id"],
      [["file", "send", "bob", "missing.txt", "--reply", ""], "--reply needs a message id"],
      [["button", "update", "bob", "m1", "--close", "--chosen", ""], "--chosen needs a button id"],
      [["button", "update", "bob", "m1", "--chosen", ""], "--chosen needs a button id"],
    ] as const) {
      expect(error(await ghostly(["--home", dir, ...args]), "usage", 2).message, args.join(" ")).toBe(message);
    }
  });
});
