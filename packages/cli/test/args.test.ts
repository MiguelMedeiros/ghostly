import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { liftGlobals, parseArgs } from "../src/args";
import { idSlot, positionals, COMMANDS, TEXT_COMMANDS } from "../src/commands";
import { GhostlyHttpError, engineError } from "@ghostly/core";
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
    // forward: several messages, and --to once per chat or group, a dash-leading id either way.
    expect(parseArgs(["alice", HYPHEN_KEY, DOUBLE_DASH_ID, "--to", "bob", `--to=${HYPHEN_KEY}`, "--to", DOUBLE_DASH_ID, "--wait", "sent"], COMMANDS.forward!.options!, idSlot(COMMANDS.forward!)))
      .toEqual({ positionals: ["alice", HYPHEN_KEY, DOUBLE_DASH_ID], options: { to: ["bob", HYPHEN_KEY, DOUBLE_DASH_ID], wait: "sent" } });
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

  it("refuses a number option given as \"\" (an unset variable) as it refuses \"abc\", never reading it as 0", () => {
    // Number("") is 0: `usage send --all --left ""` posted "0% left" to every chat, `listen --since ""` replayed the journal.
    for (const [name, option] of [["usage send", "left"], ["task send", "progress"], ["events", "since"], ["chat disconnect", "hold"], ["typing", "for"]] as const) {
      const command = COMMANDS[name] ?? TEXT_COMMANDS[name];
      for (const argv of [[`--${option}`, ""], [`--${option}`, " "], [`--${option}=`]]) {
        expect(() => parseArgs(["x", ...argv], command.options!, idSlot(command)), `${name} ${argv.join(" ")}`).toThrow(new CliError("usage", `--${option} takes a number, not ${JSON.stringify(argv[1] ?? "")}`));
      }
    }
    // `listen` parses with its own spec in main.ts, through the same parser.
    expect(() => parseArgs(["--since", ""], { since: { type: "number", description: "" } })).toThrow(/^--since takes a number, not ""$/);
    expect(parseArgs(["--left", "0"], COMMANDS["usage send"].options!).options).toEqual({ left: 0 });
  });

  it("moves global options given before the command after it", () => {
    expect(liftGlobals(["--home", "/h", "-p", "bot", "--pretty", "send", "c", "hi"])).toEqual(["send", "c", "hi", "--home", "/h", "-p", "bot", "--pretty"]);
    expect(liftGlobals(["--profile=bot", "chat", "list"])).toEqual(["chat", "list", "--profile=bot"]);
    expect(liftGlobals(["send", "--home", "/h"])).toEqual(["send", "--home", "/h"]);
    expect(liftGlobals(["--home", "/h", "send", "c", "--", "-dash"])).toEqual(["send", "c", "--home", "/h", "--", "-dash"]);
    // A global boolean's `--no-` form moves as the option itself does; `--no-home` names no option and stays.
    expect(liftGlobals(["--no-pretty", "status"])).toEqual(["status", "--no-pretty"]);
    expect(parseArgs(liftGlobals(["--no-pretty", "status"]).slice(1), {})).toEqual({ positionals: [], options: { pretty: false } });
    expect(liftGlobals(["--no-home", "status"])).toEqual(["--no-home", "status"]);
  });

  it("a global option before the command never lands between an option and its value", () => {
    // They went just before the first `--`, also when that `--` is an option's value: `--pretty profile set --name --`
    // read `--name --pretty`, and the name contacts see became "--pretty".
    const lifted = liftGlobals(["--pretty", "profile", "set", "--name", "--"]);
    expect(lifted).toEqual(["profile", "set", "--pretty", "--name", "--"]);
    expect(parseArgs(lifted.slice(2), { name: { type: "string", description: "" } })).toEqual({ positionals: [], options: { pretty: true, name: "--" } });
    const edit = liftGlobals(["-p", "bot", "edit", "c", "m", "--text", "--"]);
    expect(parseArgs(edit.slice(1), { text: { type: "string", description: "" } })).toEqual({ positionals: ["c", "m"], options: { profile: "bot", text: "--" } });
    // Before the first option, and so before the `--` that ends them; an id that starts with a dash stays the id.
    expect(liftGlobals(["--pretty", "send", "c", "--reply", "m1", "--", "-x"])).toEqual(["send", "c", "--pretty", "--reply", "m1", "--", "-x"]);
    const show = liftGlobals(["--pretty", "chat", "show", HYPHEN_KEY]);
    expect(parseArgs(show.slice(2), {}, () => true)).toEqual({ positionals: [HYPHEN_KEY], options: { pretty: true } });
    // The command stays the first word, also when it is `--version`; a `--` right away still ends the options.
    expect(liftGlobals(["--pretty", "--version"])).toEqual(["--version", "--pretty"]);
    expect(liftGlobals(["--pretty", "--", "send"])).toEqual(["--pretty", "--", "send"]);
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

  it("a required positional given as \"\" is the usage error a missing one is, before the profile opens, in every command", () => {
    expect(() => positionals(COMMANDS["chat show"], [""])).toThrow(/^Missing <chat>: ghostly chat show <chat>/);
    expect(() => positionals(COMMANDS["file accept"], ["", "f"])).toThrow(/^Missing <chat>/);
    expect(() => positionals(COMMANDS["group create"], ["", ""])).toThrow(/^Missing <name>/);
    // `chat rename <chat> ""` gives the chat back the contact's name, by design.
    expect(positionals(COMMANDS["chat rename"], ["abc", ""])).toEqual({ chat: "abc", name: "" });
    // Before: 63 commands opened the profile, then answered bad_request "<param> is required" (exit 1).
    const sweep = Object.entries({ ...COMMANDS, ...TEXT_COMMANDS }).flatMap(([name, command]) => {
      // Every positional but a leading optional one (`[<chat>] <file>`) gets a word.
      const given = (command.args ?? []).filter((arg) => !arg.endsWith("?") || arg.endsWith("...?"));
      return given.flatMap((arg, at) => {
        if (arg.endsWith("?")) return [];
        const values = given.map((_, i) => (i === at ? "" : "x"));
        try {
          positionals(command, values);
          return [`${name} <${arg}>`];
        } catch (error) {
          return error instanceof CliError && error.code === "usage" && /^Missing </.test(error.message) ? [] : [`${name} <${arg}>: ${String(error)}`];
        }
      });
    });
    expect(sweep).toEqual([]);

    // The name in "Missing <x>" is the one the usage line shows: `chat pay bob` said <amount> for `<sats>`.
    const unnamed = Object.entries({ ...COMMANDS, ...TEXT_COMMANDS }).flatMap(([name, command]) => {
      const given = (command.args ?? []).filter((arg) => !arg.endsWith("?") || arg.endsWith("...?"));
      return given.flatMap((arg, at) => {
        if (arg.endsWith("?")) return [];
        try {
          positionals(command, given.map((_, i) => (i === at ? "" : "x")));
          return [];
        } catch (error) {
          const shown = /^Missing <([^>]+)>: /.exec((error as Error).message)?.[1];
          return shown !== undefined && (command.usage.includes(`<${shown}>`) || command.usage.includes(`<${shown}...>`)) ? [] : [`${name}: ${(error as Error).message}`];
        }
      });
    });
    expect(unnamed).toEqual([]);
    expect(() => positionals(COMMANDS["chat pay"], ["bob"])).toThrow(/^Missing <sats>: ghostly chat pay <chat> <sats>/);
    expect(() => positionals(COMMANDS["service add"], ["web", ""])).toThrow(/^Missing <http:\/\/127\.0\.0\.1:port>: /);
    expect(() => positionals(COMMANDS["file accept"], [])).toThrow(/^Missing <file>: /);
    expect(() => positionals(COMMANDS["file accept"], ["", "f"])).toThrow(/^Missing <chat>: /);

    // A path given as "" read the current folder: `profile picture ""` said "No file <cwd>".
    const params = (name: string, values: string[], options: Record<string, string | boolean> = {}) => COMMANDS[name].params!({ positionals: values, options }, positionals(COMMANDS[name], values));
    expect(() => params("profile picture", [""])).toThrow(/^Missing <jpeg>/);
    expect(() => params("group picture", ["g", ""])).toThrow(/^Missing <jpeg>/);
    expect(params("profile picture", [""], { clear: true })).toEqual({ path: undefined, clear: true });
    expect(() => params("identity complete", ["d"], { "evidence-file": "" })).toThrow(/^A path given as "" names no file/);
  });

  it("says a required name, path or --to is missing as a usage error, before anything opens", () => {
    const params = (name: string, argv: string[]) => {
      const command = COMMANDS[name];
      const parsed = parseArgs(argv, command.options ?? {}, idSlot(command));
      return command.params!(parsed, positionals(command, parsed.positionals));
    };
    const usage = (name: string, argv: string[], message: string) => {
      let error: unknown;
      try { params(name, argv); } catch (caught) { error = caught; }
      expect(error, name).toBeInstanceOf(CliError);
      expect((error as CliError).code, name).toBe("usage");
      expect((error as CliError).message, name).toBe(message);
    };
    usage("group create", [], "Missing <name>: ghostly group create <name...> [--mesh]");
    usage("group create", ["--mesh"], "Missing <name>: ghostly group create <name...> [--mesh]");
    usage("group rename", ["g1"], "Missing <name>: ghostly group rename <group> <name...> [--show-secret]");
    usage("lightning rename", ["c1"], "Missing <name>: ghostly lightning rename <card> <name...> [--network testnet]");
    usage("profile picture", [], "Missing <jpeg>: ghostly profile picture <jpeg> | --clear");
    usage("group picture", ["g1"], "Missing <jpeg>: ghostly group picture <group> <jpeg> | --clear");
    usage("forward", ["g1"], `Missing <message>: ghostly ${COMMANDS.forward.usage}`);
    usage("forward", ["g1", "m1"], `Missing --to: ghostly ${COMMANDS.forward.usage}`);
    // Auto-answer's chats and rate are only kept when it goes on: elsewhere they would be dropped without a word.
    usage("call auto", ["--from", "bob"], "--from and --rate go with on: ghostly call auto on --from <chat>");
    usage("call auto", ["--rate", "16000"], "--from and --rate go with on: ghostly call auto on --from <chat>");
    usage("call auto", ["off", "--from", "bob", "--rate", "16000"], "--from and --rate go with on: ghostly call auto on --from <chat>");
    expect(params("call auto", ["on", "--from", "bob", "--rate", "16000"])).toEqual({ on: true, from: ["bob"], rate: 16000 });
    expect(params("call auto", ["off"])).toEqual({ on: false });
    // "" (an unset variable in a script) names no chat: before, it was a prefix of every id and took the only chat.
    usage("forward", ["bob", "m1", "--to", ""], "--to \"\" names no chat or group");
    usage("forward", ["bob", "m1", "--to", "alice", "--to", "group:"], "--to \"group:\" names no chat or group");
    usage("forward", ["bob", "m1", "--to", " "], "--to \" \" names no chat or group");
    usage("call auto", ["on", "--from", ""], "--from \"\" names no chat");
    expect(params("forward", ["bob", "m1", "--to", "group:g1"])).toMatchObject({ to: ["group:g1"] });
    // What may be left out still may: a picture cleared, a chat's own name back, a reaction taken back, the only call.
    expect(params("profile picture", ["--clear"])).toEqual({ path: undefined, clear: true });
    expect(params("group picture", ["g1", "--clear"])).toEqual({ group: "g1", path: undefined, clear: true });
    expect(params("chat rename", ["abc"])).toEqual({ chat: "abc", name: "" });
    expect(params("react", ["alice", "peer_x", "--remove"])).toMatchObject({ emoji: undefined, remove: true });
    expect(params("call hangup", [])).toEqual({ call: undefined });
    expect(params("call auto", [])).toEqual({});
    expect(positionals(TEXT_COMMANDS.send, ["alice"])).toEqual({ chat: "alice", text: undefined });
    expect(params("forward", ["g1", "m1", "m2", "--to", "bob"])).toMatchObject({ chat: "g1", messages: ["m1", "m2"], to: ["bob"] });
  });

  it("says a flag left out or out of range as a usage error that names the flag, not the API's parameter", () => {
    const params = (name: string, argv: string[]) => {
      const command = COMMANDS[name];
      const parsed = parseArgs(argv, command.options ?? {}, idSlot(command));
      return command.params!(parsed, positionals(command, parsed.positionals));
    };
    const usage = (name: string, argv: string[], message: string) => {
      let error: unknown;
      try { params(name, argv); } catch (caught) { error = caught; }
      expect(error, name).toBeInstanceOf(CliError);
      expect((error as CliError).code, name).toBe("usage");
      expect((error as CliError).message, name).toBe(message);
    };
    usage("button update", ["alice", "m1"], `Give --chosen, --close or --text: ghostly ${COMMANDS["button update"].usage}`);
    usage("button update", ["alice", "m1", "--wait", "confirmed", "--text", ""], `Give --chosen, --close or --text: ghostly ${COMMANDS["button update"].usage}`);
    usage("chat verify", ["alice"], "--code is needed: ghostly chat verify <chat> --code <code>");
    usage("chat verify", ["alice", "--code", " "], "--code is needed: ghostly chat verify <chat> --code <code>");
    for (const [name, target] of [["typing", "alice"], ["group typing", "g1"]] as const) {
      usage(name, [target, "--for", "9999"], "--for takes a number of seconds from 1 to 600, not 9999");
      usage(name, [target, "--for", "0"], "--for takes a number of seconds from 1 to 600, not 0");
      usage(name, [target, "--stop", "--for", "30"], "--for keeps it on: not with --stop");
      expect(params(name, [target, "--for", "600"])).toMatchObject({ for: 600, stop: false });
      expect(params(name, [target, "--stop"])).toMatchObject({ for: undefined, stop: true });
    }
    // Each of the three is enough for an update, and a code is taken as typed.
    expect(params("button update", ["alice", "m1", "--chosen", "yes"])).toMatchObject({ chosen: "yes", close: false });
    expect(params("button update", ["alice", "m1", "--close"])).toMatchObject({ close: true });
    expect(params("button update", ["alice", "m1", "--text", "Done"])).toMatchObject({ text: "Done" });
    expect(params("chat verify", ["alice", "--code", "ab cd"])).toEqual({ chat: "alice", code: "ab cd" });
  });

  it("refuses the two sides of an either/or given together, naming both, where before one won without a word", () => {
    const params = (name: string, argv: string[]) => {
      const command = COMMANDS[name];
      const parsed = parseArgs(argv, command.options ?? {}, idSlot(command));
      return command.params!(parsed, positionals(command, parsed.positionals));
    };
    const pairs: [name: string, argv: string[], message: string][] = [
      ["profile picture", ["one.jpg", "--clear"], "--clear removes the picture: not with a <jpeg>"],
      ["group picture", ["g1", "one.jpg", "--clear"], "--clear removes the picture: not with a <jpeg>"],
      ["task send", ["bob", "--title", "t", "--progress", "10", "--steps", "4/5"], "--progress or --steps, not both"],
      ["task update", ["bob", "t1", "--progress", "10", "--steps", "4/5"], "--progress or --steps, not both"],
      ["usage send", ["bob", "--left", "5", "--used", "1", "--limit", "2"], "--left or --used with --limit, not both"],
      ["usage send", ["bob", "--left", "5", "--used", "1"], "--left or --used with --limit, not both"],
      ["group link", ["g1", "--off", "--reset"], "--off turns the link off: not with --reset"],
      ["group hub", ["g1", "m1", "--pin", "--exclude"], "--pin, --exclude or --auto: one of them"],
      ["group hub", ["g1", "m1", "--exclude", "--auto"], "--pin, --exclude or --auto: one of them"],
      ["file save", ["f1", "--dir", "d", "--path", "d/both.txt"], "--path names the file: not with --dir"],
      ["file save", ["f1", "--timeout", "5"], "--timeout is how long --wait waits: not without --wait"],
      ["identity complete", ["d1", "--evidence-file", "proof.txt", "--stdin"], "--evidence-file or --stdin, not both"],
    ];
    for (const [name, argv, message] of pairs) {
      let error: unknown;
      try { params(name, argv); } catch (caught) { error = caught; }
      expect(error, `${name} ${argv.join(" ")}`).toBeInstanceOf(CliError);
      expect((error as CliError).code, name).toBe("usage");
      expect((error as CliError).message, name).toBe(message);
    }
    // Each side alone is taken as before.
    expect(params("profile picture", ["--clear"])).toMatchObject({ path: undefined, clear: true });
    expect(params("group picture", ["g1", "--clear"])).toMatchObject({ clear: true });
    expect(params("task send", ["bob", "--title", "t", "--steps", "4/5"]).card).toMatchObject({ done: 4, total: 5 });
    expect(params("task send", ["bob", "--title", "t", "--progress", "10"]).card).toMatchObject({ progress: 10 });
    expect(params("usage send", ["bob", "--used", "1", "--limit", "2"]).card).toMatchObject({ used: 1, limit: 2 });
    expect(params("usage send", ["bob", "--left", "5"]).card).toMatchObject({ left: 5 });
    expect(params("group link", ["g1", "--reset"])).toEqual({ group: "g1", on: true, reset: true });
    expect(params("group link", ["g1", "--off"])).toEqual({ group: "g1", on: false, reset: false });
    for (const role of ["pin", "exclude", "auto"]) expect(params("group hub", ["g1", "m1", `--${role}`])).toMatchObject({ role });
    expect(params("group hub", ["g1", "m1"])).toMatchObject({ role: "auto" });
    expect(params("file save", ["f1", "--dir", "d"])).toMatchObject({ dir: resolve("d"), path: undefined });
    expect(params("file save", ["f1", "--path", "d/one.txt"])).toMatchObject({ dir: undefined, path: resolve("d/one.txt") });
    expect(params("file save", ["f1"])).toMatchObject({ dir: resolve("."), path: undefined });
    expect(params("file save", ["f1", "--wait", "--timeout", "5"])).toMatchObject({ wait: true, timeout: 5 });
    expect(params("identity complete", ["d1", "--evidence-file", "proof.txt"])).toEqual({ draft: "d1", evidenceFile: resolve("proof.txt"), stdin: false });
    expect(params("identity complete", ["d1", "--stdin"])).toEqual({ draft: "d1", evidenceFile: undefined, stdin: true });
  });
});

