import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ghostly, home, localRelay, ok } from "./support/cli";
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
});
