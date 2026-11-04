import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
// covers: headless.cli

/*
 * How an agent behaves in a chat (👀 at once, a thinking status changed at each step, short quoted answers, 👍 for a
 * plain "ok", buttons for a decision) is taught by both skills: the CLI's SKILL.md, which the copy prompt points to,
 * near its top, and the owner skill's loop. Both name the same rules, so an agent set up from either behaves alike.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");
const RULES = ["React 👀 at once", "Show what you are doing", "Answer, quoting their message", "A pure ack is a reaction", "Ask with buttons when they must decide"];

it("both skills teach the same rules for a chat", () => {
  for (const doc of ["packages/cli/SKILL.md", "packages/cli/skills/ghostly/SKILL.md"])
    for (const rule of RULES) expect(read(doc), `${doc}: "${rule}"`).toContain(`**${rule}`);
});

it("the CLI skill has them before its first step, with the commands to run", () => {
  const skill = read("packages/cli/SKILL.md");
  const block = skill.slice(skill.indexOf("## How to behave in a chat"), skill.indexOf("## When to use"));
  expect(skill.indexOf("## How to behave in a chat"), "the block").toBeGreaterThan(0);
  expect(skill.indexOf("## How to behave in a chat"), "before the steps").toBeLessThan(skill.indexOf("## Steps"));
  for (const command of ["ghostly react owner <messageId> 👀", "ghostly typing owner --kind thinking --status", "ghostly send owner --reply <messageId> --stdin", "ghostly react owner <messageId> 👍"])
    expect(block).toContain(command);
});

it("the copy prompt sends the agent to those rules and reacts 👀 at once", () => {
  const prompt = /<!-- agent-prompt:start -->([\s\S]*?)<!-- agent-prompt:end -->/.exec(read("docs/AI-AGENTS.md"))?.[1] ?? "";
  for (const part of ['"How to behave in a chat"', "ghostly react owner <messageId> 👀", "--kind thinking", "change it at each step"])
    expect(prompt).toContain(part);
});
