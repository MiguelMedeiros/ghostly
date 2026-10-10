import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { debMember, NoUnpacker, unpackDeb } from "../unpack-deb.mjs";

const work = mkdtempSync(join(tmpdir(), "unpack-deb-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Where a tool is on this machine, or nothing. */
const which = (tool: string) => (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, tool)).find((file) => existsSync(file));

/** A PATH with these tools only: a directory of links to them. */
const pathWith = (name: string, tools: string[]) => {
  const bin = join(work, name);
  mkdirSync(bin);
  for (const tool of tools) symlinkSync(which(tool)!, join(bin, tool));
  return { PATH: bin };
};

/** An `ar` archive, as `ar` writes it: a 60-byte header per member, the data padded to an even length. */
const ar = (members: [string, Buffer][]) => Buffer.concat([Buffer.from("!<arch>\n"), ...members.flatMap(([name, data]) => [
  Buffer.from(`${name.padEnd(16)}${"0".padEnd(12)}${"0".padEnd(6)}${"0".padEnd(6)}${"100644".padEnd(8)}${String(data.length).padEnd(10)}\`\n`),
  data,
  Buffer.alloc(data.length % 2),
])]);

/** A package as a release ships it, with the app at usr/bin/ghostly. An odd-sized first member puts padding before the data. */
const deb = (() => {
  const tree = join(work, "tree");
  mkdirSync(join(tree, "usr", "bin"), { recursive: true });
  writeFileSync(join(tree, "usr", "bin", "ghostly"), "#!/bin/sh\necho old\n", { mode: 0o755 });
  const data = execFileSync("tar", ["-czf", "-", "-C", tree, "./usr"]);
  const file = join(work, "Ghostly_0.0.0_amd64.deb");
  writeFileSync(file, ar([["debian-binary", Buffer.from("2.0\n")], ["control.tar.gz", Buffer.from("odd")], ["data.tar.gz", data]]));
  return { file, data };
})();

const unpacked = (root: string) => {
  const binary = join(root, "usr", "bin", "ghostly");
  expect(readFileSync(binary, "utf8")).toBe("#!/bin/sh\necho old\n");
  expect(statSync(binary).mode & 0o111).toBe(0o111);
};

describe("unpack-deb", () => {
  it("finds the package's files in the ar archive, after a padded member", () => {
    const member = debMember(readFileSync(deb.file), "data.tar");
    expect(member?.name).toBe("data.tar.gz");
    expect(member?.data.equals(deb.data)).toBe(true);
    expect(debMember(readFileSync(deb.file), "nothing")).toBeUndefined();
    expect(() => debMember(Buffer.from("not a package"), "data.tar")).toThrow(/not an ar archive/);
  });

  it("unpacks a package where dpkg-deb is missing, with tar alone", () => {
    const env = pathWith("tar-only", ["tar", "gzip"]);
    expect(spawnSync("dpkg-deb", ["--version"], { env }).error).toMatchObject({ code: "ENOENT" });
    const root = join(work, "without-dpkg");
    mkdirSync(root);
    expect(unpackDeb(deb.file, root, { env })).toBe("tar");
    unpacked(root);
    // Nothing of the unpacking is left beside the package.
    expect(existsSync(`${deb.file}.data.tar.gz`)).toBe(false);
  });

  it.skipIf(!which("dpkg-deb"))("unpacks with dpkg-deb where it is installed", () => {
    const root = join(work, "with-dpkg");
    mkdirSync(root);
    expect(unpackDeb(deb.file, root)).toBe("dpkg-deb");
    unpacked(root);
  });

  it("says that nothing here unpacks it, and why, when no tool is installed", () => {
    const root = join(work, "no-tool");
    mkdirSync(root);
    const failure = (() => { try { unpackDeb(deb.file, root, { env: pathWith("empty", []) }); } catch (error) { return error; } })();
    expect(failure).toBeInstanceOf(NoUnpacker);
    expect((failure as Error).message).toMatch(/dpkg-deb: not installed.*tar: not installed.*bsdtar: not installed/);
    expect(existsSync(`${deb.file}.data.tar.gz`)).toBe(false);
  });

  it("the fetch script ends with status 3, not a crash, when nothing unpacks the package", () => {
    const cache = join(work, "cache");
    const result = spawnSync(process.execPath, [join(import.meta.dirname, "..", "fetch-compat-desktop.mjs"), "--deb", deb.file, "--tag", "v0.0.0"], {
      env: { ...pathWith("empty-script", []), E2E_COMPAT_CACHE: cache }, encoding: "utf8",
    });
    expect(result.stderr).toMatch(/dpkg-deb: not installed/);
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
  });

  it("the fetch script prints the unpacked app where dpkg-deb is missing", () => {
    const cache = join(work, "cache-tar");
    const result = spawnSync(process.execPath, [join(import.meta.dirname, "..", "fetch-compat-desktop.mjs"), "--deb", deb.file, "--tag", "v0.0.0"], {
      env: { ...pathWith("tar-script", ["tar", "gzip"]), E2E_COMPAT_CACHE: cache }, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(join(cache, "desktop-v0.0.0", "usr", "bin", "ghostly"));
    unpacked(join(cache, "desktop-v0.0.0"));
  });
});
