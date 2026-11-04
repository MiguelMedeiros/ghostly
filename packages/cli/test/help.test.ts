import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";
// covers: headless.cli

/** Help per command and per group, as a person or a bot asks for it: `help <words>` or `<words> --help`. */
describe("help", () => {
  it("for a group lists its commands, whichever way it is asked", async () => {
    for (const args of [["help", "file"], ["file", "--help"], ["file", "-h"], ["file", "--help=true"]]) {
      const { code, stdout } = await ghostly(args);
      expect(code, args.join(" ")).toBe(0);
      expect(stdout).toContain("ghostly file:");
      expect(stdout).toContain("file wait [<chat>] <file> [--timeout s]");
      expect(stdout).toContain("file accept [<chat>] <file>");
      expect(stdout).not.toContain("chat list");
    }
  });

  it("for one command shows its usage, what it does and its options", async () => {
    for (const args of [["help", "file", "save"], ["file", "save", "--help"], ["file", "save", "c1-in-x", "--help"], ["file", "save", "c1-in-x", "--help=true"]]) {
      const { code, stdout } = await ghostly(args);
      expect(code, args.join(" ")).toBe(0);
      expect(stdout).toContain("Usage: ghostly file save [<chat>] <file>");
      expect(stdout).toMatch(/--wait\s+Wait for the transfer to finish first/);
      expect(stdout).toMatch(/--timeout <n>\s+Seconds --wait waits/);
    }
    const typing = await ghostly(["typing", "--help"]);
    expect(typing.stdout).toMatch(/--for <n>/);
    const daemon = await ghostly(["help", "daemon"]);
    expect(daemon.stdout).toContain("daemon restart");
    // `daemon` itself first, with its own options, then the commands under it: its --timeout was shown nowhere.
    for (const args of [["help", "daemon"], ["daemon", "--help"]]) {
      const { stdout } = await ghostly(args);
      expect(stdout, args.join(" ")).toMatch(/^Usage: ghostly daemon \[--detach\] \[--timeout s\]\n/);
      expect(stdout, args.join(" ")).toMatch(/--timeout <n>\s+Seconds it waits for a command that holds the profile, and --detach for it to start/);
      expect(stdout, args.join(" ")).toContain("ghostly daemon: 3 more commands (ghostly help daemon <command> for one)");
      expect(stdout.indexOf("--detach for it to start"), args.join(" ")).toBeLessThan(stdout.indexOf("daemon status"));
    }
    // One command in a group is "1 command".
    expect((await ghostly(["help", "store"])).stdout).not.toContain("1 commands");
    const send = await ghostly(["send", "bob", "hi", "--help"]);
    expect(send.stdout).toContain("Usage: ghostly send <chat>");
    // Next to the text: what `--` does to the options after it.
    expect(send.stdout).toContain("everything after it is the text, options included");
    expect((await ghostly(["help", "group", "send"])).stdout).toContain("Put options before --.");
    expect(daemon.stdout).not.toContain("Put options before --.");
  });

  it("an unknown command is a usage error; plain help is the whole list", async () => {
    const unknown = await ghostly(["help", "frobnicate"]);
    expect(unknown.code).toBe(2);
    expect(unknown.json).toMatchObject({ error: { code: "usage" } });
    expect((await ghostly(["frobnicate", "--help"])).code).toBe(2);
    const whole = await ghostly(["help"]);
    expect(whole.stdout).toContain("Usage: ghostly <command>");
    // Its last line sends the reader somewhere an npm install has: the docs page and the README beside this CLI.
    expect(whole.stdout.trimEnd().split("\n").pop()).toContain("https://ghostly.tools/cli");
    expect(whole.stdout).not.toContain("packages/cli/");
  });

  // agents#1606: `group send`/`group edit`, `identity add` and `call pipe` sat after the whole table, far from their own.
  it("keeps each word's commands together in the whole list", async () => {
    const lines = (await ghostly(["help"], { env: { GHOSTLY_HOME: home("help-order") } })).stdout.split("\n");
    const commands = lines.filter((line) => /^ {2}[a-z]/.test(line)).map((line) => line.trim().split(/\s+/).slice(0, 2));
    for (const word of ["group", "identity", "call"]) {
      const at = commands.flatMap(([first, second], i) => (first === word && /^[a-z]/.test(second ?? "") ? [i] : []));
      expect(at.length, word).toBeGreaterThan(3);
      expect(at.at(-1)! - at[0], `${word}: ${at.join(" ")}`).toBe(at.length - 1);
    }
    for (const usage of ["group send", "group edit", "identity add", "call pipe"]) expect(commands.some(([a, b]) => `${a} ${b}` === usage), usage).toBe(true);
  });

  it("a group's first word alone, or with a word it does not take, names the group's commands", async () => {
    const alone = await ghostly(["chat"]);
    expect(alone.code).toBe(2);
    expect(alone.json).toMatchObject({ error: { code: "usage" } });
    const message = (alone.json.error as { message: string }).message;
    expect(message).toMatch(/^ghostly chat takes a command: .*\blist\b.*\bwait\b.* \(ghostly help chat\)$/);
    expect(message).not.toMatch(/\bsend\b|\bgroup\b/);
    const wrong = await ghostly(["wallet", "frob"]);
    expect(wrong.code).toBe(2);
    expect((wrong.json.error as { message: string }).message).toMatch(/^Unknown command: wallet frob: ghostly wallet takes .*\bfaucet\b.* \(ghostly help wallet\)$/);
    expect((await ghostly(["frobnicate"])).json).toMatchObject({ error: { code: "usage", message: "Unknown command: frobnicate (ghostly help)" } });
    expect((await ghostly(["help", "listen"])).stdout).toContain("[--print]");
  });

  it("profile and settings name their commands as every group does, and help for a word a group does not take is unknown", async () => {
    // `profile frob` said "ghostly profile create|list|use|show|set|picture|backup|restore", `settings frob` "ghostly
    // settings get | settings set <key> <json-value>"; `help chat histroy` printed the chat group's list with exit 0.
    const profile = "create, list, use, show, set, backup, restore or picture";
    for (const [args, message] of [
      [["profile"], `ghostly profile takes a command: ${profile} (ghostly help profile)`],
      [["profile", "frob"], `Unknown command: profile frob: ghostly profile takes ${profile} (ghostly help profile)`],
      [["settings"], "ghostly settings takes a command: get or set (ghostly help settings)"],
      [["settings", "frob"], "Unknown command: settings frob: ghostly settings takes get or set (ghostly help settings)"],
      [["daemon", "frob"], "Unknown command: daemon frob: ghostly daemon takes status, stop or restart (ghostly help daemon)"],
      [["help", "profile", "frob"], `Unknown command: profile frob: ghostly profile takes ${profile} (ghostly help profile)`],
      [["help", "x401", "key", "frob"], "Unknown command: x401 key frob: ghostly x401 key takes new (ghostly help x401 key)"],
      [["wallet", "frob", "--help"], expect.stringMatching(/^Unknown command: wallet frob: ghostly wallet takes .*\bfaucet\b.* \(ghostly help wallet\)$/)],
    ] as const) {
      const result = await ghostly([...args]);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.json, args.join(" ")).toEqual({ error: { code: "usage", message } });
    }
    const chat = await ghostly(["help", "chat", "histroy"]);
    expect(chat.code).toBe(2);
    expect((chat.json.error as { message: string }).message).toBe("Unknown command: chat histroy (did you mean chat history? ghostly help chat history)");
  });

  it("a typo in a command or an option names what was meant, the command and its help", async () => {
    // Before: "Unknown command: sned hi (ghostly help)" (the text read as a command word), "Unknown option --wiat" (no
    // command, no help), and "put -- before text" from commands that take no text.
    const dir = home("typos");
    for (const [args, message] of [
      [["sned", "hi"], "Unknown command: sned (did you mean send? ghostly help send)"],
      [["chta", "list"], "Unknown command: chta list (did you mean chat list? ghostly help chat list)"],
      [["grup", "list"], "Unknown command: grup list (did you mean group list? ghostly help group list)"],
      [["chat", "lst"], "Unknown command: chat lst (did you mean chat list? ghostly help chat list)"],
      [["help", "sned"], "Unknown command: sned (did you mean send? ghostly help send)"],
      [["send", "ecp", "hi", "--wiat", "sent"], "Unknown option --wiat for ghostly send (did you mean --wait? ghostly help send)"],
      [["chat", "history", "ecp", "--limt", "5"], "Unknown option --limt for ghostly chat history (did you mean --limit? ghostly help chat history)"],
      [["chat", "list", "--show-secrets"], "Unknown option --show-secrets for ghostly chat list (did you mean --show-secret? ghostly help chat list)"],
      [["send", "bob", "-1", "degrees"], "Unknown option -1 for ghostly send (put -- before text that starts with a dash; ghostly help send)"],
      [["chat", "rename", "bob", "-x"], "Unknown option -x for ghostly chat rename (put -- before text that starts with a dash; ghostly help chat rename)"],
      [["version", "-x"], "Unknown option -x for ghostly version (ghostly help version)"],
      [["status", "-x"], "Unknown option -x for ghostly status (ghostly help status)"],
      [["chat", "list", "-x"], "Unknown option -x for ghostly chat list (ghostly help chat list)"],
      [["profile", "list", "-x"], "Unknown option -x for ghostly profile list (ghostly help profile list)"],
      [["daemon", "status", "-x"], "Unknown option -x for ghostly daemon status (ghostly help daemon status)"],
    ] as const) {
      const result = await ghostly(["--home", dir, ...args]);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.json, args.join(" ")).toEqual({ error: { code: "usage", message } });
    }
    expect(existsSync(join(dir, "profiles"))).toBe(false);
  });

  it("--help=false is the command, and a global boolean's --no- form may come before the command", async () => {
    // `--no-pretty status` was "Unknown command: --no-pretty status"; `--help=true` ran the command (a `chat remove --yes` too).
    for (const args of [["--no-pretty", "version"], ["version", "--help=false"]]) {
      const { code, stdout, json } = await ghostly(args);
      expect(code, args.join(" ")).toBe(0);
      expect(json, args.join(" ")).toHaveProperty("version");
      expect(stdout.trim().split("\n")).toHaveLength(1);
    }
  });

  it("an option's value that reads -h or --help is the value, not a help request", async () => {
    // `profile set --name --help` printed profile set's help with exit 0 and changed nothing; `edit … --text "$NEW"` with
    // a text of "-h" did the same: a bot read exit 0 as done.
    const dir = home("help-as-value");
    expect(ok(await ghostly(["--home", dir, "profile", "create", "bot", "--name", "-h"]))).toMatchObject({ created: "bot", profile: { name: "-h" } });
    expect(ok(await ghostly(["--home", dir, "-p", "bot", "profile", "set", "--name", "--help"]))).toMatchObject({ profile: "bot", name: "--help" });
    // The parser's own reading of the line: `--reply -h` names a message, so the chat is looked for.
    for (const args of [["send", "bob", "hi", "--reply", "-h"], ["edit", "bob", "m1", "--text", "--help"]]) {
      const result = await ghostly(["--home", dir, "-p", "bot", ...args]);
      expect(error(result, "not_found", 3).message, args.join(" ")).toContain('No chat "bob"');
    }
    // A boolean before it, or a value given with `=`, leaves a later --help a help request.
    for (const args of [["send", "bob", "--force", "--help"], ["send", "bob", "--wait=sent", "-h"], ["daemon", "--timeout", "5", "--help"]]) {
      const result = await ghostly(["--home", dir, ...args]);
      expect(result.code, args.join(" ")).toBe(0);
      expect(result.stdout, args.join(" ")).toMatch(/^Usage: ghostly /);
    }
  });

  it("a word every object has (constructor, toString) is no command: unknown, and no profile is opened for it", async () => {
    // The commands are looked up in a table, where `constructor` was found too: `ghostly constructor` said
    // "ghostly undefined", and `ghostly constructor bob hi` opened the profile to answer "No method undefined" (exit 3).
    const dir = home("own-names");
    for (const args of [["constructor"], ["constructor", "bob", "hi"], ["toString", "bob"], ["__proto__", "bob", "hi"]]) {
      const result = await ghostly(["--home", dir, ...args]);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.json, args.join(" ")).toMatchObject({ error: { code: "usage", message: `Unknown command: ${args[0]} (ghostly help)` } });
    }
    expect(existsSync(join(dir, "profiles"))).toBe(false);
  });

  it("a line of only global options names no command: it is the help, not an unknown command", async () => {
    for (const args of [["--pretty"], ["--no-pretty"], ["-p", "bot"], ["--profile", "bot"], ["--profile=bot", "--pretty"], ["--home", "/h"]]) {
      const { code, stdout } = await ghostly(args);
      expect(code, args.join(" ")).toBe(0);
      expect(stdout, args.join(" ")).toContain("Usage: ghostly <command>");
    }
  });

  it("help help is help's own usage, not an unknown command", async () => {
    for (const args of [["help", "help"], ["help", "help", "--pretty"]]) {
      const { code, stdout } = await ghostly(args);
      expect(code, args.join(" ")).toBe(0);
      expect(stdout, args.join(" ")).toMatch(/^Usage: ghostly help \[<command>\.\.\.\]\n\n {2}Help for every command/);
    }
  });

  it("version --pretty is indented, as every command's answer is", async () => {
    for (const args of [["version", "--pretty"], ["--pretty", "version"], ["--version", "--pretty"], ["--pretty", "--version"]]) {
      const { code, stdout } = await ghostly(args);
      expect(code, args.join(" ")).toBe(0);
      expect(stdout, args.join(" ")).toMatch(/^\{\n {2}"version": "[^"]+"\n\}\n$/);
    }
    expect((await ghostly(["version"])).stdout).toMatch(/^\{"version":"[^"]+"\}\n$/);
  });

  it("version refuses a stray word or an unknown option, as every command does", async () => {
    // `version --json` (a typo) answered 0 with the version, as `version now foo` did.
    for (const [args, message] of [
      [["version", "now", "foo"], "Too many arguments: ghostly version"],
      [["--version", "extra"], "Too many arguments: ghostly version"],
      [["version", "--nope"], "Unknown option --nope for ghostly version (ghostly help version)"],
      [["--version", "--json"], "Unknown option --json for ghostly version (ghostly help version)"],
    ] as const) {
      const result = await ghostly([...args]);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.json, args.join(" ")).toEqual({ error: { code: "usage", message } });
    }
    // Global options still go with it.
    for (const args of [["version", "-p", "bot"], ["--home", "/h", "--version"]]) {
      const { code, json } = await ghostly(args);
      expect(code, args.join(" ")).toBe(0);
      expect(json, args.join(" ")).toHaveProperty("version");
    }
  });

  it("a global option that takes a value, given none, says so as a command's option does", async () => {
    for (const [args, name] of [[["-p"], "profile"], [["--profile"], "profile"], [["--home"], "home"], [["--pretty", "-p"], "profile"], [["send", "-p"], "profile"]] as const) {
      const result = await ghostly([...args]);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.json, args.join(" ")).toEqual({ error: { code: "usage", message: `--${name} needs a value` } });
    }
  });

  it("the version is in the help, and help version answers it", async () => {
    expect((await ghostly(["help"])).stdout).toMatch(/^ {2}version\s.*--version/m);
    const one = await ghostly(["help", "version"]);
    expect(one.code).toBe(0);
    expect(one.stdout).toContain("Usage: ghostly version");
    expect((await ghostly(["version"])).json).toHaveProperty("version");
    expect(JSON.parse((await ghostly(["--pretty", "--version"])).stdout)).toHaveProperty("version");
  });

  // At a fixed 58-column usage, 170 of the 195 lines of `ghostly help` passed 80 columns: every summary broke mid-word.
  it("is laid out to the terminal's width, and piped keeps each row on one line", async () => {
    const at = (columns: number, args: string[]) => ghostly(args, { env: { COLUMNS: String(columns) } }).then((r) => r.stdout);
    const flat = (text: string) => text.replace(/\s+/g, " ");
    for (const args of [["help"], ["help", "chat"], ["send", "--help"], ["help", "identity", "add"], ["help", "help"]]) {
      const text = await at(80, args);
      expect(text.split("\n").filter((line) => line.length > 80), args.join(" ")).toEqual([]);
    }
    const narrow = await at(80, ["help"]);
    // Under 100 columns or so, a summary goes under its usage, 4 in, and wraps between words there.
    expect(narrow).toMatch(/^ {2}profile list\n {4}Profiles, and which one is current$/m);
    expect(narrow).toMatch(/^ {2}chat history <chat> .*\n {6}\S.*\n {4}Messages, oldest first/m);
    expect(flat(narrow)).toContain("Make a profile (its own keys, chats and wallets)");
    expect(flat(narrow)).toContain("Exit codes: 0 done, 1 failed, 2 usage, 3 not found");
    const options = await at(80, ["send", "--help"]);
    expect(options).toMatch(/^ {2}--reply <value> +\S/m);
    const wide = await at(160, ["help"]);
    expect(wide.split("\n").filter((line) => line.length > 160)).toEqual([]);
    expect(wide).toMatch(/^ {2}profile list {2,}Profiles, and which one is current$/m);
    // Piped, as grep reads it: no wrapping.
    const piped = (await ghostly(["help"], { env: { COLUMNS: "" } })).stdout;
    expect(piped).toMatch(/^ {2}profile create <name> \[--use\] \[--name <shown name>\] {2,}Make a profile \(its own keys, chats and wallets\)$/m);
    expect(piped).toMatch(/^ {2}identity add <provider> \[subject\] .* \[--timeout s\]$/m);
  });

  it("bare ghostly in a new Ghostly folder starts with the first steps", async () => {
    const dir = home("first-steps");
    const first = await ghostly(["--home", dir]);
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/^First steps:\n {2}\$ ghostly invite create/m);
    expect(first.stdout).toContain("$ ghostly daemon --detach");
    expect(first.stdout).toContain("Usage: ghostly <command>");
    expect((await ghostly(["help", "--home", dir])).stdout).not.toContain("First steps");
    expect((await ghostly(["--home", dir, "profile", "create", "bot"])).code).toBe(0);
    expect((await ghostly(["--home", dir])).stdout).not.toContain("First steps");
  });

  it("shows an option only in the form the command takes, its text apart from it however long it is", async () => {
    const backup = (await ghostly(["help", "profile", "backup"])).stdout;
    // The command refuses a passphrase on the line: only --no-passphrase works.
    expect(backup).toMatch(/^ {2}--no-passphrase\s+Do not encrypt/m);
    expect(backup).not.toMatch(/^ {2}--passphrase\s/m);
    for (const words of [["profile", "backup"], ["profile", "restore"]]) {
      const { stdout } = await ghostly(["help", ...words]);
      expect(stdout, words.join(" ")).toMatch(/--passphrase-file <value> {2,}The passphrase/);
    }
  });
});
