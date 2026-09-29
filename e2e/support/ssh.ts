import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A throwaway SSH key made by the real ssh-keygen, the tool the app tells people to run. It lives in
 * a temporary directory for one test and is deleted by `dispose()`; nothing about it is committed.
 */
export interface TestSshKey {
  /** The `.pub` line without a comment. */
  publicKey: string;
  /** `ssh-keygen -Y sign` over exactly `text` (no trailing newline), as the app's command does. */
  sign(text: string, namespace?: string): string;
  dispose(): void;
}

export function testSshKey(type: "ed25519" | "ecdsa" = "ed25519"): TestSshKey {
  const dir = mkdtempSync(join(tmpdir(), "ghostly-e2e-ssh-"));
  const key = join(dir, "id");
  execFileSync("ssh-keygen", ["-q", "-t", type, "-N", "", "-C", "", "-f", key]);
  return {
    publicKey: readFileSync(`${key}.pub`, "utf8").trim(),
    sign: (text, namespace = "ghostly") => execFileSync("ssh-keygen", ["-Y", "sign", "-q", "-n", namespace, "-f", key], { input: text }).toString(),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
