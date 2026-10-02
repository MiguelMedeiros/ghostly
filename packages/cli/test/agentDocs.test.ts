import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ghostly } from "./support/cli";
// covers: headless.cli

/*
 * What an AI agent is taught (SKILL.md, the prompt and the guide in docs/AI-AGENTS.md, the /developers/agents page)
 * names only commands and flags this CLI has: an agent runs them as written. Every `ghostly <command>` in a code block,
 * an inline code span or the prompt is looked up in `ghostly help`, and each `--flag` after it in that command's help.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const DOCS = ["packages/cli/SKILL.md", "docs/AI-AGENTS.md", "apps/website/content/agents.ts"];
const GLOBAL = ["--profile", "--home", "--pretty", "--help", "--version"];
const WORD = /^[a-z][a-z-]*$/;

/** The words that name a command in a usage line, up to its first argument or option. */
const commandWords = (usage: string) => {
  const words: string[] = [];
  for (const word of usage.split(" ")) {
    if (!WORD.test(word)) break;
    words.push(word);
  }
  return words.join(" ");
};

/** The text an agent may run: fenced blocks, inline code spans and template strings. */
function code(text: string): string[] {
  const fenced = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].flatMap(([, body]) => body.replaceAll(/\\\n\s*/g, " ").split("\n")); // a line continued with \ is one
  const inline = [...text.replaceAll(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)].map(([, span]) => span);
  const quoted = [...text.matchAll(/(?:cmd|command): ['"]([^'"]+)['"]/g)].map(([, cmd]) => cmd);
  return [...fenced, ...inline, ...quoted];
}

/** Each `ghostly …` in a line: the words after it, up to where the command's own flags end. */
function invocations(line: string): string[] {
  return [...line.matchAll(/(?:^|[\s($"'])ghostly ((?:[^\s#|;&`)]|[ \t](?!ghostly ))+)/g)]
    .map(([, rest]) => rest.split(/[,.] |\s#|\|\||\||;|&&|\)/)[0].trim());
}

describe("what an agent is taught", async () => {
  const listing = (await ghostly(["help"])).stdout;
  const names = new Set(listing.split("\n").filter((l) => l.startsWith("  ") && WORD.test(l.trim().split(" ")[0])).map((l) => commandWords(l.trim())).filter(Boolean));
  names.add("help"); // `ghostly help <command>`
  const flagsOf = new Map<string, Set<string>>([["help", new Set()]]);
  async function flags(name: string): Promise<Set<string>> {
    if (!flagsOf.has(name)) {
      const help = (await ghostly(["help", ...name.split(" ")])).stdout;
      flagsOf.set(name, new Set([...help.matchAll(/--[a-z][a-z-]*/g)].map(([flag]) => flag)));
    }
    return flagsOf.get(name)!;
  }

  for (const doc of DOCS) {
    it(`${doc} runs only commands and flags ghostly has`, async () => {
      const text = readFileSync(resolve(ROOT, doc), "utf8");
      const prompt = /<!-- agent-prompt:start -->([\s\S]*?)<!-- agent-prompt:end -->/.exec(text)?.[1] ?? "";
      const lines = [...code(text), ...prompt.split("\n")];
      let checked = 0;
      for (const line of lines) {
        for (const call of invocations(line)) {
          const words = call.split(/\s+/);
          if (!WORD.test(words[0]) || words[0] === "and") continue; // "`ghostly` and …", a flag alone
          let name = "";
          for (let n = Math.min(words.length, 3); n > 0 && !name; n--) if (names.has(words.slice(0, n).join(" "))) name = words.slice(0, n).join(" ");
          expect(name, `${doc}: no command in "ghostly ${call}"`).not.toBe("");
          const known = await flags(name);
          for (const [flag] of call.matchAll(/(?<![\w-])--[a-z][a-z-]*/g))
            expect(known.has(flag) || GLOBAL.includes(flag), `${doc}: ghostly ${name} has no ${flag} ("ghostly ${call}")`).toBe(true);
          checked++;
        }
      }
      expect(checked, `${doc}: no ghostly commands found`).toBeGreaterThan(3);
    });
  }
});
