import { describe, expect, it } from "vitest";
import { MENTION_LIMITS, STATUS_CARD_LIMITS } from "@ghostly/core";
import { parseArgs } from "../src/args";
import { COMMANDS, idSlot, positionals } from "../src/commands";
import { LIST_LIMITS, listAtMost } from "../src/commands/shared";
import { error, ghostly, home } from "./support/cli";

// covers: headless.cli

/**
 * A flag past the bound its help states, or a word it does not take, is a usage error (exit 2) naming the flag before
 * the profile opens, as `--tag`, `--link` and `--also` are. Before, a 7th `--button`, a 17th `--mention`, an
 * 81-character x401 `--label` and `--grant bogus` were `bad_request` (exit 1) once the profile was
 * open, a one-shot online first, `--button`'s in the card's words.
 */
describe("a list flag past its bound, or a word it does not take", { timeout: 60_000 }, () => {
  it("is a usage error naming the flag, before the profile opens", async () => {
    const dir = home("flag-caps");
    const many = (flag: string, count: number, value: (i: number) => string) => Array.from({ length: count }, (_, i) => [flag, value(i)]).flat();
    const buttons = many("--button", 7, (i) => `b${i}:B${i}`);
    for (const [args, message] of [
      [["send", "bob", "q", ...buttons], "--button is given at most 6 times, not 7"],
      [["group", "send", "Crew", "q", ...buttons], "--button is given at most 6 times, not 7"],
      [["group", "send", "Crew", "hi", ...many("--mention", 17, (i) => `m${i}`)], "--mention is given at most 16 times, not 17"],
      [["x401", "credential", "add", "cred.txt", "--label", "L".repeat(81)], "--label is up to 80 characters on one line, not 81"],
      [["x401", "credential", "add", "cred.txt", "--label", "a\u007fb"], "--label is up to 80 characters on one line, with no control character"],
      [["app", "serve", "app.ghostlyapp", "--grant", "chat", "--grant", "bogus"], "--grant takes chat or name, not \"bogus\""],
    ] as const) {
      expect(error(await ghostly(["--home", dir, ...args]), "usage", 2).message, args.slice(0, 3).join(" ")).toBe(message);
    }
  });

  it("counts a value given twice once, as the method does", () => {
    // 17 --mention of 16 members, one twice, get past the command line: the method counts each once too.
    const mention = Array.from({ length: 17 }, (_, i) => `m${i % 16}`);
    expect(() => listAtMost({ mention }, "mention")).not.toThrow();
    expect(() => listAtMost({ mention: [...mention, "m16"] }, "mention")).toThrow(expect.objectContaining({ code: "usage", message: "--mention is given at most 16 times, not 17" }));
  });

  it("leaves forward --to to the method, which counts a chat or group named two ways once", () => {
    // 7 --to naming 5 chats and groups (Bob by name and id, Crew by name and group:<id>), as oneMessageReads.test.ts has
    // the method take them: a one-shot reads the names only once the profile is open.
    const command = COMMANDS.forward;
    const to = ["Bob", "chat-two", "Crew", "group:g1", "Cy", "Di", "Ed"];
    const parsed = parseArgs(["Alice", "peer_1", ...to.flatMap((ref) => ["--to", ref])], command.options ?? {}, idSlot(command));
    expect(command.params!(parsed, positionals(command, parsed.positionals))).toMatchObject({ to });
  });

  it("are the engine's bounds", () => {
    expect(LIST_LIMITS).toEqual({ mention: MENTION_LIMITS.count });
    expect(STATUS_CARD_LIMITS.buttons).toBe(6);
  });
});
