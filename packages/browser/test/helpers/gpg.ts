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

export class TestGpg {
  readonly home = mkdtempSync(join(tmpdir(), "ghostly-e2e-gpg-"));
  private readonly env = { ...process.env, GNUPGHOME: this.home, TZ: "UTC" };
  constructor(keys: string[]) {
    // Started up front: gpg's own autostart gives up after a few seconds on a busy machine.
    execFileSync("gpgconf", ["--launch", "gpg-agent"], { env: this.env, stdio: "ignore" });
    for (const key of keys) this.gpg(["--import"], vector(`${key}.sec.asc`));
  }
  private gpg(args: string[], input?: string, attempt = 1): string {
    try {
      return execFileSync("gpg", ["--batch", "--yes", "--no-tty", "--quiet", "--pinentry-mode", "loopback", "--passphrase", "", ...args],
        { env: this.env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      if (attempt < 3 && /agent/i.test(String((e as { stderr?: string }).stderr))) {
        execFileSync("gpgconf", ["--launch", "gpg-agent"], { env: this.env, stdio: "ignore" });
        return this.gpg(args, input, attempt + 1);
      }
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
    try { execFileSync("gpgconf", ["--kill", "all"], { env: { ...process.env, GNUPGHOME: this.home }, stdio: "ignore" }); } catch { /* no agent started */ }
    rmSync(this.home, { recursive: true, force: true });
  }
}

export const hasGpg = (() => { try { execFileSync("gpg", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
