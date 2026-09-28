import { describe, expect, it } from "vitest";
import { liftGlobals, parseArgs } from "../src/args";
import { idSlot, positionals, COMMANDS, TEXT_COMMANDS } from "../src/commands";
import { asCliError, CliError, EXIT } from "../src/errors";
// covers: headless.cli

/** Base64url values start with "-" one time in 64 (the #208 lesson): fixed ones, never random. */
const HYPHEN_KEY = "-Abc_def-123";
/** The draft id that failed PR #357's CI, and an id that starts with two dashes (one in 4096). */
const HYPHEN_DRAFT = "-wtTajMuVtb91WDQOVyEcg";
const DOUBLE_DASH_ID = "--tTajMuVtb91WDQOVyEc";

describe("the argument parser", () => {
  it("takes an option's value as is, even when it starts with a dash", () => {
    const parsed = parseArgs(["--label", HYPHEN_KEY, "--limit=5", "chat1"], { label: { type: "string", description: "" }, limit: { type: "number", description: "" } });
    expect(parsed).toEqual({ positionals: ["chat1"], options: { label: HYPHEN_KEY, limit: 5 } });
    expect(parseArgs([`--label=${HYPHEN_KEY}`], { label: { type: "string", description: "" } }).options.label).toBe(HYPHEN_KEY);
  });

  it("refuses a text positional that starts with a dash, unless it comes after --", () => {
    expect(() => parseArgs(["chat", "-oops"], {})).toThrow(/Unknown option -oops/);
    expect(parseArgs(["--profile", "bot", "--", "chat", "-a dash"], {})).toEqual({ positionals: ["chat", "-a dash"], options: { profile: "bot" } });
    const send = TEXT_COMMANDS.send;
    expect(() => parseArgs(["alice", "-oops"], send.options, idSlot(send))).toThrow(/Unknown option -oops/);
    expect(() => parseArgs(["alice", "--stdn"], send.options, idSlot(send))).toThrow(/Unknown option --stdn/);
    expect(() => parseArgs(["abc", "-oops"], COMMANDS["chat rename"].options ?? {}, idSlot(COMMANDS["chat rename"]))).toThrow(/Unknown option -oops/);
    expect(() => parseArgs(["-oops"], COMMANDS["group create"].options!, idSlot(COMMANDS["group create"]))).toThrow(/Unknown option -oops/);
  });

  it("takes a draft that starts with a dash (identity complete, the #357 failure)", () => {
    const complete = COMMANDS["identity complete"];
    const parsed = parseArgs([HYPHEN_DRAFT, "--stdin"], complete.options!, idSlot(complete));
    expect(parsed).toEqual({ positionals: [HYPHEN_DRAFT], options: { stdin: true } });
    expect(complete.params!(parsed, positionals(complete, parsed.positionals))).toEqual({ draft: HYPHEN_DRAFT, evidenceFile: undefined, stdin: true });
    expect(parseArgs(["--stdin", DOUBLE_DASH_ID], complete.options!, idSlot(complete))).toEqual({ positionals: [DOUBLE_DASH_ID], options: { stdin: true } });
    // The command's own options are still options there, and a mistyped one after the draft is still refused.
    expect(parseArgs(["-p", "bot", "--no-stdin", HYPHEN_DRAFT], complete.options!, idSlot(complete))).toEqual({ positionals: [HYPHEN_DRAFT], options: { profile: "bot", stdin: false } });
    expect(() => parseArgs([HYPHEN_DRAFT, "--stdn"], complete.options!, idSlot(complete))).toThrow(/Unknown option --stdn/);
  });

  it("takes an id that starts with a dash in every positional that names something", () => {
    const named = new Set<string>();
    for (const [name, command] of [...Object.entries(COMMANDS), ...Object.entries(TEXT_COMMANDS)]) {
      const takesId = idSlot(command);
      const slots = command.args ?? [];
      const argv = slots.map((slot, i) => (takesId(i) ? `${i % 2 ? DOUBLE_DASH_ID : HYPHEN_KEY}${i}` : "word"));
      expect(parseArgs(argv, command.options ?? {}, takesId).positionals, name).toEqual(argv);
      slots.forEach((slot, i) => { if (takesId(i)) named.add(slot.replace(/\?$/, "")); });
    }
    // Every kind of generated id a command takes: drafts, proofs, payments, messages, files, groups, calls, …
    expect([...named].sort()).toEqual(["call...", "card", "chat", "draft", "file", "group", "id", "member", "message", "message...", "payment", "service"]);
    // forward: several messages, and --to once per chat or group (a dash-leading id as --to=<id>).
    expect(parseArgs(["alice", HYPHEN_KEY, DOUBLE_DASH_ID, "--to", "bob", `--to=${HYPHEN_KEY}`, "--wait", "sent"], COMMANDS.forward!.options!, idSlot(COMMANDS.forward!)))
      .toEqual({ positionals: ["alice", HYPHEN_KEY, DOUBLE_DASH_ID], options: { to: ["bob", HYPHEN_KEY], wait: "sent" } });
    expect(parseArgs([HYPHEN_KEY, "--limit", "5"], COMMANDS["chat history"].options!, idSlot(COMMANDS["chat history"]))).toEqual({ positionals: [HYPHEN_KEY], options: { limit: 5 } });
    expect(parseArgs([HYPHEN_KEY, "hi", "--force"], TEXT_COMMANDS.send.options, idSlot(TEXT_COMMANDS.send))).toEqual({ positionals: [HYPHEN_KEY, "hi"], options: { force: true } });
    // An id in a trailing optional one (`call answer [<chat|call>]`).
    expect(parseArgs([HYPHEN_KEY, "--rate", "16000"], COMMANDS["call answer"].options!, idSlot(COMMANDS["call answer"]))).toEqual({ positionals: [HYPHEN_KEY], options: { rate: 16000 } });
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

  it("takes ids that start with a single dash where the command says ids come, never as text", () => {
    const draft = "-guUzRbBsj7cpq-yPjgCUQ";
    const ids = () => true;
    expect(parseArgs(["identity", draft, "--stdin"], { stdin: { type: "boolean", description: "" } }, ids)).toEqual({ positionals: ["identity", draft], options: { stdin: true } });
    expect(parseArgs([draft, "hello"], {}, (i) => i === 0).positionals).toEqual([draft, "hello"]);
    expect(() => parseArgs(["group", "-oops"], {}, (i) => i === 0)).toThrow(/Unknown option -oops/);
    expect(() => parseArgs(["-x"], {}, ids)).toThrow(/Unknown option -x/);
    // Two dashes too (one id in 4096), except where text comes.
    expect(parseArgs(["--nope"], {}, (i) => i === 0).positionals).toEqual(["--nope"]);
    expect(() => parseArgs(["group", "--nope"], {}, (i) => i === 0)).toThrow(/Unknown option --nope/);
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

  it("takes a file by its id alone, or after its chat, for every file command", () => {
    const params = (name: string, values: string[]) => COMMANDS[name].params!({ positionals: values, options: {} }, positionals(COMMANDS[name], values));
    for (const action of ["accept", "decline", "pause", "resume", "cancel", "resend", "request"]) {
      expect(params(`file ${action}`, ["c1-in-x"])).toEqual({ file: "c1-in-x", action });
      expect(params(`file ${action}`, ["alice", "c1-in-x"])).toEqual({ chat: "alice", file: "c1-in-x", action });
      expect(COMMANDS[`file ${action}`].usage).toBe(`file ${action} [<chat>] <file>`);
    }
    expect(params("file save", ["c1-in-x"])).toMatchObject({ file: "c1-in-x", force: false });
    expect(params("file save", ["alice", "c1-in-x"])).toMatchObject({ chat: "alice", file: "c1-in-x" });
    expect(params("file wait", ["c1-in-x"])).toEqual({ file: "c1-in-x" });
    expect(COMMANDS["file wait"].params!({ positionals: [], options: { timeout: 5 } }, { chat: "alice", file: "f" })).toEqual({ chat: "alice", file: "f", timeout: 5 });
  });

  it("names positionals, joins a trailing one, and says what is missing", () => {
    expect(positionals(COMMANDS["chat rename"], ["abc", "My", "bot"])).toEqual({ chat: "abc", name: "My bot" });
    expect(positionals(COMMANDS["chat rename"], ["abc"])).toEqual({ chat: "abc", name: undefined });
    expect(COMMANDS["file resend"].params!({ positionals: [], options: {} }, positionals(COMMANDS["file resend"], ["c1-out-x"]))).toEqual({ file: "c1-out-x", action: "resend" });
    expect(COMMANDS["file request"].params!({ positionals: [], options: {} }, positionals(COMMANDS["file request"], ["c1-in-y"]))).toEqual({ file: "c1-in-y", action: "request" });
    expect(() => positionals(COMMANDS["message delete"], ["abc"])).toThrow(/Missing <message>/);
    expect(() => positionals(COMMANDS["file accept"], [])).toThrow(/Missing <file>/);
    expect(() => positionals(COMMANDS["file accept"], ["a", "b", "c"])).toThrow(/Too many/);
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
