import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// covers: headless.hooks

/**
 * The echo bot the README and examples/echo-bot.sh show is a `listen --exec` script, and `--exec` runs through
 * `/bin/sh` (listen.ts, `shell: true`): on Debian and Ubuntu that is dash, which has no bash here-strings (`<<<`).
 * The site's copies (/cli and docs/CLI.md) are held to the same by apps/website/scripts/echo-bot.test.mjs. Each copy runs here, under /bin/sh and under dash when this machine has it, with the event on stdin as
 * listen hands it over; `ghostly` is a fake on PATH that writes down what it was asked, jq the real one.
 */

const ROOT = resolve(import.meta.dirname, "..");
const SOURCES = ["README.md", "examples/echo-bot.sh"];
const SHELLS = ["/bin/sh", "/bin/dash"].filter((shell) => existsSync(shell));
const hasJq = spawnSync("jq", ["--version"]).status === 0;   // skipped without jq here, never in CI

/** The `--exec '…'` script of the echo bot in a file. */
function echoScript(file: string): string {
  const text = readFileSync(join(ROOT, file), "utf8");
  const found = text.match(/listen --type message\.received --cursor \S+ --exec '([^']*)'/);
  if (!found) throw new Error(`no echo bot in ${file}`);
  return found[1];
}

function run(shell: string, script: string, event: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "ghostly-echo-bot-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const out = join(root, "call");
  writeFileSync(join(bin, "ghostly"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(`${out}.args`)}\ncat > ${JSON.stringify(`${out}.stdin`)}\n`);
  chmodSync(join(bin, "ghostly"), 0o755);
  const result = spawnSync(shell, ["-c", script], { input: JSON.stringify(event), encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const read = (suffix: string) => (existsSync(`${out}.${suffix}`) ? readFileSync(`${out}.${suffix}`, "utf8") : null);
  return { status: result.status, stderr: result.stderr, args: read("args"), stdin: read("stdin") };
}

describe.skipIf(!hasJq).each(SOURCES)("the echo bot in %s", (file) => {
  it.each(SHELLS)("answers under %s: the text back on stdin, to the chat it came from", (shell) => {
    const got = run(shell, echoScript(file), { type: "message.received", chat: "chat-1", message: { text: "-a text that starts with a dash" } });
    expect(got.stderr).toBe("");
    expect(got.status).toBe(0);
    expect(got.args).toBe("send\nchat-1\n--stdin\n");
    expect(got.stdin).toBe("echo: -a text that starts with a dash");
  });
});
