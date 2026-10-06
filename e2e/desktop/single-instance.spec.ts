import { spawn, type ChildProcess } from "node:child_process";
import { openSync } from "node:fs";
import { desktopBinary, desktopHome, expect, homeEnv, openDesktop, privateBus, test } from "../support/desktop";

/**
 * One Ghostly per profile (apps/desktop/src/single_instance.rs). Started twice on one profile, two peers ran with the
 * same keys: the contact held one instance's channel, refused the other's as crossed, and the chat stopped. Now the
 * second launch hands over to the running app (its window comes forward) and exits; another profile still runs.
 *
 * The apps share one session bus of their own (the plugin holds its name there): none on a CI runner, and never the
 * person's own on a desktop.
 */

/** Starts the app the way a person does, with no driver: the process, and whether (and how) it has exited. */
// DIAGNOSTIC (r10f, not for merge): GHOSTLY_SI_DEBUG=<dir> keeps each launch's stderr (GLib/GDBus debug on) and the
// private bus's traffic there, and prints how long each phase took.
const DEBUG = process.env.GHOSTLY_SI_DEBUG;
let launches = 0;
function launch(env: Record<string, string>): { app: ChildProcess; exited: Promise<number | null> } {
  const err = DEBUG ? openSync(`${DEBUG}/launch-${++launches}.stderr`, "w") : "ignore";
  const app = spawn(desktopBinary(), [], { stdio: ["ignore", "ignore", err], env: { ...process.env, GHOSTLY_E2E: "1", GHOSTLY_FAKE_MEDIA: "1", ...(DEBUG ? { G_MESSAGES_DEBUG: "all", RUST_LOG: "zbus=trace" } : {}), ...env } });
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
  const t0 = Date.now(), mark = (what: string) => { if (DEBUG) console.log(`SI_DEBUG ${((Date.now() - t0) / 1000).toFixed(1)} s ${what}`); };
  const monitor = DEBUG ? spawn("dbus-monitor", ["--address", bus!.address], { stdio: ["ignore", openSync(`${DEBUG}/bus.log`, "w"), "ignore"] }) : null;
  const running: ChildProcess[] = [];
  try {
    const env = { DBUS_SESSION_BUS_ADDRESS: bus!.address, GHOSTLY_PROFILE: "single" };
    const { app, stop } = await openDesktop({ home: home.dir, profile: "single", env });
    try {
      await expect.poll(() => app.text('[title="New chat"]'), { timeout: 90_000 }).not.toBeNull();
      mark("first app ready");

      const again = launch({ ...homeEnv(home.dir), ...env });
      running.push(again.app);
      mark("second launch started");
      const ended = await within(again.exited, 60_000);
      mark(`second launch ${ended ? `exited ${ended.value}` : "still running at 60 s"}`);
      expect(ended, "the second launch on the same profile exits").not.toBeNull();
      expect(ended!.value).toBe(0);
      // The first is untouched.
      expect(await app.text('[title="New chat"]')).not.toBeNull();

      // Another profile in the same home is another person's peer: it runs.
      const other = launch({ ...homeEnv(home.dir), ...env, GHOSTLY_PROFILE: "single-other" });
      running.push(other.app);
      expect(await within(other.exited, 20_000), "another profile keeps running").toBeNull();
    } finally {
      await stop();
    }
  } finally {
    for (const app of running) if (app.exitCode === null) app.kill("SIGKILL");
    monitor?.kill("SIGTERM");
    bus!.stop();
    home.remove();
  }
});
