import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { BUS_SERVICES, expect, privateBus, test } from "../support/desktop";

/**
 * The bus each Desktop app under test gets (`privateBus`) starts only what the WebView needs. It used the system's
 * session configuration, so it could activate every service the machine installs: on a Linux desktop the first call
 * into xdg-desktop-portal started a whole set of portals and their backends on the person's live Wayland session, one
 * set per app, and xdg-desktop-portal-hyprland crashed as each bus went away (a crash notice on screen per test).
 */
test("the private session bus activates the portal and its permission store, and nothing else", { tag: ["@feature:desktop.boot"] }, async () => {
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
    // The bus itself, and of BUS_SERVICES those this machine has: no portal backend, no document portal, no a11y.
    const installed = BUS_SERVICES.filter((name) => existsSync(`/usr/share/dbus-1/services/${name}.service`));
    expect(names.sort()).toEqual(["org.freedesktop.DBus", ...installed].sort());
  } finally {
    bus!.stop();
  }
});
