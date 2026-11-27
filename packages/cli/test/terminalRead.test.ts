import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { noteTerminalRead, TERMINAL_READ } from "../src/commands/shared";
import { ghostly, home } from "./support/cli";
// covers: headless.cli

/**
 * The commands that read stdin on a terminal (instead of refusing it) sat there with no word until Ctrl-D: they now say
 * how to end what is typed, on stderr, before they read. On a pipe or a file they say nothing, and stdout and the exit
 * code are what they were.
 */
describe("a read of stdin on a terminal", () => {
  it("says how to end it on a terminal only", () => {
    const said: string[] = [];
    noteTerminalRead(true, (text) => said.push(text));
    expect(said).toEqual([`ghostly: ${TERMINAL_READ}\n`]);
    expect(TERMINAL_READ).toBe(process.platform === "win32" ? "Reading from the terminal: end with Ctrl-Z, then Enter" : "Reading from the terminal: end with Ctrl-D");
    noteTerminalRead(false, (text) => said.push(text));
    expect(said).toHaveLength(1);
  });

  it("every reader that keeps reading on a terminal says it on stderr, then reads; on a pipe nothing", { timeout: 120_000 }, async () => {
    const dir = home("terminal-read");
    // Stdin taken for a terminal's: the CLI asks `isatty(0)`, which a test's pipe never is. Only that: making
    // `process.stdin` here would turn the pipe non-blocking under the command's own `readSync(0)`.
    const tty = join(dir, "tty.cjs");
    writeFileSync(tty, "const tty = require(\"node:tty\"); const isatty = tty.isatty; tty.isatty = (fd) => fd === 0 || isatty(fd); require(\"node:module\").syncBuiltinESMExports();\n");
    const terminal = { NODE_OPTIONS: `--require "${tty}"` };
    const line = `ghostly: ${TERMINAL_READ}\n`;
    // What each answers once it read what came: a usage error before any profile opens.
    const notJson = { error: { code: "usage", message: "--json is not valid JSON" } };
    for (const [args, input, answer] of [
      [["engine", "getState", "-"], "not json", { error: { code: "usage", message: "The parameters must be JSON (an object)" } }],
      [["app", "send", "bob", "chess", "-"], "not json", { error: { code: "usage", message: "The message is not valid JSON: quote it for the shell, like '{\"k\":\"move\"}', or pass - and write it on stdin" } }],
      [["send", "bob", "--stdin"], " \n", { error: { code: "usage", message: expect.stringMatching(/^No text: ghostly send <chat>/) } }],
      [["edit", "bob", "me_w", "--stdin"], " \n", { error: { code: "usage", message: expect.stringMatching(/^No text: ghostly edit <chat>/) } }],
      [["group", "send", "Crew", "--stdin"], " \n", { error: { code: "usage", message: expect.stringMatching(/^No text: ghostly group send <group>/) } }],
      [["group", "edit", "Crew", "mekey:1:0", "--stdin"], " \n", { error: { code: "usage", message: expect.stringMatching(/^No text: ghostly group edit <group>/) } }],
      [["routine", "send", "bob", "--json", "-"], "not json", notJson],
      [["routine", "update", "bob", "r1", "--json", "-"], "not json", notJson],
      [["task", "send", "bob", "--json", "-"], "not json", notJson],
      [["task", "update", "bob", "t1", "--json", "-"], "not json", notJson],
      [["usage", "send", "bob", "--json", "-"], "not json", notJson],
    ] as [string[], string, unknown][]) {
      const name = args.join(" ");
      const typed = await ghostly(["--home", dir, ...args], { env: terminal, input });
      const piped = await ghostly(["--home", dir, ...args], { input });
      expect(typed.json, name).toEqual(answer);
      expect(typed.code, name).toBe(2);
      expect(typed.stderr.split(line).length - 1, `${name}: ${typed.stderr}`).toBe(1);
      expect(typed.stderr.startsWith(line), `${name}: ${typed.stderr}`).toBe(true);
      expect(typed.stdout, name).not.toContain(TERMINAL_READ);
      // A pipe: the same answer and stdout, and no line.
      expect(piped.stdout, name).toBe(typed.stdout);
      expect(piped.code, name).toBe(typed.code);
      expect(piped.stderr, name).not.toContain(TERMINAL_READ);
    }
  });

  it("a reader that refuses a terminal still refuses it, with no line", async () => {
    const dir = home("terminal-refused");
    const tty = join(dir, "tty.cjs");
    // Both ways of asking: nothing is read here, so `process.stdin` may be made.
    writeFileSync(tty, "Object.defineProperty(process.stdin, \"isTTY\", { value: true }); const tty = require(\"node:tty\"); const isatty = tty.isatty; tty.isatty = (fd) => fd === 0 || isatty(fd); require(\"node:module\").syncBuiltinESMExports();\n");
    const typed = await ghostly(["--home", dir, "wallet", "redeem", "-"], { env: { NODE_OPTIONS: `--require "${tty}"` } });
    expect(typed.code).toBe(2);
    expect(typed.json).toEqual({ error: { code: "usage", message: "Missing <cashu-token>: give it as an argument or on stdin (… | ghostly wallet redeem)" } });
    expect(typed.stderr).not.toContain(TERMINAL_READ);
  });
});
