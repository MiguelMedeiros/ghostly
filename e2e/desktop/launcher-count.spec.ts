import { spawn, spawnSync } from "node:child_process";
import { desktopHome, expect, openDesktop, privateBus, test } from "../support/desktop";

/**
 * The unread count on the Linux launcher (apps/desktop/src/unread_count.rs). Tauri's window badge resolved and showed
 * nothing: it reaches the launcher only through libunity while Unity itself runs, which no current desktop does. The
 * docks that show a count (KDE Plasma, Dash to Dock) read the Unity launcher API's `Update` signal from the session
 * bus, so the app sends it itself, for its desktop entry. Here a listener on the app's own bus stands in for the dock.
 */
test("on Linux the unread count reaches a dock on the session bus, for the app's desktop entry", { tag: ["@feature:app.attention.badge"] }, async () => {
  test.skip(process.platform !== "linux", "Linux only: the launcher entry is a D-Bus signal");
  test.skip(spawnSync("dbus-monitor", ["--help"]).error !== undefined, "no dbus-monitor on this machine");
  test.setTimeout(3 * 60_000);
  const bus = await privateBus();
  test.skip(!bus, "no dbus-daemon on this machine");
  const home = desktopHome("launcher");
  const dock = spawn("dbus-monitor", ["--address", bus!.address, "type='signal',interface='com.canonical.Unity.LauncherEntry',member='Update'"], { stdio: ["ignore", "pipe", "ignore"] });
  let heard = "";
  dock.stdout!.on("data", (chunk: Buffer) => (heard += chunk.toString()));
  try {
    const { app, stop } = await openDesktop({ home: home.dir, profile: "launcher", env: { DBUS_SESSION_BUS_ADDRESS: bus!.address } });
    try {
      const count = (n: number) => app.executeAsync<string>(`
        const done = arguments[arguments.length - 1];
        window.__TAURI_INTERNALS__.invoke("native_unread_count", { count: ${n} }).then(() => done("sent"), (e) => done(String(e)));`);
      // What the dock heard: the desktop entry, the count and whether it shows (in either order).
      const said = () => ({
        entry: heard.includes('string "application://Ghostly.desktop"'),
        count: heard.match(/string "count"\s+variant\s+int64 (\d+)/)?.[1] ?? null,
        visible: heard.match(/string "count-visible"\s+variant\s+boolean (\w+)/)?.[1] ?? null,
      });
      expect(await count(3)).toBe("sent");
      await expect.poll(said, { timeout: 10_000 }).toEqual({ entry: true, count: "3", visible: "true" });
      heard = "";
      expect(await count(0)).toBe("sent");
      await expect.poll(said, { timeout: 10_000 }).toEqual({ entry: true, count: "0", visible: "false" });
    } finally {
      await stop();
    }
  } finally {
    dock.kill("SIGTERM");
    bus!.stop();
    home.remove();
  }
});
