import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { BIN, ghostly } from "./support/cli";
// covers: headless.cli

/** The files the built CLI loads before it runs a command: its entry and every chunk imported statically from there. */
function loadedAtStart(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, spec] of readFileSync(file, "utf8").matchAll(/^(?:import|export)\b[^;]*?\bfrom\s*"(\.[^"]+)"/gm)) visit(join(dirname(file), spec));
  };
  visit(entry);
  return [...seen];
}

/**
 * A command a running daemon answers loads nothing of the engine: the API, the host and the protocol come in with
 * `import()` only where a command runs the profile here. They were all loaded first, ~100 ms of every `ghostly send`
 * an `--exec` hook made (Node alone starts in ~25 ms).
 */
it("loads no engine code before a command runs", async () => {
  const files = loadedAtStart(BIN);
  const engine = files.filter((file) => /class GhostlyNode\b|\bfake-indexeddb\b/.test(readFileSync(file, "utf8")));
  expect(engine).toEqual([]);
  // The command table, the arguments, the socket client and the help: well under the 2 MB it was.
  expect(files.reduce((sum, file) => sum + statSync(file).size, 0)).toBeLessThan(400_000);
  // And what is loaded still works on its own.
  const { code, json } = await ghostly(["version"]);
  expect(code).toBe(0);
  expect(json).toHaveProperty("version");
});
