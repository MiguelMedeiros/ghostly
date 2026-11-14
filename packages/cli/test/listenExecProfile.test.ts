import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ghostly, home, hyperdhtTestnet, localRelay, ok, Running } from "./support/cli";
// covers: headless.cli

/**
 * A `listen --exec` hook runs on the profile and folder the listen was given: its own `ghostly send` acts on them.
 * Before, a hook got the environment the listen was started in, so with `--profile bot` (or `--home`) its answer went
 * to the current profile: "No chat …", or the same chat there, answered from another identity.
 */
let relay: { url: string; server: HttpServer };
let dht: { bootstrap: string; destroy(): Promise<void> };
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  relay = await localRelay();
  dht = await hyperdhtTestnet();
  env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap, GHOSTLY_PKARR_RELAYS: relay.url };
}, 30_000);

afterAll(async () => {
  await dht?.destroy();
  relay?.server.close();
}, 30_000);

describe("listen --exec hooks", { timeout: 120_000 }, () => {
  for (const withDaemon of [true, false]) {
    it(`run on the listen's --profile and --home, not the ones of its environment (${withDaemon ? "following a daemon" : "running the profile itself"})`, async () => {
      const dir = home(`exec-profile-${withDaemon ? "daemon" : "own"}`), elsewhere = home("exec-profile-elsewhere");
      ok(await ghostly(["--home", dir, "profile", "create", "bot"], { env }));
      ok(await ghostly(["--home", dir, "--profile", "bot", "settings", "set", "relays", JSON.stringify([relay.url])], { env }));
      const log = join(dir, "hook.log"), hook = join(dir, "hook.sh");
      writeFileSync(hook, `echo "$GHOSTLY_PROFILE|$GHOSTLY_HOME" >> '${log}'\n`);
      // What the hook would act on without the flags: another folder, another profile.
      const outer = { ...env, GHOSTLY_HOME: elsewhere, GHOSTLY_PROFILE: "default" };
      if (withDaemon) ok(await ghostly(["--home", dir, "--profile", "bot", "daemon", "--detach"], { env }));
      const listen = new Running(["--home", dir, "--profile", "bot", "listen", "--type", "daemon.started", "--since", "0", "--exec", `sh '${hook}'`], outer);
      try {
        const line = await (async () => {
          for (const end = Date.now() + 30_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) {
            if (existsSync(log)) { const text = readFileSync(log, "utf8"); if (text.includes("\n")) return text.split("\n")[0]; }
          }
          throw new Error(`no hook ran\n${listen.stderr}`);
        })();
        expect(line).toBe(`bot|${dir}`);
      } finally {
        await listen.stop();
        if (withDaemon) await ghostly(["--home", dir, "--profile", "bot", "daemon", "stop"], { env });
      }
    });
  }
});
