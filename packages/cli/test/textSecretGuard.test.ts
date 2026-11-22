import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";

// covers: headless.cli

const SEED = "legal winner thank year wave sausage worth useful legal winner thank yellow";
// NIP-19's example key: 63 characters, room in a group's or a profile's name (64).
const NSEC = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
const SECRET = /looks like a secret.*--force/;

/**
 * Every text a command sends off the device holds the secret guard `send` has (docs/CLI.md § Safety): a group's name,
 * the name contacts see, a file's name and an app revocation's reason, as the engine's own calls for them.
 */
describe("the secret guard on names and other texts that leave the device", { timeout: 120_000 }, () => {
  it("group create and group rename refuse a key as the name (exit 5) unless --force", async () => {
    const dir = home("group-name-secret");
    ok(await ghostly(["--home", dir, "profile", "create", "bot", "--use"]));
    expect(error(await ghostly(["--home", dir, "group", "create", NSEC, "--mesh"]), "confirm", 5).message).toMatch(SECRET);
    expect(error(await ghostly(["--home", dir, "group", "create", NSEC]), "confirm", 5).message).toMatch(SECRET);
    const { group } = ok(await ghostly(["--home", dir, "group", "create", "team", "--mesh"])) as { group: string };
    expect(error(await ghostly(["--home", dir, "group", "rename", group, NSEC]), "confirm", 5).message).toMatch(SECRET);
    expect(ok(await ghostly(["--home", dir, "group", "show", group]))).toMatchObject({ name: "team" });
    ok(await ghostly(["--home", dir, "group", "rename", group, NSEC, "--force"]));
    ok(await ghostly(["--home", dir, "group", "create", NSEC, "--mesh", "--force"]));
  });

  it("profile set, profile create and settings set nick refuse a key as the name contacts see unless --force", async () => {
    const dir = home("profile-name-secret");
    ok(await ghostly(["--home", dir, "profile", "create", "bot", "--use"]));
    expect(error(await ghostly(["--home", dir, "profile", "set", "--name", NSEC]), "confirm", 5).message).toMatch(SECRET);
    expect(error(await ghostly(["--home", dir, "settings", "set", "nick", NSEC]), "confirm", 5).message).toMatch(SECRET);
    expect(ok(await ghostly(["--home", dir, "profile", "show"]))).toMatchObject({ name: null });
    expect(error(await ghostly(["--home", dir, "profile", "create", "other", "--name", NSEC]), "confirm", 5).message).toMatch(SECRET);
    // Refused before the folder is made: the profile is not there.
    expect((ok(await ghostly(["--home", dir, "profile", "list"])).profiles as { name: string }[]).map((p) => p.name)).toEqual(["bot"]);
    expect(ok(await ghostly(["--home", dir, "profile", "set", "--name", NSEC, "--force"]))).toMatchObject({ name: NSEC });
    ok(await ghostly(["--home", dir, "settings", "set", "nick", NSEC, "--force"]));
    ok(await ghostly(["--home", dir, "profile", "create", "other", "--name", NSEC, "--force"]));
  });

  it("file send refuses a seed as the file's name (chat and group) unless --force", async () => {
    const dir = home("file-name-secret");
    ok(await ghostly(["--home", dir, "profile", "create", "bot", "--use"]));
    const path = join(dir, "a.txt");
    writeFileSync(path, "a");
    const { group } = ok(await ghostly(["--home", dir, "group", "create", "team", "--mesh"])) as { group: string };
    for (const target of ["nope", group]) {
      expect(error(await ghostly(["--home", dir, "file", "send", target, path, "--name", SEED]), "confirm", 5).message, target).toMatch(/name looks like a secret.*--force/);
    }
    // With --force it goes on, to the chat this profile does not have.
    error(await ghostly(["--home", dir, "file", "send", "nope", path, "--name", SEED, "--force"]), "not_found", 3);
  });

  it("file send holds the name that goes out: the file's own, and a key split by a character the name drops", async () => {
    const dir = home("file-own-name-secret");
    ok(await ghostly(["--home", dir, "profile", "create", "bot", "--use"]));
    const keyNamed = join(dir, `${NSEC}.txt`);
    writeFileSync(keyNamed, "a");
    const path = join(dir, "a.txt");
    writeFileSync(path, "a");
    const { group } = ok(await ghostly(["--home", dir, "group", "create", "team", "--mesh"])) as { group: string };
    const split = (cut: string) => `${NSEC.slice(0, 30)}${cut}${NSEC.slice(30)}.txt`;
    for (const target of ["nope", group]) {
      expect(error(await ghostly(["--home", dir, "file", "send", target, keyNamed]), "confirm", 5).message, target).toMatch(/name looks like a secret.*--force/);
      for (const cut of [":", "/", " ", "⠀"]) {
        expect(error(await ghostly(["--home", dir, "file", "send", target, path, "--name", split(cut)]), "confirm", 5).message, `${target} ${JSON.stringify(cut)}`).toMatch(/name looks like a secret.*--force/);
      }
    }
    // With --force it goes on, to the chat this profile does not have.
    error(await ghostly(["--home", dir, "file", "send", "nope", keyNamed, "--force"]), "not_found", 3);
    error(await ghostly(["--home", dir, "file", "send", "nope", path, "--name", split(":"), "--force"]), "not_found", 3);
  });

  it("app revoke refuses a seed as the reason unless --force", async () => {
    const dir = home("revoke-reason-secret");
    mkdirSync(join(dir, "app"));
    expect(error(await ghostly(["app", "revoke", join(dir, "app"), "--key", join(dir, "none.pem"), "--up-to", "1", "--reason", SEED]), "confirm", 5).message).toMatch(/reason looks like a secret.*--force/);
    // With --force it goes on, to the bundle that is not there.
    error(await ghostly(["app", "revoke", join(dir, "app"), "--key", join(dir, "none.pem"), "--up-to", "1", "--reason", SEED, "--force"]), "not_found", 3);
  });

  it("the engine's calls that name a group, the profile or a file hold it too", async () => {
    const dir = home("engine-name-secret");
    ok(await ghostly(["--home", dir, "profile", "create", "bot", "--use"]));
    const calls: [string, Record<string, unknown>][] = [
      ["createGroup", { name: NSEC, profile: "mesh" }],
      ["renameGroup", { groupId: "nope", name: NSEC }],
      ["updateSettings", { settings: { nick: NSEC } }],
      ["sendFile", { linkId: "nope", file: { id: "f", name: SEED, size: 1, mime: "text/plain" }, timestamp: 1 }],
      ["sendGroupFile", { groupId: "nope", file: { name: SEED, type: "text/plain", size: 1, data: "YQ==" } }],
    ];
    for (const [method, params] of calls) {
      expect(error(await ghostly(["--home", dir, "engine", method, JSON.stringify(params)]), "confirm", 5).message, method).toMatch(new RegExp(`looks like a secret.*call ${method} with --force`));
    }
    expect((await ghostly(["--home", dir, "engine", "renameGroup", JSON.stringify(calls[1][1]), "--force"])).code).not.toBe(5);
  });

  it("pay to a Lightning address on Mainnet asks for --confirm-real before it asks the address for an invoice", async () => {
    const dir = home("pay-mainnet-first");
    ok(await ghostly(["--home", dir, "profile", "create", "bot", "--use"]));
    expect(error(await ghostly(["--home", dir, "pay", "bob@example.invalid", "--amount", "1", "--comment", "hi", "--network", "mainnet"]), "confirm", 5).message).toMatch(/real money.*--confirm-real/);
  });
});
