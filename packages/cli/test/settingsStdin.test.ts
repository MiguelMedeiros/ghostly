import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { error, ghostly, home, localRelay, ok } from "./support/cli";
// covers: headless.cli

/**
 * A TURN password went to `settings set iceServers` on the command line only, where it shows in `ps` and stays in the
 * shell's history: `-` (or no value on a pipe) now reads the value from stdin, and one on the command line is warned.
 */
describe("settings set from stdin", { timeout: 120_000 }, () => {
  let relay: Awaited<ReturnType<typeof localRelay>>;
  let env: NodeJS.ProcessEnv;
  const dir = home("settings-stdin");
  const turn = (credential: string) => JSON.stringify([{ urls: "turn:t.example.org:3478", username: "u", credential }]);

  beforeAll(async () => {
    relay = await localRelay();
    env = { GHOSTLY_PKARR_RELAYS: relay.url };
  });
  afterAll(() => relay?.server.close());

  it("iceServers - takes a TURN password on stdin, with no warning, and keeps it", async () => {
    const run = await ghostly(["--home", dir, "settings", "set", "iceServers", "-"], { env, input: `${turn("from-stdin")}\n` });
    ok(run);
    expect(run.stderr).not.toMatch(/shows in ps/);
    const shown = ok(await ghostly(["--home", dir, "settings", "get", "--show-secret"], { env }));
    expect(JSON.stringify(shown)).toContain("from-stdin");
  });

  it("a TURN password on the command line still goes, with the ps and history warning", async () => {
    const run = await ghostly(["--home", dir, "settings", "set", "iceServers", turn("on-the-line")], { env });
    ok(run);
    expect(run.stderr).toContain("ghostly: A TURN password on the command line shows in ps and the shell's history: give it on stdin instead (… | ghostly settings set iceServers -)");
  });

  it("a setting with no value reads it from a pipe", async () => {
    ok(await ghostly(["--home", dir, "settings", "set", "sendTyping"], { env, input: "false\n" }));
    expect(ok(await ghostly(["--home", dir, "settings", "get"], { env }))).toMatchObject({ sendTyping: false });
  });

  it("iceServers - on a terminal is refused at once with the usage error, and nothing is set", async () => {
    // Stdin taken for a terminal's: the CLI reads `process.stdin.isTTY` (and `isatty(0)`), which a test's pipe never is.
    const tty = join(dir, "tty.cjs");
    writeFileSync(tty, "Object.defineProperty(process.stdin, \"isTTY\", { value: true }); const tty = require(\"node:tty\"); const isatty = tty.isatty; tty.isatty = (fd) => fd === 0 || isatty(fd); require(\"node:module\").syncBuiltinESMExports();\n");
    // What comes on that stdin is never read: the refusal is not about it.
    const run = await ghostly(["--home", dir, "settings", "set", "iceServers", "-"], { env: { ...env, NODE_OPTIONS: `--require "${tty}"` }, input: `${turn("typed")}\n` });
    expect(error(run, "usage", 2).message).toBe("Missing <json-value> on stdin: … | ghostly settings set iceServers -");
    expect(run.stderr).not.toMatch(/Ctrl-D/);
    const shown = ok(await ghostly(["--home", dir, "settings", "get", "--show-secret"], { env }));
    expect(JSON.stringify(shown)).not.toContain("typed");
    // The same through a pipe: read and set.
    ok(await ghostly(["--home", dir, "settings", "set", "iceServers", "-"], { env, input: `${turn("piped")}\n` }));
    expect(JSON.stringify(ok(await ghostly(["--home", dir, "settings", "get", "--show-secret"], { env })))).toContain("piped");
  });
});
