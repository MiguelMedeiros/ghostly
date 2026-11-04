import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { connectDaemon } from "../src/client";
import { serve, type Host } from "../src/host";
import { ownSocket, privateFolder, runtimePath } from "../src/privateFolder";
import { profilePaths } from "../src/profiles";
// covers: headless.daemon

/** Sockets outside the profile's folder (a path too long for one): in a folder of this user's alone, or not at all. */
const root = mkdtempSync(join(tmpdir(), "gh-priv-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")("sockets outside the profile", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  /** A runtime folder of this user's alone, as `$XDG_RUNTIME_DIR` is. */
  const runtime = () => {
    const dir = mkdtempSync(join(root, "run-"));
    chmodSync(dir, 0o700);
    return dir;
  };

  it("a long profile path puts the daemon's socket in a folder of its own, not in /tmp itself", () => {
    vi.stubEnv("XDG_RUNTIME_DIR", "");
    vi.stubEnv("TMPDIR", "/tmp");
    const paths = profilePaths(join(root, "home"), "a".repeat(60));
    expect(paths.socket).toMatch(new RegExp(`^/tmp/ghostly-${process.getuid!()}-[0-9a-f]{24}/daemon\\.sock$`));
    expect(profilePaths(join(root, "home"), "short").socket).toBe(join(root, "home", "profiles", "short", "daemon.sock"));
  });

  it("the folder is in the user's own runtime folder when there is one, which nobody else can make first", async () => {
    const run = runtime();
    vi.stubEnv("XDG_RUNTIME_DIR", run);
    const paths = profilePaths(join(root, "home"), "b".repeat(60));
    expect(paths.socket).toBe(join(run, `ghostly-${createHash("sha256").update(paths.dir).digest("hex").slice(0, 24)}`, "daemon.sock"));
    // The folder a long profile's socket went to before: predictable, so anyone could make it first.
    const old = join("/tmp", `ghostly-${createHash("sha256").update(paths.dir).digest("hex").slice(0, 24)}`);
    mkdirSync(old, { recursive: true, mode: 0o755 });
    chmodSync(old, 0o755);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    try {
      const served = await serve({ ctx: { runtime: { paths } } } as unknown as Host);
      try {
        expect(statSync(dirname(paths.socket)).mode & 0o777).toBe(0o700);
        expect(statSync(paths.socket).mode & 0o777).toBe(0o600);
      } finally { await served.close(); }
    } finally { rmSync(old, { recursive: true, force: true }); }
  });

  it("a runtime folder others may enter, or a relative one, is not used", () => {
    const open = runtime();
    chmodSync(open, 0o755);
    vi.stubEnv("TMPDIR", "/tmp");
    for (const run of [open, "run", join(root, "missing")]) {
      vi.stubEnv("XDG_RUNTIME_DIR", run);
      expect(runtimePath("ghostly", "/p", "daemon.sock")).toMatch(new RegExp(`^/tmp/ghostly-${process.getuid!()}-[0-9a-f]{24}/daemon\\.sock$`));
    }
    vi.stubEnv("XDG_RUNTIME_DIR", join(runtime(), "x".repeat(60)));
    expect(runtimePath("ghostly", "/p", "daemon.sock")).toMatch(/^\/tmp\//);
  });

  it("a folder anyone else may enter, or a link, is refused", () => {
    const open = join(root, "open");
    mkdirSync(open);
    chmodSync(open, 0o755);
    expect(() => privateFolder(open, "test")).toThrow(/alone/);
    const target = join(root, "target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(root, "link"));
    expect(() => privateFolder(join(root, "link"), "test")).toThrow(/alone/);
    const mine = join(root, "mine");
    privateFolder(mine, "test");
    expect(() => privateFolder(mine, "test")).not.toThrow();
  });

  it("a client connects only to a socket of this user's", async () => {
    const file = join(root, "not-a-socket");
    writeFileSync(file, "");
    expect(ownSocket(file)).toBe(false);
    expect(await connectDaemon({ socket: file, dir: root }, 200)).toBeNull();
    expect(ownSocket(join(root, "nothing"))).toBe(true);
    const socket = join(root, "s.sock");
    const server = createServer((s) => s.end());
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    expect(ownSocket(socket)).toBe(true);
    const link = join(dirname(socket), "s-link.sock");
    symlinkSync(socket, link);
    expect(ownSocket(link)).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

/** The profile's own folder, where its socket usually is: owner-only before the daemon listens in it. */
describe.skipIf(process.platform === "win32")("the daemon's socket in the profile's folder", () => {
  const hostAt = (dir: string) => ({ ctx: { runtime: { paths: { dir, socket: join(dir, "daemon.sock") } } } }) as unknown as Host;

  it("a profile folder anyone else may enter is closed before the socket is made; the socket is 0600", async () => {
    const dir = join(root, "profile-open");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const served = await serve(hostAt(dir));
    try {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "daemon.sock")).mode & 0o777).toBe(0o600);
    } finally { await served.close(); }
  });

  it("a profile folder that is a link is refused", async () => {
    const target = join(root, "profile-target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(root, "profile-link"));
    await expect(serve(hostAt(join(root, "profile-link")))).rejects.toThrow(/not a folder of this user's/);
  });
});
