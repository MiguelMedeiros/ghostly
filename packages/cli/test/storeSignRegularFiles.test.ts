import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { signStore } from "../src/apps";
import { CliError } from "../src/errors";
// covers: apps.store

/*
 * `store sign` reads its index and the signed pair already in its output folder as `app publish` reads its folder's
 * files: a regular file only. A FIFO (or a link to one, or to a device) says size 0 and never ends: read, it held the
 * command until killed.
 */

const VECTORS = resolve(import.meta.dirname, "../../core/test/vectors");
const storeVectors = JSON.parse(readFileSync(join(VECTORS, "app-store.json"), "utf8")) as { valid: { index: string }[] };
const tmp = () => mkdtempSync(join(tmpdir(), "ghostly-store-sign-"));

// Each FIFO gets a writer that opens it and closes at once: a read that opens it gets an end instead of waiting for
// good (so a regression fails here rather than holding the run), and one that never opens it leaves the writer
// waiting, killed after the test.
const writers: ReturnType<typeof spawn>[] = [];
afterEach(() => { for (const writer of writers.splice(0)) writer.kill("SIGKILL"); });
function fifo(path: string): string {
  execFileSync("mkfifo", [path]);
  writers.push(spawn("sh", ["-c", 'exec 3>"$1"', "sh", path], { stdio: "ignore" }));
  return path;
}

/** A hand-written index the vector's store signs: its own key left out, so it is the signing key's. */
function indexFile(dir: string): string {
  const { key: _key, ...index } = JSON.parse(storeVectors.valid[0].index) as Record<string, unknown>;
  const path = join(dir, "index.json");
  writeFileSync(path, JSON.stringify(index));
  return path;
}

async function notFile(run: Promise<unknown>, path: string) {
  const refusal = await run.then(() => null, (e: unknown) => e);
  expect(refusal).toBeInstanceOf(CliError);
  expect((refusal as CliError).code).toBe("bad_request");
  expect((refusal as CliError).message).toBe(`${path} is not a file`);
}

describe.skipIf(process.platform === "win32")("store sign and a file that is not a regular one", () => {
  it("refuses an index that is a FIFO, or a link to one, unread", async () => {
    const dir = tmp(), keys = tmp();
    const index = fifo(join(dir, "index.json"));
    await notFile(signStore(index, join(keys, "store.key")), index);
    const link = join(dir, "link.json");
    symlinkSync(fifo(join(dir, "other.fifo")), link);
    await notFile(signStore(link, join(keys, "store.key")), link);
    expect(existsSync(join(keys, "store.key"))).toBe(false);
  });

  it("refuses a signed index or signature in the output folder that is a FIFO, and writes nothing", async () => {
    for (const name of ["ghostly-store.json", "ghostly-store.sig"]) {
      const dir = tmp(), keys = tmp();
      const index = indexFile(dir);
      const held = fifo(join(dir, name));
      await notFile(signStore(index, join(keys, "store.key")), held);
      expect(existsSync(join(keys, "store.key"))).toBe(false);
      const other = name.endsWith(".json") ? "ghostly-store.sig" : "ghostly-store.json";
      expect(existsSync(join(dir, other))).toBe(false);
    }
  });

  it("still signs a plain index", async () => {
    const dir = tmp();
    const signed = await signStore(indexFile(dir), join(tmp(), "store.key"));
    expect(signed).toMatchObject({ keyCreated: true });
    expect(existsSync(join(dir, "ghostly-store.json"))).toBe(true);
  });
});
