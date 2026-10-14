/**
 * Unpacks a Debian package's files (what `dpkg-deb -x` does) on a machine that may have no `dpkg-deb`: Arch has none.
 * A `.deb` is an `ar` archive of `debian-binary`, `control.tar.*` and `data.tar.*`; the last one is the installed tree.
 * Without `dpkg-deb` the archive is read here and `data.tar.*` goes to `tar` (or `bsdtar`), which every Linux has.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

/** No tool on this machine unpacks the package: a reason to skip, not a broken package. */
export class NoUnpacker extends Error {}

/** The first member of an `ar` archive whose name starts with `prefix`, or nothing. */
export function debMember(archive, prefix) {
  if (archive.subarray(0, 8).toString("latin1") !== "!<arch>\n") throw new Error("not an ar archive");
  // Each member: a 60-byte header (name 16, date 12, owner 6, group 6, mode 8, size 10, "`\n"), then the data, padded to an even length.
  for (let at = 8; at + 60 <= archive.length;) {
    const header = archive.subarray(at, at + 60).toString("latin1");
    const size = Number(header.slice(48, 58).trim());
    if (header.slice(58) !== "`\n" || !Number.isInteger(size)) throw new Error(`not an ar archive: a bad member at byte ${at}`);
    const name = header.slice(0, 16).trim().replace(/\/$/, "");
    if (name.startsWith(prefix)) return { name, data: archive.subarray(at + 60, at + 60 + size) };
    at += 60 + size + (size % 2);
  }
  return undefined;
}

/** Runs a tool: "ok", or why it did not do it. */
function run(tool, args, env) {
  const result = spawnSync(tool, args, { env, stdio: ["ignore", "inherit", "pipe"], encoding: "utf8" });
  if (result.error) return result.error.code === "ENOENT" ? "not installed" : result.error.message;
  return result.status === 0 ? "ok" : (result.stderr.trim().split("\n")[0] || `status ${result.status}`);
}

/**
 * Unpacks the package `file` into the directory `root`, with `dpkg-deb` or else with `tar` or `bsdtar` on its
 * `data.tar.*`. Gives the tool that did it; throws NoUnpacker, with each tool's reason, when none could.
 */
export function unpackDeb(file, root, { env = process.env } = {}) {
  const tried = [];
  const attempt = (tool, args) => { const outcome = run(tool, args, env); if (outcome !== "ok") tried.push(`${tool}: ${outcome}`); return outcome === "ok"; };
  if (attempt("dpkg-deb", ["-x", file, root])) return "dpkg-deb";
  const member = debMember(readFileSync(file), "data.tar");
  if (!member) throw new Error(`${file} has no data.tar`);
  // tar finds the compression itself (gzip, xz or zstd).
  const data = `${file}.${member.name}`;
  writeFileSync(data, member.data);
  try {
    for (const tool of ["tar", "bsdtar"]) if (attempt(tool, ["-xf", data, "-C", root, "--no-same-owner"])) return tool;
  } finally {
    rmSync(data, { force: true });
  }
  throw new NoUnpacker(`Nothing here unpacks ${member.name} (${tried.join("; ")})`);
}
