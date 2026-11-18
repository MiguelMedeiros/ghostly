import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { AudioSocket, audioSocketPath } from "../src/calls/audioSocket";
import { serve, type Host } from "../src/host";
import { profilePaths, type ProfilePaths } from "../src/profiles";
// covers: headless.daemon, headless.calls

/**
 * The folder a long-path profile's socket goes in (`runtimePath`) is removed when its socket closes, when nothing else
 * is in it: left behind, one empty folder per profile piled up in the temp folder.
 */
const root = mkdtempSync(join(tmpdir(), "gh-rtf-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A runtime folder of this user's alone, as `$XDG_RUNTIME_DIR` and macOS's `$TMPDIR` are. */
const runtime = () => {
  const dir = mkdtempSync(join(root, "run-"));
  chmodSync(dir, 0o700);
  return dir;
};

let n = 0;
/** A profile whose own `daemon.sock` would be too long for a Unix socket. */
const longProfile = (): ProfilePaths => {
  const paths = profilePaths(join(root, `home-${n++}`, "h".repeat(60)), "p".repeat(40));
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  return paths;
};

const hostOf = (paths: Pick<ProfilePaths, "dir" | "socket">) => ({ ctx: { runtime: { paths } } }) as unknown as Host;

const ghostlyFolders = (dir: string) => readdirSync(dir).filter((name) => name.startsWith("ghostly-"));

/** The first line a daemon's socket answers with: its greeting, written before it reads anything. */
function greeting(socket: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = connect(socket);
    let got = "";
    client.on("data", (chunk) => {
      got += chunk.toString();
      if (got.includes("\n")) { client.destroy(); resolve(got.split("\n")[0]); }
    });
    client.on("error", reject);
  });
}

describe.skipIf(process.platform === "win32")("the daemon's runtime folder", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("a long-path profile's daemon leaves no folder behind in $XDG_RUNTIME_DIR once it stops", async () => {
    const run = runtime();
    vi.stubEnv("XDG_RUNTIME_DIR", run);
    const paths = longProfile();
    expect(dirname(dirname(paths.socket))).toBe(run);
    const served = await serve(hostOf(paths));
    expect(existsSync(paths.socket)).toBe(true);
    await served.close();
    expect(ghostlyFolders(run)).toEqual([]);
    // The profile's own folder is not the socket's: it stays.
    expect(existsSync(paths.dir)).toBe(true);
  });

  it("nor in the user's own temp folder (macOS's $TMPDIR), where it goes without $XDG_RUNTIME_DIR", async () => {
    const temp = runtime();
    vi.stubEnv("XDG_RUNTIME_DIR", "");
    vi.stubEnv("TMPDIR", temp);
    const paths = longProfile();
    expect(dirname(dirname(paths.socket))).toBe(temp);
    const served = await serve(hostOf(paths));
    await served.close();
    expect(ghostlyFolders(temp)).toEqual([]);
  });

  it("a folder with anything else in it is kept, and what is in it", async () => {
    const run = runtime();
    vi.stubEnv("XDG_RUNTIME_DIR", run);
    const paths = longProfile();
    const served = await serve(hostOf(paths));
    const other = join(dirname(paths.socket), "notes.txt");
    writeFileSync(other, "kept");
    await served.close();
    expect(readFileSync(other, "utf8")).toBe("kept");
    expect(existsSync(paths.socket)).toBe(false);
  });

  it("two daemons with sockets in the same folder: the one that stops leaves the other's socket working", async () => {
    const run = runtime();
    vi.stubEnv("XDG_RUNTIME_DIR", run);
    const first = longProfile();
    const second = { dir: longProfile().dir, socket: join(dirname(first.socket), "other.sock") };
    const one = await serve(hostOf(first));
    const two = await serve(hostOf(second));
    await one.close();
    expect(existsSync(second.socket)).toBe(true);
    expect(JSON.parse(await greeting(second.socket))).toHaveProperty("greeting");
    await two.close();
    expect(ghostlyFolders(run)).toEqual([]);
  });

  it("a socket in the profile's own folder leaves that folder where it is", async () => {
    const dir = join(root, "short");
    mkdirSync(dir, { mode: 0o700 });
    const served = await serve(hostOf({ dir, socket: join(dir, "daemon.sock") }));
    await served.close();
    expect(existsSync(dir)).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("a call's runtime folder", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("goes with the last call's socket, not before", async () => {
    const run = runtime();
    vi.stubEnv("XDG_RUNTIME_DIR", run);
    const { dir } = longProfile();
    const a = audioSocketPath(dir, "a".repeat(12)), b = audioSocketPath(dir, "b".repeat(12));
    expect(dirname(a)).toBe(dirname(b));
    expect(dirname(dirname(a))).toBe(run);
    const first = await AudioSocket.open(a, 16000, { onAudio: () => {} });
    const second = await AudioSocket.open(b, 16000, { onAudio: () => {} });
    await first.close();
    expect(existsSync(b)).toBe(true);
    await new Promise<void>((resolve, reject) => {
      const client = connect(b, () => { client.destroy(); resolve(); });
      client.on("error", reject);
    });
    await second.close();
    expect(ghostlyFolders(run)).toEqual([]);
  });

  it("a shared folder (GHOSTLY_CALL_SOCKET_DIR) is the machine's: it stays when its last call ends", async () => {
    const shared = join(root, "shared");
    mkdirSync(shared, { mode: 0o750 });
    chmodSync(shared, 0o750);
    const path = audioSocketPath("/p", "c".repeat(12), shared);
    const socket = await AudioSocket.open(path, 16000, { onAudio: () => {} }, { shared: true });
    await socket.close();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(shared)).toBe(true);
  });
});
