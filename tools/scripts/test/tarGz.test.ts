import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { packTarGz } from "../tar-gz.mjs";

/**
 * tools/scripts/prepare-translation-runtime.mjs packs the runtime with packTarGz, and the Desktop app pins that
 * archive's SHA-256. Packed with `tar -czf`, the same tree gave other bytes on each build: the headers took the copy
 * time as mtime and the build user as owner, so nobody could rebuild a published archive from its tag.
 */
const NAME = "ghostly-translation-runtime-0.1.0-linux-x64";
const LONG = `node_modules/@qvac/${"fabric-".repeat(12)}/prebuilds/${"qvac__fabric-".repeat(6)}/libqvac-ggml-cpu-zen4.so`;
const FILES: Record<string, string> = { "runtime.mjs": "console.log(1)\n", "a/z.js": "z", "a/B.js": "B", [LONG]: "long", "licenses/é.txt": "é", "bare": "#!/bin/sh\n" };
const MTIME = 1_762_300_000;
const WINDOWS = process.platform === "win32";
const tar = WINDOWS ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

/** The runtime's folder as one build copies it: its own order, its own times, its own umask. */
function copied(order: string[], time: number, mode: number) {
  const dir = join(mkdtempSync(join(tmpdir(), "tar-gz-")), NAME);
  mkdirSync(join(dir, "empty"), { recursive: true });
  for (const path of order) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), FILES[path]);
    chmodSync(join(dir, path), path === "bare" ? 0o755 : mode);
    utimesSync(join(dir, path), time, time);
  }
  return dir;
}

async function pack(dir: string) {
  const out = join(dirname(dir), `${NAME}.tar.gz`);
  await packTarGz(dir, out, { mtime: MTIME });
  return readFileSync(out);
}

const field = (block: Buffer, at: number, length: number) => block.subarray(at, at + length).toString("utf8").replace(/\0.*$/s, "");

/** The archive's entries in order, with the header fields a build could leak into it. */
function entries(archive: Buffer) {
  const tarBytes = gunzipSync(archive);
  const list: { path: string; type: string; mode: string; uid: string; gid: string; uname: string; gname: string; mtime: number }[] = [];
  let pax: Record<string, string> = {};
  for (let at = 0; at + 512 <= tarBytes.length; ) {
    const block = tarBytes.subarray(at, at + 512);
    if (block.every((byte) => byte === 0)) break;
    const size = parseInt(field(block, 124, 12), 8);
    const type = field(block, 156, 1);
    const body = tarBytes.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = Object.fromEntries([...body.toString("utf8").matchAll(/\d+ ([^=]+)=(.*)\n/g)].map(([, key, value]) => [key, value]));
      continue;
    }
    const prefix = field(block, 345, 155);
    const path = pax.path ?? (prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100));
    list.push({ path, type, mode: field(block, 100, 8), uid: field(block, 108, 8), gid: field(block, 116, 8), uname: field(block, 265, 32), gname: field(block, 297, 32), mtime: parseInt(field(block, 136, 12), 8) });
    pax = {};
  }
  return list;
}

it("gives the same bytes for the same files, whatever the copy's order, times and umask", async () => {
  const first = await pack(copied(Object.keys(FILES), 1_700_000_000, 0o644));
  const second = await pack(copied(Object.keys(FILES).reverse(), 1_800_000_000, 0o664));
  expect(second.equals(first)).toBe(true);
});

it("names no owner, keeps the time given, and lists every folder before its files in name order", async () => {
  const archive = await pack(copied(Object.keys(FILES), 1_700_000_000, 0o644));
  // gzip's own header carries no time either.
  expect(archive.readUInt32LE(4)).toBe(0);
  const list = entries(archive);
  for (const entry of list) expect({ ...entry, path: "" }).toMatchObject({ uid: "0000000", gid: "0000000", uname: "", gname: "", mtime: MTIME });
  expect(list.map((entry) => entry.path)).toEqual([
    `${NAME}/`,
    `${NAME}/a/`,
    `${NAME}/a/B.js`,
    `${NAME}/a/z.js`,
    `${NAME}/bare`,
    `${NAME}/empty/`,
    `${NAME}/licenses/`,
    `${NAME}/licenses/é.txt`,
    ...LONG.split("/").map((_, i, parts) => `${NAME}/${parts.slice(0, i + 1).join("/")}${i < parts.length - 1 ? "/" : ""}`),
    `${NAME}/runtime.mjs`,
  ]);
  expect(list.find((entry) => entry.path === `${NAME}/bare`)?.mode).toBe("0000755");
  expect(list.find((entry) => entry.path === `${NAME}/runtime.mjs`)?.mode).toBe("0000644");
});

it("unpacks with the platform's tar into the same files", async () => {
  const dir = copied(Object.keys(FILES), 1_700_000_000, 0o644);
  await pack(dir);
  const into = mkdtempSync(join(tmpdir(), "tar-gz-out-"));
  execFileSync(tar, ["-xzf", join(dirname(dir), `${NAME}.tar.gz`), "-C", into]);
  for (const [path, text] of Object.entries(FILES)) {
    const file = join(into, NAME, path);
    expect(readFileSync(file, "utf8"), path).toBe(text);
    expect(Math.floor(statSync(file).mtimeMs / 1000), path).toBe(MTIME);
  }
  if (!WINDOWS) expect(statSync(join(into, NAME, "bare")).mode & 0o777).toBe(0o755);
  expect(statSync(join(into, NAME, "empty")).isDirectory()).toBe(true);
});
