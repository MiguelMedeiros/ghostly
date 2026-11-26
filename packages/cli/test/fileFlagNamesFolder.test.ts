import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ghostly, ok, Running } from "./support/cli";
// covers: apps.bundle, headless.cli

/*
 * A file option given with a separator at its end (`app publish --out sub/`, `--key keys/`, `listen --cursor curx/`)
 * names a folder: resolving the path dropped the slash, and with no such folder the bundle, the new key or the cursor
 * was written as a file of that name (the next publish packed the stray bundle `sub` into the app). Refused now, as
 * `file save --path` refuses one, before anything is written.
 */

const tmp = () => mkdtempSync(join(tmpdir(), "ghostly-file-flag-folder-"));
const missing = (path: string) => ({ error: { code: "not_found", message: `No such folder: ${path} (make it first, or name a file in a folder that is there)` } });
const running: Running[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map((r) => r.stop())); });

describe("a file option ending in a separator", () => {
  it("app publish --out sub/ with no sub folder writes no bundle named sub", async () => {
    const root = tmp(), dir = join(root, "myapp"), key = join(root, "k1.key");
    ok(await ghostly(["app", "init", dir]));
    const result = await ghostly(["app", "publish", dir, "--key", key, "--out", `${join(dir, "sub")}/`]);
    expect(result.code, result.stdout + result.stderr).toBe(3);
    expect(result.json).toEqual(missing(join(dir, "sub")));
    expect(existsSync(join(dir, "sub"))).toBe(false);
    expect(existsSync(key)).toBe(false);
    // A file there in the folder's place is named as a file.
    writeFileSync(join(root, "plain"), "x");
    expect((await ghostly(["app", "publish", dir, "--key", key, "--out", `${join(root, "plain")}/`])).json).toEqual({ error: { code: "not_found", message: `${join(root, "plain")} is a file, not a folder: name a file in a folder that is there` } });
    // Without the slash, the same name is a bundle's file, as before.
    expect(ok(await ghostly(["app", "publish", dir, "--key", key, "--out", join(root, "out.ghostlyapp")]))).toMatchObject({ sequence: 1 });
  }, 60_000);

  it("app publish --key keys/ with no keys folder writes no key named keys", async () => {
    const root = tmp(), dir = join(root, "myapp");
    ok(await ghostly(["app", "init", dir]));
    const result = await ghostly(["app", "publish", dir, "--key", `${join(root, "keys")}/`]);
    expect(result.code, result.stdout + result.stderr).toBe(3);
    expect(result.json).toEqual(missing(join(root, "keys")));
    expect(readdirSync(root)).toEqual(["myapp"]);
    expect(existsSync(join(dir, "app.ghostlyapp"))).toBe(false);
  }, 60_000);

  it("listen --cursor curx/ with no curx folder is refused before anything starts", async () => {
    const root = tmp(), home = tmp();
    const listen = new Running(["--home", home, "listen", "--cursor", `${join(root, "curx")}/`]);
    running.push(listen);
    expect(await listen.exited(20_000)).toBe(3);
    expect(listen.lines.at(-1)).toEqual(missing(join(root, "curx")));
    expect(readdirSync(root)).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  }, 60_000);
});
