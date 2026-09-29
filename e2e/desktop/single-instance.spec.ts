import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { desktopBinary, desktopHome, expect, homeEnv, openDesktop, test } from "../support/desktop";

/**
 * One Ghostly per profile (src-tauri/src/single_instance.rs). Started twice on one profile, two peers ran with the
 * same keys: the contact held one instance's channel, refused the other's as crossed, and the chat stopped. Now the
 * second launch hands over to the running app (its window comes forward) and exits; another profile still runs.
 *
 * The apps get a session bus of their own (the plugin holds its name there): none on a CI runner, and never the
 * person's own on a desktop.
 */

/** A private session bus, or null where there is no `dbus-daemon`. */
async function privateBus(): Promise<{ address: string; stop: () => void } | null> {
  if (spawnSync("dbus-daemon", ["--version"]).status !== 0) return null;
  const daemon = spawn("dbus-daemon", ["--session", "--nofork", "--print-address=1"], { stdio: ["ignore", "pipe", "ignore"] });
  const address = await new Promise<string>((done, fail) => {
    let out = "";
    daemon.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("\n")) done(out.trim());
    });
    daemon.once("exit", (code) => fail(new Error(`dbus-daemon exited (${code})`)));
  });
  return { address, stop: () => void daemon.kill("SIGTERM") };
}

/** Starts the app the way a person does, with no driver: the process, and whether (and how) it has exited. */
function launch(env: Record<string, string>): { app: ChildProcess; exited: Promise<number | null> } {
  const app = spawn(desktopBinary(), [], { stdio: "ignore", env: { ...process.env, GHOSTLY_E2E: "1", GHOSTLY_FAKE_MEDIA: "1", ...env } });
  return { app, exited: new Promise((done) => app.once("exit", (code) => done(code))) };
}

const within = <T,>(promise: Promise<T>, ms: number) =>
  Promise.race([promise.then((value) => ({ value })), new Promise<null>((done) => setTimeout(() => done(null), ms))]);

test("a second launch on the same profile hands over to the running app and exits; another profile runs", { tag: ["@feature:desktop.single-instance"] }, async () => {
  test.skip(process.platform !== "linux", "Linux only: macOS opens the running app itself");
  test.setTimeout(4 * 60_000);
  const bus = await privateBus();
  test.skip(!bus, "no dbus-daemon on this machine");
  const home = desktopHome("single");
  const running: ChildProcess[] = [];
  try {
    const env = { DBUS_SESSION_BUS_ADDRESS: bus!.address, GHOSTLY_PROFILE: "single" };
    const { app, stop } = await openDesktop({ home: home.dir, profile: "single", env });
    try {
      await expect.poll(() => app.text('[title="New Chat"]'), { timeout: 90_000 }).not.toBeNull();

      const again = launch({ ...homeEnv(home.dir), ...env });
      running.push(again.app);
      const ended = await within(again.exited, 60_000);
      expect(ended, "the second launch on the same profile exits").not.toBeNull();
      expect(ended!.value).toBe(0);
      // The first is untouched.
      expect(await app.text('[title="New Chat"]')).not.toBeNull();

      // Another profile in the same home is another person's peer: it runs.
      const other = launch({ ...homeEnv(home.dir), ...env, GHOSTLY_PROFILE: "single-other" });
      running.push(other.app);
      expect(await within(other.exited, 20_000), "another profile keeps running").toBeNull();
    } finally {
      await stop();
    }
  } finally {
    for (const app of running) if (app.exitCode === null) app.kill("SIGKILL");
    bus!.stop();
    home.remove();
  }
});
