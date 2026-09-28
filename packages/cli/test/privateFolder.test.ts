import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { connectDaemon } from "../src/client";
import { ownSocket, privateFolder } from "../src/privateFolder";
import { profilePaths } from "../src/profiles";
// covers: headless.daemon

/** Sockets outside the profile's folder (a path too long for one): in a folder of this user's alone, or not at all. */
const root = mkdtempSync(join(tmpdir(), "gh-priv-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")("sockets outside the profile", () => {
  it("a long profile path puts the daemon's socket in a folder of its own, not in /tmp itself", () => {
    const paths = profilePaths(join(root, "home"), "a".repeat(60));
    expect(paths.socket).toMatch(/^\/tmp\/ghostly-[0-9a-f]{24}\/daemon\.sock$/);
    expect(profilePaths(join(root, "home"), "short").socket).toBe(join(root, "home", "profiles", "short", "daemon.sock"));
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
    expect(await connectDaemon(file, 200)).toBeNull();
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
