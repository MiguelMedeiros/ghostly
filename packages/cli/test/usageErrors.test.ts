import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { error, ghostly, home } from "./support/cli";
// covers: headless.cli

const CREATE = "profile create <name> [--use] [--name <shown name>] [--force]";
const USE = "profile use <name>";
const SET = "profile set [--name <name>] [--share-profile | --no-share-profile] [--force]";
const BACKUP = "profile backup --out <file> [--passphrase-file f | --no-passphrase] [--light]";
const RESTORE = "profile restore <file> <new profile> [--passphrase-file f] [--use]";
const ENGINE = "engine <method> [json-params | -] [--confirm-real] [--show-secret] [--yes] [--force]";
const SETTINGS = "settings set <key> <json-value> [--force]";
const IDENTITY = "identity add <provider> [subject] [--signer id] [--field name=value]... [--stdin] [--days n] [--timeout s]";
const AUTO = "call auto [on|off] [--from <chat>]... [--rate 48000]";
const REVOKE = "app revoke <dir> --key <file> (--digest <digest>... | --up-to <sequence>) [--reason <text>] [--bundle <file>] [--force]";
const EDIT = "edit <chat> <message> [text... | --text <text> | --stdin] [--force] [--wait none|confirmed] [--timeout s]";
const GROUP_SEND = "group send <group> [text...] [--mention <member>]... [--reply <message>] [--button id:Label]... [--style id=primary|neutral|danger]... [--once] [--id id] [--stdin] [--force] [--wait none|sent] [--timeout s]";

/**
 * A usage error says what is wrong, then the command's whole usage line, as `ghostly help <command>` shows it. These
 * printed the line alone (`profile create` for two names too), and some of the lines had lost options.
 */
describe("a usage error", { timeout: 120_000 }, () => {
  const cases: [args: string[], reason: string, usage: string, command: string[]][] = [
    [["profile", "create"], "Missing <name>", CREATE, ["profile", "create"]],
    [["profile", "create", "two", "names"], "Too many arguments", CREATE, ["profile", "create"]],
    [["profile", "use"], "Missing <name>", USE, ["profile", "use"]],
    [["profile", "set"], "Nothing to change", SET, ["profile", "set"]],
    [["profile", "backup"], "Missing --out", BACKUP, ["profile", "backup"]],
    [["profile", "restore"], "Missing <file>", RESTORE, ["profile", "restore"]],
    [["profile", "restore", "file"], "Missing <new profile>", RESTORE, ["profile", "restore"]],
    [["engine"], "Missing <method>", ENGINE, ["engine"]],
    [["engine", "getState", "{}", "extra"], "Too many arguments", ENGINE, ["engine"]],
    [["settings", "set"], "Missing <key>", SETTINGS, ["settings", "set"]],
    [["settings", "set", "online"], "Missing <json-value>", SETTINGS, ["settings", "set"]],
    [["settings", "set", "online", "true", "extra"], "Too many arguments", SETTINGS, ["settings", "set"]],
    [["identity", "add"], "Missing <provider>", IDENTITY, ["identity", "add"]],
    [["call", "auto", "maybe"], "call auto takes on or off, not \"maybe\"", AUTO, ["call", "auto"]],
    [["app", "revoke", "dir"], "--key <file> is needed", REVOKE, ["app", "revoke"]],
    [["app", "revoke", "dir", "--key", "k"], "Give --digest (again for each) or --up-to, one of the two", REVOKE, ["app", "revoke"]],
    [["edit"], "Missing <chat>", EDIT, ["edit"]],
    [["edit", "bob"], "Missing <message>", EDIT, ["edit"]],
    [["group", "send"], "Missing <group>", GROUP_SEND, ["group", "send"]],
  ];

  it.each(cases)("%j says what is wrong and the whole usage", async (args, reason, usage, command) => {
    const dir = home("usage-errors");
    expect(error(await ghostly(["--home", dir, ...args]), "usage", 2).message).toBe(`${reason}: ghostly ${usage}`);
    expect((await ghostly(["help", ...command])).stdout).toContain(`Usage: ghostly ${usage}\n`);
  });

  it("for an empty command name shows the empty name", async () => {
    for (const args of [[""], ["help", ""], ["", "--help"]]) {
      expect(error(await ghostly(args), "usage", 2).message, JSON.stringify(args)).toBe("Unknown command: \"\" (ghostly help)");
    }
  });

  it("for group call --sfu with no https origin, or one past the limit, comes before the profile opens", async () => {
    // Before: bad_request (exit 1) once the profile was open and the group found, and for a group not there not_found
    // (exit 3) first. The value is not repeated in the message.
    const dir = home("usage-sfu");
    const origin = "--sfu takes the call node's https origin, like https://call.example.com";
    for (const [sfu, message] of [["not-a-url", origin], ["http://x", origin], [`https://${"a".repeat(200)}.com`, "--sfu is too long: a call node is an https origin of at most 200 characters"]]) {
      for (const group of ["hunters", "nosuch"]) {
        expect(error(await ghostly(["--home", dir, "group", "call", group, "--sfu", sfu]), "usage", 2).message, `${group} ${sfu}`).toBe(message);
      }
    }
    // No profile was made or opened.
    expect(readdirSync(dir)).toEqual([]);
  });
});
