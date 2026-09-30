import { spawnSync } from "node:child_process";
import { expect, privateBus, test } from "../support/desktop";

/**
 * The bus each Desktop app under test gets (`privateBus`) starts nothing by itself. It used the system's session
 * configuration, so it could activate every service the machine installs: on a Linux desktop the first call into
 * xdg-desktop-portal started a whole set of portals on the person's live Wayland session, one set per app, and
 * xdg-desktop-portal-hyprland crashed as each bus went away (a crash notice on the person's screen per test).
 */
test("the private session bus activates no service", { tag: ["@feature:desktop.boot"] }, async () => {
  test.skip(process.platform !== "linux", "Linux only: a D-Bus session bus of its own");
  const bus = await privateBus();
  test.skip(!bus, "no dbus-daemon on this machine");
  try {
    const listed = spawnSync("dbus-send", [
      `--bus=${bus!.address}`, "--print-reply", "--type=method_call", "--dest=org.freedesktop.DBus",
      "/org/freedesktop/DBus", "org.freedesktop.DBus.ListActivatableNames",
    ], { encoding: "utf8" });
    expect(listed.status, listed.stderr).toBe(0);
    const names = [...listed.stdout.matchAll(/string "([^"]+)"/g)].map((match) => match[1]);
    // The bus names itself; nothing else may be started on demand.
    expect(names).toEqual(["org.freedesktop.DBus"]);
  } finally {
    bus!.stop();
  }
});
