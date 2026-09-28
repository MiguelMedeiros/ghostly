import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ghostly } from "./support/cli";
// covers: headless.cli

/** The words that name a command in a usage line, up to its first argument or option (as main.ts reads them). */
const WORD = /^[a-z][a-z-]*$/;
const commandWords = (usage: string) => {
  const words: string[] = [];
  for (const word of usage.split(" ")) {
    if (!WORD.test(word)) break;
    words.push(word);
  }
  return words.join(" ");
};

/** The commands a README row names: each `usage` in its first cell, with `a\|b` alternatives spelled out. */
function named(row: string): string[] {
  const cell = row.split(/(?<!\\)\|/)[1];
  return [...cell.matchAll(/`([^`]+)`/g)].flatMap(([, usage]) => {
    let names = [""];
    for (const word of usage.split(" ")) {
      const alternatives = word.split("\\|");
      if (!alternatives.every((w) => WORD.test(w))) break;
      names = names.flatMap((name) => alternatives.map((w) => (name ? `${name} ${w}` : w)));
    }
    return names;
  });
}

const readme = readFileSync(resolve(import.meta.dirname, "../README.md"), "utf8").split("\n");
const header = readme.indexOf("| Command | What it does |");
const rows: string[] = [];
for (let i = header + 2; readme[i]?.startsWith("|"); i++) rows.push(readme[i]);

/**
 * The README's command table: one row per command or small family, in alphabetical order of the first command.
 * A pull request adding a command adds a row at its own place, not after the last one another pull request added.
 */
describe("the README's command table", () => {
  it("is found", () => {
    expect(rows.length).toBeGreaterThan(40);
  });

  it("is in alphabetical order of each row's first command", () => {
    const first = rows.map((row) => named(row)[0]);
    expect(first).toEqual([...first].sort());
  });

  it("has a row for every command of ghostly help, and no other", async () => {
    const { stdout } = await ghostly(["help"]);
    const commands = [...new Set(stdout.split("\n").filter((line) => /^ {2}[a-z]/.test(line)).map((line) => commandWords(line.trim())))];
    expect(commands.length).toBeGreaterThan(60);
    const documented = new Set(rows.flatMap(named));
    expect(commands.filter((c) => !documented.has(c))).toEqual([]);
    expect([...documented].filter((c) => !commands.includes(c))).toEqual([]);
  });
});
