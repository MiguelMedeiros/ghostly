import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { error, ghostly, ok } from "./support/cli";
// covers: apps.bundle, apps.store

/*
 * `app publish` and `store sign` with a --key that is a symbolic link to nothing (a key on a drive that is not
 * mounted): the link is no key, so the run would make one, and the key was never written over the link. Before, Node's
 * raw "EEXIST: file already exists". The answer names the link and where it leads, and says no key was made; the
 * link and its target are left as they were.
 */

const tmp = () => mkdtempSync(join(tmpdir(), "ghostly-key-link-"));
const VECTORS = resolve(import.meta.dirname, "../../core/test/vectors");
const storeVectors = JSON.parse(readFileSync(join(VECTORS, "app-store.json"), "utf8")) as { valid: { index: string }[] };

/** A link at `<dir>/name` to a key on a drive that is not there. */
function danglingLink(name: string): { link: string; target: string } {
  const target = join(tmp(), "unmounted", name);
  const link = join(tmp(), name);
  symlinkSync(target, link);
  return { link, target };
}

function expectUntouched(link: string, target: string): void {
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readlinkSync(link)).toBe(target);
  expect(existsSync(target)).toBe(false);
}

describe.skipIf(process.platform === "win32")("--key on a symbolic link to nothing", () => {
  it("app publish names the link, makes no key and writes no bundle", async () => {
    const dir = join(tmp(), "demo");
    ok(await ghostly(["app", "init", dir]));
    const { link, target } = danglingLink("publisher.key");
    const refusal = error(await ghostly(["app", "publish", dir, "--key", link]), "engine", 1);
    expect(refusal.message).toBe(`${link} is a symbolic link to ${target}, which is not there (a drive that is not mounted?): no key was made. Make the link's target reachable, or name another --key`);
    expect(refusal.message).not.toContain("EEXIST");
    expectUntouched(link, target);
    expect(existsSync(join(dir, "app.ghostlyapp"))).toBe(false);
  }, 60_000);

  it("store sign names the link, makes no key and writes no index", async () => {
    const dir = tmp();
    const { key: _key, ...unsigned } = JSON.parse(storeVectors.valid[0].index) as Record<string, unknown>;
    writeFileSync(join(dir, "index.json"), JSON.stringify(unsigned));
    const { link, target } = danglingLink("store.key");
    const refusal = error(await ghostly(["store", "sign", join(dir, "index.json"), "--key", link]), "engine", 1);
    expect(refusal.message).toBe(`${link} is a symbolic link to ${target}, which is not there (a drive that is not mounted?): no key was made. Make the link's target reachable, or name another --key`);
    expectUntouched(link, target);
    expect(existsSync(join(dir, "ghostly-store.json"))).toBe(false);
    expect(existsSync(join(dir, "ghostly-store.sig"))).toBe(false);
  }, 60_000);

  it("names a ring of links as a loop", async () => {
    const dir = join(tmp(), "demo");
    ok(await ghostly(["app", "init", dir]));
    const link = join(tmp(), "publisher.key");
    symlinkSync(link, link);
    const refusal = error(await ghostly(["app", "publish", dir, "--key", link]), "engine", 1);
    expect(refusal.message).toBe(`${link} is a symbolic link whose links go round in a loop (to ${link}): no key was made. Fix the link, or name another --key`);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  }, 60_000);

  it("still makes a key at a path that is not there, and reads a link to a key", async () => {
    const dir = join(tmp(), "demo");
    ok(await ghostly(["app", "init", dir]));
    const key = join(tmp(), "publisher.key");
    expect(ok(await ghostly(["app", "publish", dir, "--key", key]))).toMatchObject({ keyCreated: true });
    const link = join(tmp(), "linked.key");
    symlinkSync(key, link);
    expect(ok(await ghostly(["app", "publish", dir, "--key", link]))).toMatchObject({ keyCreated: false, sequence: 2 });
  }, 60_000);
});
