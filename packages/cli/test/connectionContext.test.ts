import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ApiContext } from "../src/apiKit";
import { serve, type Host } from "../src/host";
// covers: headless.daemon

/** The context and the connection's signal each call reaches `callApi` with. */
const seen: { ctx: ApiContext; gone: AbortSignal | undefined }[] = [];
vi.mock("../src/api", async (original) => ({
  ...(await original<typeof import("../src/api")>()),
  callApi: async (ctx: ApiContext, _method: string, _params: unknown, call?: { gone?: AbortSignal }) => { seen.push({ ctx, gone: call?.gone }); return null; },
}));

const root = mkdtempSync(join(tmpdir(), "gh-context-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** One call on a connection of its own, answered. */
async function once(path: string): Promise<void> {
  const client = connect(path);
  const lines = createInterface({ input: client });
  const answered = new Promise<void>((resolve) => lines.on("line", (line) => { if ((JSON.parse(line) as { id?: number }).id === 1) resolve(); }));
  client.write(JSON.stringify({ id: 1, method: "task.update", params: {} }) + "\n");
  await answered;
  client.destroy();
}

describe.skipIf(process.platform === "win32")("the daemon's calls", () => {
  it("all get the daemon's one context, and each its own connection's signal", async () => {
    // What the CLI keeps per daemon is keyed by its context (a card's update pacing, the invite's mark, holds): a
    // context per connection split it, and every one-shot command is a connection of its own.
    const dir = join(root, "one");
    mkdirSync(dir, { mode: 0o700 });
    const hub = { lastSeq: 0, replay: () => [], onEvent: () => () => {}, onState: () => () => {} };
    const host = { ctx: { mode: "daemon", runtime: { paths: { dir, socket: join(dir, "daemon.sock") }, server: { node: {} } }, hub } } as unknown as Host;
    const s = await serve(host);
    try {
      await once(join(dir, "daemon.sock"));
      await once(join(dir, "daemon.sock"));
      expect(seen.map(({ ctx }) => ctx === host.ctx)).toEqual([true, true]);
      expect(seen[0]!.gone).not.toBe(seen[1]!.gone);
      // Each signal aborts once the daemon sees its connection close.
      await vi.waitFor(() => expect(seen.map(({ gone }) => gone?.aborted)).toEqual([true, true]));
    } finally { await s.close(); }
  });
});
