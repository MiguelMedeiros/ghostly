import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import type { EngineState, GroupView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { asCliError, type CliError } from "../src/errors";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { waitsFor } from "../src/waitNotice";
import { chatViewOf, groupViewOf } from "./support/chatView";
// covers: groups.files, headless.one-shot

/**
 * A one-shot `file send <group>` waits until a member's edge took the file's message (`--wait sent`). Its timeout named
 * only the message, so a bot that retried on exit 4 staged and announced a second copy; it names the file, as a 1:1
 * chat's does. Taken by an edge, the file is still fetched from this device, which the one-shot leaves at once: its
 * `note` says the members get it while the profile is online. It waits 30 s by default, as `group send` does.
 */
const group = { id: "g1", name: "Team", status: "active", profile: "mesh", members: [{ key: "pme", me: true }, { key: "pbob", me: false }] } as unknown as GroupView;

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-group-file-wait-"));
  await openPersistentIndexedDb(join(dir, "db"));
  registerFileBytes("native", async () => new NodeFileBytes(join(dir, "files")), true);
});

function contextFor(taken: number, only: GroupView = group) {
  const node = {
    chatView: chatViewOf, groupView: groupViewOf,
    getState: () => ({ links: [], groups: [only], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState,
    getMessages: vi.fn(async () => []),
    getMessage: vi.fn(async () => undefined),
    groupFileCheck: vi.fn(async () => ({ error: null })),
    groupTaken: vi.fn(() => taken),
    sendGroupFile: vi.fn(async () => ({ error: null, messageId: "m1" })),
    setGroupTyping: vi.fn(async () => {}),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "one-shot", version: "test" } as unknown as ApiContext;
  return { node, ctx };
}

function file(name: string) {
  const path = join(dir, name);
  writeFileSync(path, new Uint8Array(4000).fill(1));
  return path;
}

describe("a one-shot file send to a group", () => {
  it("times out naming the file and the group, not only its message", async () => {
    const { ctx } = contextFor(0);
    const error = await callApi(ctx, "file.send", { chat: "group:g1", path: file("away.bin"), timeout: 1 }).then(() => undefined, asCliError);
    expect(error?.code).toBe("timeout");
    expect(error?.details).toMatchObject({ group: "g1", messageId: "m1", file: expect.stringMatching(/^group-g1-out-/) });
  });

  it("taken by an edge: sent, and a note that the members fetch it from this device while it is online", async () => {
    const { ctx } = contextFor(1);
    const answer = await callApi(ctx, "file.send", { chat: "group:g1", path: file("taken.bin") }) as Record<string, unknown>;
    expect(answer).toMatchObject({ sent: true, edges: 1 });
    expect(answer.note).toBe("Members fetch the file from this device: they get it while this profile is online (`ghostly daemon --detach`)");
  });

  it("waits 30 s by default, as group send does", () => {
    expect(waitsFor("file.send", { chat: "group:g1", path: "/f", wait: "sent" })).toBe(30);
    expect(waitsFor("file.send", { chat: "bob", path: "/f", wait: "sent" })).toBe(300);
  });

  it("with no --timeout, a one-shot's wait for an edge ends at 30 s", async () => {
    const { node, ctx } = contextFor(0);
    const path = file("default.bin");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      let error: CliError | undefined;
      void callApi(ctx, "file.send", { chat: "group:g1", path }).then(() => undefined, asCliError).then((e) => { error = e; });
      await vi.waitFor(() => expect(node.groupTaken).toHaveBeenCalled(), { timeout: 10_000 });
      await vi.advanceTimersByTimeAsync(29_000);
      expect(error).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(error?.code).toBe("timeout");
      expect(error?.message).toMatch(/^Timed out after 30 s/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("--wait none, no edge yet: sent false, and a note that it goes later", async () => {
    const { ctx } = contextFor(0);
    const answer = await callApi(ctx, "file.send", { chat: "group:g1", path: file("none.bin"), wait: "none" }) as Record<string, unknown>;
    expect(answer).toMatchObject({ sent: false, edges: 0 });
    expect(answer.note).toBe("No member's edge took it yet: it goes with this profile's next command, or keep it online with `ghostly daemon --detach`");
  });

  it("a group with nobody else in it: sent false and no note", async () => {
    const { ctx } = contextFor(0, { ...group, id: "g2", members: [{ key: "pme", me: true }] } as unknown as GroupView);
    const answer = await callApi(ctx, "file.send", { chat: "group:g2", path: file("alone.bin"), wait: "none" }) as Record<string, unknown>;
    expect(answer).toMatchObject({ sent: false, edges: 0 });
    expect(answer).not.toHaveProperty("note");
  });
});
