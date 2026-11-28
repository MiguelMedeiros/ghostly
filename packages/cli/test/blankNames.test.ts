import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args";
import { cleanName } from "../src/apiKit";
import { COMMANDS, idSlot, positionals, takesText } from "../src/commands";
import { CliError } from "../src/errors";
import { error, ghostly, home } from "./support/cli";
// covers: headless.cli

/*
 * A name with nothing that shows (spaces only, a zero-width space) given to `group create`, `group rename`, `service
 * add`, `invite create|join --label` or `chat rename`: refused by the engine only once a one-shot had made and opened
 * the profile and gone online (0.4 to 1.3 s), `bad_request` (exit 1) in words that named no argument, while "" was a
 * usage error at once and `profile set --name` already said its own (`checkShownNameOption`). Now each is a usage error
 * (exit 2) naming the argument or option, before the profile opens, by the engine's own rule (`cleanName`).
 */
const line = (name: string, argv: string[]) => {
  const spec = COMMANDS[name], parsed = parseArgs(argv, spec.options ?? {}, idSlot(spec), { command: name, text: takesText(spec) });
  return spec.params!(parsed, positionals(spec, parsed.positionals));
};
const usage = (name: string, argv: string[]) => {
  try { line(name, argv); } catch (e) { expect(e, `${name} ${JSON.stringify(argv)}`).toBeInstanceOf(CliError); expect(e).toMatchObject({ code: "usage" }); return (e as Error).message; }
  throw new Error(`taken: ${name} ${JSON.stringify(argv)}`);
};

const ZWSP = "\u200b";
const SHOWS = "<name> needs a character that shows";
const LABEL = "--label needs a character that shows (an empty one gives back the contact's own)";
/** Each command, the line it is given a name on, and what it says of one with nothing that shows. */
const NAMED: [string, (name: string) => string[], string][] = [
  ["group create", (name) => [name], SHOWS],
  ["group create", (name) => [name, "--mesh"], SHOWS],
  ["group rename", (name) => ["g1", name], SHOWS],
  ["service add", (name) => [name, "http://127.0.0.1:4773"], SHOWS],
  ["invite create", (name) => ["--label", name], LABEL],
];

describe("a name with nothing that shows", () => {
  it("is a usage error naming the argument or option, by the engine's own rule", () => {
    for (const [name, argv, message] of NAMED) {
      for (const bad of [ZWSP, `\u202E${ZWSP}`, ` ${ZWSP}\u2060 `, "\u2800", "\u0301\u0301"]) {
        expect(cleanName(bad, Infinity), JSON.stringify(bad)).toBe("");
        expect(usage(name, argv(bad)), `${name} ${JSON.stringify(bad)}`).toBe(message);
      }
    }
    expect(usage("invite join", ["ghostly1x", "--label", ZWSP])).toBe(LABEL);
    expect(usage("chat rename", ["alice", ZWSP])).toBe(`${SHOWS} (an empty one gives back the contact's own)`);
    // A name of several words, each blank: still nothing that shows.
    expect(usage("group create", [" ", ZWSP])).toBe(SHOWS);
  });

  it("of spaces only is a usage error where a name is needed; \"\" is the missing one it was", () => {
    for (const [name, argv, message] of NAMED.filter(([name]) => name !== "invite create")) {
      for (const blank of ["   ", "\t", " \n "]) expect(usage(name, argv(blank)), `${name} ${JSON.stringify(blank)}`).toBe(message);
      expect(usage(name, argv(""))).toBe(`Missing <name>: ghostly ${COMMANDS[name].usage}`);
    }
  });

  it("of spaces only, or \"\", is still no label for an invite and the contact's own name for a chat, as the engine takes it", () => {
    for (const blank of ["", "   ", "\t"]) {
      expect(line("invite create", ["--label", blank])).toEqual({ label: blank });
      expect(line("invite join", ["ghostly1x", "--label", blank])).toMatchObject({ label: blank });
      expect(line("chat rename", ["alice", blank])).toEqual({ chat: "alice", name: blank });
    }
    expect(line("invite create", [])).toEqual({ label: undefined });
    expect(line("chat rename", ["alice"])).toEqual({ chat: "alice", name: "" });
  });

  it("is not what a name that shows is: given on as it came, for the engine to clean", () => {
    expect(line("group create", ["Team", ZWSP, "one"])).toMatchObject({ name: `Team ${ZWSP} one`, profile: "community" });
    expect(line("group create", ["Mesh", "--mesh"])).toMatchObject({ name: "Mesh", profile: "mesh" });
    expect(line("group rename", ["g1", " New  name "])).toMatchObject({ group: "g1", name: " New  name " });
    expect(line("service add", ["My app", "http://127.0.0.1:4773"])).toEqual({ name: "My app", target: "http://127.0.0.1:4773" });
    expect(line("invite create", ["--label", `${ZWSP}alice`])).toEqual({ label: `${ZWSP}alice` });
    expect(line("invite join", ["ghostly1x", "--label", "bob"])).toMatchObject({ label: "bob" });
    expect(line("chat rename", ["alice", "Alice", "B."])).toEqual({ chat: "alice", name: "Alice B." });
  });
});

describe("the built CLI with a name with nothing that shows", { timeout: 120_000 }, () => {
  it("exits 2 naming it before any profile is made or opened", async () => {
    for (const [name, argv, message] of NAMED) {
      for (const bad of [...(name === "invite create" ? [] : ["   "]), ZWSP]) {
        const dir = home("blank-name");
        const result = await ghostly(["--home", dir, ...name.split(" "), ...argv(bad)]);
        expect(error(result, "usage", 2).message, `${name} ${JSON.stringify(bad)}`).toBe(message);
        // No profile: a one-shot makes `default` on first use and opens it; the engine refused only from there.
        expect(existsSync(join(dir, "profiles")), `${name} ${JSON.stringify(bad)}: a profile was made`).toBe(false);
      }
    }
  });

  it("keeps \"\" the missing <name> it was, before any profile too", async () => {
    for (const [name, argv] of NAMED.filter(([name]) => name !== "invite create")) {
      const dir = home("blank-name");
      expect(error(await ghostly(["--home", dir, ...name.split(" "), ...argv("")]), "usage", 2).message).toBe(`Missing <name>: ghostly ${COMMANDS[name].usage}`);
      expect(existsSync(join(dir, "profiles"))).toBe(false);
    }
  });
});
