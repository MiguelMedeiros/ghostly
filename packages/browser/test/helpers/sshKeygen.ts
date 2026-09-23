import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/** A throwaway key made by the real ssh-keygen, deleted after the test file. Test keys only. */
export interface SshTestKey { publicKey: string; sign(text: string, namespace?: string): string; signFile(text: string): string }

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

export function sshTestKey(type: "ed25519" | "ecdsa" | "rsa" = "ed25519"): SshTestKey {
  const dir = mkdtempSync(join(tmpdir(), "ghostly-ssh-test-"));
  dirs.push(dir);
  const key = join(dir, "id");
  execFileSync("ssh-keygen", ["-q", "-t", type, ...(type === "rsa" ? ["-b", "2048"] : []), "-N", "", "-C", "", "-f", key]);
  return {
    publicKey: readFileSync(`${key}.pub`, "utf8").trim(),
    // Exactly what the app's `printf '%s' '…' | ssh-keygen -Y sign` command does: stdin, no newline.
    sign: (text, namespace = "ghostly") => execFileSync("ssh-keygen", ["-Y", "sign", "-q", "-n", namespace, "-f", key], { input: text }).toString(),
    // The Windows route: the statement saved by an editor (with its newline), signed as a file.
    signFile: text => {
      const file = join(dir, "statement.txt");
      writeFileSync(file, `${text}\n`);
      rmSync(`${file}.sig`, { force: true });
      execFileSync("ssh-keygen", ["-Y", "sign", "-q", "-n", "ghostly", "-f", key, file]);
      return readFileSync(`${file}.sig`, "utf8");
    },
  };
}
