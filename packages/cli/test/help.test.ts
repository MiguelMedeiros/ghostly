import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ghostly, home } from "./support/cli";
// covers: headless.cli

/** Help per command and per group, as a person or a bot asks for it: `help <words>` or `<words> --help`. */
describe("help", () => {
  it("for a group lists its commands, whichever way it is asked", async () => {
    for (const args of [["help", "file"], ["file", "--help"], ["file", "-h"]]) {
      const { code, stdout } = await ghostly(args);
      expect(code, args.join(" ")).toBe(0);
      expect(stdout).toContain("ghostly file:");
      expect(stdout).toContain("file wait [<chat>] <file> [--timeout s]");
      expect(stdout).toContain("file accept [<chat>] <file>");
      expect(stdout).not.toContain("chat list");
    }
  });

  it("for one command shows its usage, what it does and its options", async () => {
    for (const args of [["help", "file", "save"], ["file", "save", "--help"], ["file", "save", "c1-in-x", "--help"]]) {
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
      expect(stdout, args.join(" ")).toMatch(/--timeout <n>\s+Seconds --detach waits for it to start/);
      expect(stdout, args.join(" ")).toContain("ghostly daemon: 3 more commands (ghostly help daemon <command> for one)");
      expect(stdout.indexOf("--detach waits"), args.join(" ")).toBeLessThan(stdout.indexOf("daemon status"));
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

  it("a word every object has (constructor, toString) is no command: unknown, and no profile is opened for it", async () => {
    // The commands are looked up in a table, where `constructor` was found too: `ghostly constructor` said
    // "ghostly undefined", and `ghostly constructor bob hi` opened the profile to answer "No method undefined" (exit 3).
    const dir = home("own-names");
    for (const args of [["constructor"], ["constructor", "bob", "hi"], ["toString", "bob"], ["__proto__", "bob", "hi"]]) {
      const result = await ghostly(["--home", dir, ...args]);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.json, args.join(" ")).toMatchObject({ error: { code: "usage", message: `Unknown command: ${args.slice(0, 2).join(" ")} (ghostly help)` } });
    }
    expect(existsSync(join(dir, "profiles"))).toBe(false);
  });

  it("a line of only global options names no command: it is the help, not an unknown command", async () => {
    for (const args of [["--pretty"], ["-p", "bot"], ["--profile", "bot"], ["--profile=bot", "--pretty"], ["--home", "/h"]]) {
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
