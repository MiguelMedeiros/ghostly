import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A real GnuPG, in a throwaway home, holding the TEST keys committed with the
 * OpenPGP vectors (../vectors/openpgp). What it signs is what the app asked
 * for in this run, so the statement is always fresh. Unit tests and e2e share it.
 */
const vectors = join(import.meta.dirname, "../vectors/openpgp");
export const vector = (name: string) => readFileSync(join(vectors, name), "utf8");
export const fingerprints = JSON.parse(vector("fingerprints.json")) as Record<string, string>;

/** gpg signs and exports in milliseconds: one that has not answered by then is stuck, most likely on its agent. */
const STUCK_AFTER = 10_000;
const stuck = (e: unknown) => (e as { code?: string }).code === "ETIMEDOUT";

export class TestGpg {
  readonly home = mkdtempSync(join(tmpdir(), "ghostly-e2e-gpg-"));
  private readonly env = { ...process.env, GNUPGHOME: this.home, TZ: "UTC" };
  private readonly stuckAfter: number;
  constructor(keys: string[], { stuckAfter = STUCK_AFTER } = {}) {
    this.stuckAfter = stuckAfter;
    // Started up front: gpg's own autostart gives up after a few seconds on a busy machine.
    this.gpgconf("--launch", "gpg-agent");
    for (const key of keys) this.gpg(["--import"], vector(`${key}.sec.asc`));
  }
  private gpgconf(...args: string[]) {
    execFileSync("gpgconf", args, { env: this.env, stdio: "ignore", timeout: this.stuckAfter, killSignal: "SIGKILL" });
  }
  /**
   * These calls are synchronous: a gpg left waiting on an agent that no longer answers would hold the whole test
   * process, which then runs out of its own time without a word about gpg. So each call has `stuckAfter`, and a
   * stuck one is asked again of a new agent before the error names it.
   */
  private gpg(args: string[], input?: string, attempt = 1): string {
    try {
      return execFileSync("gpg", ["--batch", "--yes", "--no-tty", "--quiet", "--pinentry-mode", "loopback", "--passphrase", "", ...args],
        { env: this.env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: this.stuckAfter, killSignal: "SIGKILL" });
    } catch (e) {
      const stderr = String((e as { stderr?: string }).stderr ?? "");
      if (attempt < 3 && (stuck(e) || /agent/i.test(stderr))) {
        if (stuck(e)) try { this.gpgconf("--kill", "gpg-agent"); } catch { /* as stuck as gpg was */ }
        this.gpgconf("--launch", "gpg-agent");
        return this.gpg(args, input, attempt + 1);
      }
      if (stuck(e)) throw new Error(`gpg ${args.join(" ")} did not answer within ${this.stuckAfter} ms, ${attempt} times over${stderr.trim() ? `: ${stderr.trim()}` : ""}`, { cause: e });
      throw e;
    }
  }
  /** `gpg --clearsign`, exactly as the app's instructions say (the file has no final newline). `at` fakes gpg's clock (YYYYMMDDTHHMMSS). */
  clearsign(fingerprint: string, text: string, at?: string): string {
    const file = join(this.home, "ghostly-identity.txt");
    writeFileSync(file, text);
    return this.gpg([...(at ? ["--faked-system-time", `${at}!`] : []), "--local-user", fingerprint, "--clearsign", "--output", "-", file]);
  }
  /** What the second command of the instructions prints. */
  exportKey(fingerprint: string): string {
    return this.gpg(["--armor", "--export", "--export-options", "export-minimal", fingerprint]);
  }
  close() {
    try { this.gpgconf("--kill", "all"); } catch { /* no agent started */ }
    rmSync(this.home, { recursive: true, force: true });
  }
}

export const hasGpg = (() => { try { execFileSync("gpg", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
