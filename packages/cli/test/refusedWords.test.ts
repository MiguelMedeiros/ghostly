import { describe, expect, it } from "vitest";
import { checkSettingKey, checkSettingValue, parseArgs } from "../src/args";
import { unknownCommand } from "../src/main";
import { checkProfileName } from "../src/profiles";
import { error, ghostly } from "./support/cli";
// covers: headless.cli

const NSEC = `nsec1${"q".repeat(58)}`;
const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PEM = ["-----BEGIN OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ", "-----END OPENSSH PRIVATE KEY-----"].join("\n");

const message = (run: () => unknown, label = ""): string => {
  try { run(); } catch (e) { return (e as Error).message; }
  throw new Error(`not refused: ${label}`);
};

/**
 * A refusal that repeats a typed word describes a long or secret-looking one instead (docs/CLI.md "Secrets stay
 * hidden"), as an unknown option's does: `ghostly nsec1…` printed `Unknown command: nsec1…`, a seed pasted after
 * `ghostly wallet` printed the seed, and a value an option, `settings set` or a profile name does not take was quoted
 * whole. Terminal scrollback, shell logs and agents reading stderr kept it.
 */
describe("a refused word", () => {
  it("is described, not printed, when it is long or a private key", () => {
    const cases: [string, () => unknown, RegExp][] = [
      [NSEC, () => { throw unknownCommand(NSEC); }, /^Unknown command: \(a private key\) \(ghostly help\)$/],
      [SEED, () => { throw unknownCommand("wallet", SEED); }, /^Unknown command: wallet \(a 93-character word\): ghostly wallet takes /],
      [PEM, () => { throw unknownCommand(PEM); }, /^Unknown command: \(a private key\) /],
      [NSEC, () => parseArgs(["--timeout", NSEC], { timeout: { type: "number", description: "" } }), /^--timeout takes a number, not \(a private key\)$/],
      [SEED, () => parseArgs(["--wait", SEED], { wait: { type: "string", description: "", choices: ["none", "sent"] } }), /^--wait takes none or sent, not \(a 93-character word\)$/],
      [NSEC, () => checkSettingKey(NSEC, { online: "boolean" }), /^\(a private key\) is not a setting the CLI changes/],
      [SEED, () => checkSettingValue("online", "boolean", SEED, SEED), /^online takes true or false, not \(a 93-character word\)/],
      [SEED, () => checkProfileName(SEED), /^Not a profile name: \(a 93-character word\) /],
    ];
    for (const [i, [secret, run, shown]] of cases.entries()) {
      const said = message(run, `case ${i}`);
      expect(said).toMatch(shown);
      expect(said).not.toContain(secret.slice(5, 40));
    }
  });

  it("is still printed when short, as before", () => {
    expect(message(() => { throw unknownCommand("frobnicate"); })).toBe("Unknown command: frobnicate (ghostly help)");
    expect(message(() => { throw unknownCommand("wallet", "frob"); })).toMatch(/^Unknown command: wallet frob: ghostly wallet takes /);
    expect(message(() => checkProfileName("bad/name"))).toMatch(/^Not a profile name: "bad\/name" /);
  });

  it("from the command line, for a pasted nsec in the command's place", { timeout: 60_000 }, async () => {
    const said = error(await ghostly([NSEC]), "usage", 2).message;
    expect(said).toBe("Unknown command: (a private key) (ghostly help)");
  });
});
