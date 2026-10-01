import { describe, expect, it } from "vitest";
import { ghostly } from "./support/cli";
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
});