describe("errors", () => {
  it("map to exit codes a bot can branch on", () => {
    expect(EXIT).toMatchObject({ engine: 1, usage: 2, not_found: 3, timeout: 4, confirm: 5 });
    expect(asCliError(new Error("A Mainnet payment needs you to confirm it as real money")).code).toBe("confirm");
    expect(asCliError(new Error("boom")).toJSON()).toEqual({ code: "engine", message: "boom" });
    expect(asCliError({ code: "not_found", message: "x" }).code).toBe("not_found");
    // A code is one of the table's own: every object has `constructor`, which is none (and has no exit status).
    expect(asCliError({ code: "constructor", message: "x" }).code).toBe("engine");
  });

  // A host that does not answer was `engine` (exit 1), which a bot reads as the engine failing, and a Lightning
  // address the CLI could not reach said the browser's words ("not allow web apps to read it (CORS)").
  it("say the engine's known errors by what they are: a host not there, one too slow, a wrong value, a refusal", () => {
    const host = { host: "nowhere.example" };
    for (const code of ["mintUnreachable", "hostUnreachable", "networkUnreachable", "usdtRpcUnavailable"] as const)
      expect(asCliError(engineError(code, host)).code, code).toBe("unavailable");
    for (const code of ["hostTimedOut", "networkTimedOut"] as const) expect(asCliError(engineError(code, host)).code, code).toBe("timeout");
    for (const code of ["invalidMintUrl", "mintNotHttps", "invalidMaxFee"] as const) expect(asCliError(engineError(code)).code, code).toBe("bad_request");
    for (const code of ["notEnoughSats", "ecashAlreadySpent"] as const) expect(asCliError(engineError(code)).code, code).toBe("refused");
    expect(asCliError(engineError("lnurlUnreachable", host)).toJSON()).toEqual({ code: "unavailable", message: "Could not reach nowhere.example" });
    // One the table does not name stays the engine's, in its words.
    expect(asCliError(engineError("outcomeUnknown")).toJSON()).toEqual({ code: "engine", message: "Outcome unknown. Check the existing payment; do not send another." });
  });

  it("say a local path could not be opened as the person's path, not as the engine refusing", async () => {
    // Found in bug hunt r3a: `file save --dir` into a folder that did not exist was `engine`, exit 1, with Node's words.
    const { open } = await import("node:fs/promises");
    const missing = await open("/nonexistent-ghostly-folder/x.bin", "wx").catch((error: unknown) => error);
    expect(asCliError(missing).toJSON()).toEqual({ code: "not_found", message: "No such file or folder: /nonexistent-ghostly-folder/x.bin" });
    expect(asCliError(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES", syscall: "open", path: "/x" })).code).toBe("refused");
    expect(asCliError(Object.assign(new Error("EISDIR: illegal operation"), { code: "EISDIR", syscall: "open", path: "/tmp" })).code).toBe("bad_request");
    // An engine error that only mentions a file keeps its words.
    expect(asCliError(new Error("The file is gone")).code).toBe("engine");
  });

  it("say a contact that could not be reached as unavailable, not as the engine failing", () => {
    // `chat pay` / `chat connect` to a contact that never answers: the link's GhostlyHttpError "unreachable".
    expect(asCliError(new GhostlyHttpError("unreachable", "Could not connect to the peer")).toJSON()).toEqual({ code: "unavailable", message: "Could not connect to the peer" });
    expect(asCliError(new GhostlyHttpError("closed", "Connection closed")).code).toBe("engine");
  });

  // A member's admin-only group commands and an invitation already answered were `engine` (exit 1), the code for the
  // engine failing: a bot could not tell "you are not allowed" from a crash. The engine's own words, as thrown.
  it("say a group refusal as refused, and an invite into a community as a wrong request", () => {
    for (const message of [
      "Only the admin can rename the group", "Only the admin can change the members of this group", "Only the admin can renew the group's secret",
      "Only the admin can share a link to the group", "Only the admin can invite", "Only the admin can choose the group's hubs",
      "Only the admin can change the group's picture", "Only the admin can replace or turn off the group's link", "Only the admin can do that",
      "No invitation to accept", "No invitation to decline",
    ]) expect(asCliError(new Error(message)).toJSON(), message).toEqual({ code: "refused", message });
    const community = "Share the group's link with them: anyone who opens it joins";
    expect(asCliError(new Error(community)).toJSON()).toEqual({ code: "bad_request", message: community });
  });
});
