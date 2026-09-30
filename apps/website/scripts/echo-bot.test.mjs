import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The echo bot the site shows on /cli (content/cli.ts) and carries in llms-full.txt (docs/CLI.md) is a `ghostly listen
// --exec` script, which the CLI runs with /bin/sh: dash on Debian and Ubuntu, with no bash here-strings (`<<<`). Each
// copy runs under /bin/sh, and under dash when this machine has it, with the event on stdin and a fake `ghostly` on
// PATH. packages/cli/test/echoBotExample.test.ts holds the README's and examples/echo-bot.sh to the same.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const shells = ["/bin/sh", "/bin/dash"].filter((shell) => existsSync(shell));
const hasJq = spawnSync("jq", ["--version"]).status === 0;

function echoScript(file) {
  const found = readFileSync(resolve(root, file), "utf8").match(/listen --type message\.received --cursor \S+ --exec '([^']*)'/);
  assert.ok(found, `no echo bot in ${file}`);
  // The site's copy is a template literal: its `\\` is one backslash on the page.
  return file.endsWith(".ts") ? found[1].replaceAll("\\\\", "\\") : found[1];
}

for (const file of ["apps/website/content/cli.ts", "docs/CLI.md"]) {
  for (const shell of shells) {
    test(`the echo bot in ${file} answers under ${shell}`, { skip: !hasJq && "no jq here (CI has it)" }, () => {
      const dir = mkdtempSync(join(tmpdir(), "ghostly-site-echo-"));
      mkdirSync(join(dir, "bin"));
      const out = join(dir, "call");
      writeFileSync(join(dir, "bin", "ghostly"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(`${out}.args`)}\ncat > ${JSON.stringify(`${out}.stdin`)}\n`);
      chmodSync(join(dir, "bin", "ghostly"), 0o755);
      const event = { type: "message.received", chat: "chat-1", message: { text: "-a text that starts with a dash" } };
      const run = spawnSync(shell, ["-c", echoScript(file)], { input: JSON.stringify(event), encoding: "utf8", env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` } });
      assert.equal(run.stderr, "");
      assert.equal(run.status, 0);
      assert.equal(readFileSync(`${out}.args`, "utf8"), "send\nchat-1\n--stdin\n");
      assert.equal(readFileSync(`${out}.stdin`, "utf8"), "echo: -a text that starts with a dash");
    });
  }
}
