import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ApiContext } from "../src/apiKit";
import { serve, type Host } from "../src/host";
import { waitForGroupFrame } from "../src/waits";
// covers: headless.daemon

const root = mkdtempSync(join(tmpdir(), "gh-waits-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const turn = () => new Promise((resolve) => setImmediate(resolve));

/** A daemon whose one chat never goes live: every `chat.wait` on it waits on the hub's state. */
async function served(name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { mode: 0o700 });
  const listeners = new Set<() => void>();
  const state = { links: [{ id: "c49", name: "Bia" }], groups: [] };
  const hub = {
    lastSeq: 0,
    replay: () => [],
    onEvent: () => () => {},
    onState: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const host = { ctx: { mode: "daemon", runtime: { paths: { dir, socket: join(dir, "daemon.sock") }, server: { node: { getState: () => state, chatView: (id: string) => state.links.find((l) => l.id === id) } } }, hub } } as unknown as Host;
  const s = await serve(host);
  return { ...s, listeners, path: join(dir, "daemon.sock") };
}

/** A client that writes `count` chat.wait calls at once. */
function waiter(path: string, count: number) {
  const client = connect(path);
  const lines = Array.from({ length: count }, (_, i) => JSON.stringify({ id: i + 1, method: "chat.wait", params: { chat: "c49", until: "live", timeout: 86_400 } }) + "\n");
  client.write(lines.join(""));
  return client;
}

describe.skipIf(process.platform === "win32")("a wait on the socket", () => {
  it("ends when its client's connection closes", async () => {
    const s = await served("closed");
    try {
      const client = waiter(s.path, 20);
      while (s.listeners.size < 20) await turn();
      // A bot killed in the middle of `ghostly chat wait --timeout 86400`.
      client.destroy();
      for (let i = 0; i < 50 && s.listeners.size; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(s.listeners.size).toBe(0);
    } finally { await s.close(); }
  });
});

describe("a group wait", () => {
  it("stops reading the group once its client's connection closed", async () => {
    let reads = 0;
    const closed = new AbortController();
    const ctx = {
      mode: "daemon",
      closed: closed.signal,
      runtime: { server: { node: { groupTaken: () => { reads++; return 0; }, groupView: () => ({ id: "g1", profile: "community", members: [], status: "active" }) } } },
    } as unknown as ApiContext;
    const waiting = waitForGroupFrame(ctx, "g1", "m1", undefined, 86_400_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    closed.abort();
    await expect(waiting).rejects.toMatchObject({ code: "interrupted" });
    const after = reads;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(reads).toBe(after);
  });
});
