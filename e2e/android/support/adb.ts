import { execFileSync } from "node:child_process";
import { PKG } from "./webViewPage";

/** Runs adb with `args` and gives back what it printed; throws as `execFileSync` does when it fails. */
export type AdbExec = (args: string[], timeout: number) => string;

const execAdb: AdbExec = (args, timeout) => execFileSync("adb", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout });

/** How long a device adb lost for a moment is waited for before the command that met it is run again. */
const OFFLINE_WAIT_MS = 60_000;

/** adb's failure for a device it has but cannot reach right now. */
const offline = (error: unknown) => {
  const failure = error as { stderr?: string; message?: string };
  return /device offline/.test(`${failure.stderr ?? ""}${failure.message ?? ""}`);
};

/** One device over adb: every command names its serial, since another session's emulator may share the adb server. */
export class Adb {
  constructor(readonly serial: string, private readonly exec: AdbExec = execAdb) {}

  /**
   * The emulator's adb drops for a moment now and then on a busy CI runner (between two specs): every command fails
   * at once with "device offline" meanwhile. Such a command waits for the device and runs once more; a device still
   * offline after that fails as it did.
   */
  run(...args: string[]): string {
    try {
      return this.exec(["-s", this.serial, ...args], 120_000);
    } catch (error) {
      if (!offline(error)) throw error;
      console.log(`  [android] adb: device offline at \`${args.join(" ")}\`: waiting for the device, then once more`);
      try {
        this.exec(["-s", this.serial, "wait-for-device"], OFFLINE_WAIT_MS);
      } catch {
        throw error;
      }
      return this.exec(["-s", this.serial, ...args], 120_000);
    }
  }

  /** As `run`, but a failure is its output, not an exception (`pm grant` of an undeclared permission, a missing file). */
  tryRun(...args: string[]): { ok: boolean; out: string } {
    try {
      return { ok: true, out: this.run(...args) };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message: string };
      return { ok: false, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` || failure.message };
    }
  }

  shell(command: string): string {
    return this.run("shell", command);
  }

  /** The device's lines since `logcat -c`, in the time format. */
  logcat(...filter: string[]): string {
    return this.run("logcat", "-d", "-v", "time", ...filter);
  }

  /** The emulator's port as the host's own: `adb reverse` for a TCP port on the host's loopback. */
  reverse(port: number): void {
    this.run("reverse", `tcp:${port}`, `tcp:${port}`);
  }

  unreverse(port: number): void {
    this.tryRun("reverse", "--remove", `tcp:${port}`);
  }

  /** The app's process id; "" when it has none (`pidof` fails then, and its failure is no id). */
  pid(): string {
    const found = this.tryRun("shell", "pidof", PKG);
    return found.ok ? found.out.trim() : "";
  }
}
