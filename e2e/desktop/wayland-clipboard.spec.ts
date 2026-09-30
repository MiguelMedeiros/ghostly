import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachDesktopLogs, desktopHome, expect, openDesktop, test } from "../support/desktop";

/**
 * On a Wayland desktop (GNOME, KDE, Hyprland, Sway…) something copied in a Wayland app reached the Desktop app's
 * Rust clipboard as nothing: `arboard` was built without `wayland-data-control`, so it read only the X11 clipboard.
 * Join → Paste from clipboard said "Clipboard is empty", and pasting a copied picture or file sent nothing.
 *
 * A Wayland session of its own (headless Sway) holds the clipboard, so the person's own is never read or changed; the
 * window stays where the other tests draw it (GDK_BACKEND=x11) and only the clipboard is on Wayland.
 */
test("Join → Paste reads what a Wayland app copied", { tag: ["@feature:invite.clipboard"] }, async ({ network }, testInfo) => {
  test.skip(process.platform !== "linux", "Linux only: Wayland");
  const tools = ["sway", "wl-copy"].filter((tool) => spawnSync("sh", ["-c", `command -v ${tool}`]).status !== 0);
  test.skip(tools.length > 0, `needs ${tools.join(" and ")} (sway, wl-clipboard)`);

  const wayland = await headlessSway();
  const home = desktopHome("wayland-clipboard");
  try {
    // WAYLAND_DISPLAY as a path: the app keeps its own XDG_RUNTIME_DIR (sound, the person's session) for the rest.
    const env = { ...network, WAYLAND_DISPLAY: wayland.socket, GDK_BACKEND: "x11" };
    const { app, stop } = await openDesktop({ home: home.dir, env });
    try {
      await expect.poll(() => app.text('[title="Join chat"]')).not.toBeNull();
      // Not an invite: what the app says about it shows the text was read. An empty read says "Clipboard is empty".
      wayland.copy("hello from a Wayland app");
      await app.click('[title="Join chat"]');
      await expect.poll(() => app.text('[aria-labelledby="join-title"]')).toContain("Paste from clipboard");
      await app.click('[aria-labelledby="join-title"] button.bg-accent');
      await expect.poll(() => app.text('[aria-labelledby="join-title"]'), { message: "the pasted text was read" })
        .toContain("This is not a Ghostly invite.");
      expect(await app.text('[aria-labelledby="join-title"]')).not.toContain("Clipboard is empty");
    } finally {
      await stop();
      attachDesktopLogs("wayland-clipboard", home.dir);
    }
  } finally {
    wayland.stop();
    home.remove();
    if (testInfo.status !== testInfo.expectedStatus) console.log(wayland.log());
  }
});

/** Sway with no screen (wlroots' headless backend) in a runtime folder of its own, and `copy` into its clipboard. */
async function headlessSway(): Promise<{ socket: string; copy: (text: string) => void; log: () => string; stop: () => void }> {
  const runtime = mkdtempSync(join(tmpdir(), "ghostly-wayland-"));
  const config = join(runtime, "sway.conf");
  // No X server in the runner (and none needed): without this Sway logs a failed Xwayland start.
  writeFileSync(config, "output HEADLESS-1 resolution 1280x800\nxwayland disable\n");
  const env: Record<string, string | undefined> = {
    ...process.env, XDG_RUNTIME_DIR: runtime,
    WLR_BACKENDS: "headless", WLR_RENDERER: "pixman", WLR_LIBINPUT_NO_DEVICES: "1",
  };
  for (const key of ["DISPLAY", "SWAYSOCK", "WAYLAND_DISPLAY"]) delete env[key];
  let out = "";
  const sway: ChildProcess = spawn("sway", ["--config", config], { env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [sway.stdout, sway.stderr]) stream?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  // Sway names its socket itself (wayland-1, the first free one): it does not take the name from WAYLAND_DISPLAY.
  // The runtime folder is its own, so the one wayland-N socket in it is Sway's.
  let display: string | undefined;
  for (const end = Date.now() + 15_000; ; await new Promise((done) => setTimeout(done, 100))) {
    display = readdirSync(runtime).find((name) => /^wayland-\d+$/.test(name));
    if (display) break;
    if (sway.exitCode !== null || Date.now() > end) throw new Error(`headless sway did not start:\n${out}`);
  }
  env.WAYLAND_DISPLAY = display;
  const socket = join(runtime, display);
  // wl-copy serves the clipboard from a process of its own until something else is copied; `--foreground` would block.
  const copy = (text: string) => {
    const done = spawnSync("wl-copy", [], { input: text, env: { ...env }, stdio: ["pipe", "ignore", "ignore"], timeout: 10_000 });
    if (done.status !== 0) throw new Error(`wl-copy failed (${done.status ?? done.error})`);
  };
  const stop = () => {
    spawnSync("wl-copy", ["--clear"], { env: { ...env }, stdio: "ignore", timeout: 5_000 });
    sway.kill("SIGTERM");
    rmSync(runtime, { recursive: true, force: true });
  };
  return { socket, copy, log: () => out, stop };
}
