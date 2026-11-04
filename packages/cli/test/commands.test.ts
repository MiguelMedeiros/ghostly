import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS, TEXT_COMMANDS } from "../src/commands";
// covers: headless.cli

const DIR = resolve(import.meta.dirname, "../src/commands");
const AREAS = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !["index.ts", "shared.ts"].includes(f));

/**
 * One file per area, src/commands/<area>.ts, each in alphabetical order: pull requests adding commands at the same
 * time add them to different files, or at different places of one file, instead of all at the end of one list.
 */
describe("the command files", () => {
  it.each(AREAS)("%s is in alphabetical order", async (file) => {
    const { commands } = (await import(`../src/commands/${file.replace(/\.ts$/, "")}`)) as { commands: Record<string, unknown> };
    const names = Object.keys(commands);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toEqual([...names].sort());
  });

  it("every area is in COMMANDS, and no command is in two areas", async () => {
    const all: string[] = [];
    for (const file of AREAS) all.push(...Object.keys(((await import(`../src/commands/${file.replace(/\.ts$/, "")}`)) as { commands: object }).commands));
    expect(all.length).toBe(new Set(all).size);
    expect(Object.keys(COMMANDS).sort()).toEqual(all.sort());
  });
});

/**
 * The usage line is what `ghostly help`, the README and every usage error show: an option the command takes is in it,
 * or people learn of it only from `<command> --help`.
 */
describe("the usage lines", () => {
  const rows = Object.entries({ ...COMMANDS, ...TEXT_COMMANDS }).filter(([, c]) => c.options);
  it.each(rows)("%s shows every option it takes", (_, command) => {
    const shown = (flag: string) => new RegExp(`(?<![\\w-])--${flag}(?![\\w-])`).test(command.usage);
    expect(Object.keys(command.options!).filter((flag) => !shown(flag))).toEqual([]);
  });
});
