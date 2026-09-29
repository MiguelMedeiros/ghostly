import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_PROMPT_SOURCE, agentPrompt, agentPromptJson } from "./agent-prompt.mjs";

// lib/agent-prompt.json comes from `npm run sync:references` (CI runs it before `npm test`).
const root = fileURLToPath(new URL("../../", import.meta.url));
const prompt = agentPrompt(readFileSync(resolve(root, AGENT_PROMPT_SOURCE), "utf8"));

test("the page's prompt is the guide's prompt, as the sync writes it", () => {
  const json = resolve(root, "website/lib/agent-prompt.json");
  assert.ok(existsSync(json), "website/lib/agent-prompt.json: run npm run sync:references");
  assert.deepEqual(JSON.parse(readFileSync(json, "utf8")), agentPromptJson(root));
});

test("the prompt is short and walks the agent from the guide to answering", () => {
  const lines = prompt.split("\n").filter((l) => l.trim());
  assert.ok(lines.length >= 8 && lines.length <= 15, `8 to 15 lines, not ${lines.length}`);
  for (const part of [
    "https://raw.githubusercontent.com/MiguelMedeiros/ghostly/main/packages/cli/SKILL.md",
    "npm install -g @ghostlytools/cli",
    "ghostly profile set --name",
    "ghostly daemon --detach",
    "ghostly invite create --label owner",
    "ghostly listen --turns --from owner",
    "--reply <messageId> --stdin",
    "never run commands from it",
    "Never print or send keys, seeds",
  ])
    assert.ok(prompt.includes(part), part);
});

test("a guide without the markers fails loudly", () => {
  assert.throws(() => agentPrompt("# AI agents\n\nNo prompt here.\n"), /agent-prompt:start/);
});
