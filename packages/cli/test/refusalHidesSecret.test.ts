import { describe, expect, it } from "vitest";
import { error, ghostly, home } from "./support/cli";
// covers: headless.cli

/**
 * A secret typed where a file or a chat goes is not said back (docs/CLI.md "Secrets stay hidden"): the passphrase
 * given as --passphrase-file, the SD-JWT VC given as `x401 credential add`'s file, a Cashu token given as a chat.
 * Before, the first two came back as the path that was not there, and the token as `No chat "cashuB…"`.
 */
describe("a refusal does not say back a secret typed in the wrong place", { timeout: 120_000 }, () => {
  const dir = home("refusal-hides-secret");
  const run = (...args: string[]) => ghostly(["--home", dir, ...args], { cwd: dir });

  it("a passphrase given as --passphrase-file", async () => {
    const passphrase = "correct horse battery staple";
    const result = await run("profile", "backup", "--out", "b.backup", "--passphrase-file", passphrase);
    expect(error(result, "not_found", 3).message).toBe("--passphrase-file names no file: give the path of the file that holds the passphrase");
    expect(result.stdout + result.stderr).not.toContain("horse");
  });

  it("an SD-JWT VC given in place of its file, short or too long for a file name", async () => {
    for (const [credential, code, exit] of [[`eyJ${"a".repeat(300)}~eyJ${"b".repeat(40)}~`, "bad_request", 1], [`eyJ${"c".repeat(60)}~`, "not_found", 3]] as const) {
      const result = await run("x401", "credential", "add", credential);
      expect(error(result, code, exit).message).toBe("<file> names no file: give the path of the file that holds the SD-JWT VC the issuer sent, or - to read it from stdin");
      expect(result.stdout + result.stderr).not.toContain(credential.slice(0, 20));
    }
  });

  it("a Cashu token, a wallet connection link or a private key given as a chat or a group", async () => {
    const token = `cashuBo2Ft${"d".repeat(150)}`;
    for (const args of [["chat", "history", token], ["send", token, "hi"], ["listen", "--group", token], ["listen", "--from", token]]) {
      const result = await run(...args);
      expect(error(result, "not_found", 3).message, args[0]).toContain("(a Cashu token)");
      expect(result.stdout + result.stderr, args[0]).not.toContain(token.slice(0, 12));
    }
    const link = "nostr+walletconnect://abc?relay=wss://r&secret=" + "e".repeat(64);
    const result = await run("chat", "history", link);
    expect(error(result, "not_found", 3).message).toBe("No chat (a wallet connection link) (ghostly chat list)");
    const nsec = `nsec1${"q".repeat(58)}`;
    const group = await run("group", "history", nsec);
    expect(error(group, "not_found", 3).message).toContain("(a private key)");
    expect(group.stdout + group.stderr).not.toContain(nsec.slice(0, 10));
  });
});
