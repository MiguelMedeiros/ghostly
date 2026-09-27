import { describe, expect, it } from "vitest";
import { liftGlobals, parseArgs } from "../src/args";
import { positionals, COMMANDS } from "../src/commands";
import { asCliError, CliError, EXIT } from "../src/errors";
// covers: headless.cli

/** Base64url values start with "-" one time in 64 (the #208 lesson): fixed ones, never random. */
const HYPHEN_KEY = "-Abc_def-123";

describe("the argument parser", () => {
  it("takes an option's value as is, even when it starts with a dash", () => {
    const parsed = parseArgs(["--label", HYPHEN_KEY, "--limit=5", "chat1"], { label: { type: "string", description: "" }, limit: { type: "number", description: "" } });
    expect(parsed).toEqual({ positionals: ["chat1"], options: { label: HYPHEN_KEY, limit: 5 } });
    expect(parseArgs([`--label=${HYPHEN_KEY}`], { label: { type: "string", description: "" } }).options.label).toBe(HYPHEN_KEY);
  });

  it("refuses a positional that starts with a dash, unless it comes after --", () => {
    expect(() => parseArgs(["chat", "-oops"], {})).toThrow(/Unknown option -oops/);
    expect(parseArgs(["--profile", "bot", "--", "chat", "-a dash"], {})).toEqual({ positionals: ["chat", "-a dash"], options: { profile: "bot" } });
  });

  it("lets --voice stand alone, taking the next word only when it is a number", () => {
    const { options } = COMMANDS["file send"]!;
    expect(parseArgs(["alice", "note.webm", "--voice"], options!)).toEqual({ positionals: ["alice", "note.webm"], options: { voice: true } });
    expect(parseArgs(["alice", "--voice", "note.webm"], options!)).toEqual({ positionals: ["alice", "note.webm"], options: { voice: true } });
    expect(parseArgs(["alice", "note.webm", "--voice", "4200"], options!).options).toEqual({ voice: 4200 });
    expect(parseArgs(["alice", "note.webm", "--voice=4200", "--name", "hi.webm"], options!).options).toEqual({ voice: 4200, name: "hi.webm" });
    expect(parseArgs(["alice", "note.webm", "--voice", "--name", "hi.webm"], options!).options).toEqual({ voice: true, name: "hi.webm" });
    expect(() => parseArgs(["--voice=soon"], options!)).toThrow(/takes a number/);
  });

  it("knows booleans, --no-, short options, lists and global options anywhere", () => {
    const spec = { force: { type: "boolean" as const, description: "" }, mention: { type: "list" as const, description: "" } };
    expect(parseArgs(["-p", "bot", "g", "--mention", "a", "--no-force", "--mention", "b", "--pretty"], spec).options).toEqual({ profile: "bot", mention: ["a", "b"], force: false, pretty: true });
    expect(() => parseArgs(["--force=maybe"], spec)).toThrow(CliError);
    expect(() => parseArgs(["--nope"], spec)).toThrow(/Unknown option --nope/);
    expect(() => parseArgs(["--mention"], spec)).toThrow(/needs a value/);
    expect(() => parseArgs(["--limit", "ten"], { limit: { type: "number", description: "" } })).toThrow(/takes a number/);
  });

  it("moves global options given before the command after it", () => {
    expect(liftGlobals(["--home", "/h", "-p", "bot", "--pretty", "send", "c", "hi"])).toEqual(["send", "c", "hi", "--home", "/h", "-p", "bot", "--pretty"]);
    expect(liftGlobals(["--profile=bot", "chat", "list"])).toEqual(["chat", "list", "--profile=bot"]);
    expect(liftGlobals(["send", "--home", "/h"])).toEqual(["send", "--home", "/h"]);
    expect(liftGlobals(["--home", "/h", "send", "c", "--", "-dash"])).toEqual(["send", "c", "--home", "/h", "--", "-dash"]);
  });

  it("names positionals, joins a trailing one, and says what is missing", () => {
    expect(positionals(COMMANDS["chat rename"], ["abc", "My", "bot"])).toEqual({ chat: "abc", name: "My bot" });
    expect(positionals(COMMANDS["chat rename"], ["abc"])).toEqual({ chat: "abc", name: undefined });
    expect(COMMANDS["file resend"].params!({ positionals: [], options: {} }, positionals(COMMANDS["file resend"], ["c1-out-x"]))).toEqual({ file: "c1-out-x", action: "resend" });
    expect(COMMANDS["file request"].params!({ positionals: [], options: {} }, positionals(COMMANDS["file request"], ["c1-in-y"]))).toEqual({ file: "c1-in-y", action: "request" });
    expect(() => positionals(COMMANDS["message delete"], ["abc"])).toThrow(/Missing <message>/);
    expect(() => positionals(COMMANDS["chat show"], ["a", "b"])).toThrow(/Too many/);
  });
});

describe("errors", () => {
  it("map to exit codes a bot can branch on", () => {
    expect(EXIT).toMatchObject({ engine: 1, usage: 2, not_found: 3, timeout: 4, confirm: 5 });
    expect(asCliError(new Error("A Mainnet payment needs you to confirm it as real money")).code).toBe("confirm");
    expect(asCliError(new Error("boom")).toJSON()).toEqual({ code: "engine", message: "boom" });
    expect(asCliError({ code: "not_found", message: "x" }).code).toBe("not_found");
  });
});
