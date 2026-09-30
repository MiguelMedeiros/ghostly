// The "copy this into your agent" prompt of /developers/agents is written once, in docs/AI-AGENTS.md, between
// <!-- agent-prompt:start --> and <!-- agent-prompt:end --> in a ```text fence. sync-references.mjs cuts it out into
// lib/agent-prompt.json, which the page imports, so the page and the guide never drift.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const AGENT_PROMPT_SOURCE = "docs/AI-AGENTS.md";

/** The prompt's text in `markdown` (the guide), without its fence. Throws when the markers or the fence are missing. */
export function agentPrompt(markdown) {
  const found = markdown.match(/<!-- agent-prompt:start -->\n```text\n([\s\S]*?)\n```\n<!-- agent-prompt:end -->/);
  if (!found) throw new Error(`${AGENT_PROMPT_SOURCE}: no \`\`\`text block between <!-- agent-prompt:start --> and <!-- agent-prompt:end -->`);
  return found[1];
}

/** The prompt as lib/agent-prompt.json holds it. `root` is the repository's root. */
export function agentPromptJson(root) {
  return { source: AGENT_PROMPT_SOURCE, prompt: agentPrompt(readFileSync(resolve(root, AGENT_PROMPT_SOURCE), "utf8")) };
}
