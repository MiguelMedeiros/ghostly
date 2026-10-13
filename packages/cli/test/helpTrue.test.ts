import { describe, expect, it } from "vitest";
import { globalOption, liftGlobals, parseArgs } from "../src/args";
import { helpAsked } from "../src/main";
// covers: headless.cli

/** `--help=true` asks for help as `--help` does; a global boolean's `--no-` form is lifted as the option itself. */
describe("help and global booleans, in every form the parser reads", () => {
  it("`--help=true` is help, not the command; `--help=false` is the command", () => {
    // Before, only the words --help and -h were help: `status --help=true` printed the status, and
    // `chat remove <chat> --yes --help=true` removed the chat.
    expect(helpAsked(["status", "--help=true"])).toEqual(["status"]);
    expect(helpAsked(["chat", "remove", "bob", "--yes", "--help=true"])).toEqual(["chat", "remove", "bob"]);
    expect(helpAsked(liftGlobals(["--help=true", "chat", "remove", "bob", "--yes"]))).toEqual(["chat", "remove", "bob"]);
    expect(helpAsked(["status", "--help"])).toEqual(["status"]);
    expect(helpAsked(["status", "--help=false"])).toBeNull();
    expect(parseArgs(["--help=false"], {}).options).toEqual({ help: false });
    // After `--` it is text.
    expect(helpAsked(["send", "bob", "--", "--help=true"])).toBeNull();
  });

  it("`--no-pretty` before the command is lifted after it, as `--pretty` is", () => {
    expect(globalOption("--no-pretty")).toMatchObject({ type: "boolean" });
    expect(liftGlobals(["--no-pretty", "status"])).toEqual(["status", "--no-pretty"]);
    expect(liftGlobals(["--pretty", "--no-pretty", "-p", "bot", "chat", "list"])).toEqual(["chat", "list", "--pretty", "--no-pretty", "-p", "bot"]);
    expect(parseArgs(liftGlobals(["--no-pretty", "status"]).slice(1), {}).options).toEqual({ pretty: false });
    // Only a boolean has a `--no-` form, and it takes no value.
    expect(globalOption("--no-profile")).toBeUndefined();
    expect(globalOption("--no-pretty=true")).toBeUndefined();
    expect(globalOption("--no-constructor")).toBeUndefined();
  });
});
