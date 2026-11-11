import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { CliError } from "../src/errors";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.files

/**
 * A file send whose wait runs out (the contact away, or a big file still moving): the file stays in the chat and goes
 * on, as a text's does. Its timeout answered "Timed out after 5 s waiting for file <id> to arrive", with no messageId
 * and, with the contact away, no details at all: a bot could not delete, pin or react to it, and a person sent it again.
 */
const link = { id: "chat-away", label: "Bob", peerPubKeyZ32: "pbob", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "open",
  capabilities: { files: true }, pairing: { status: "ready" } } as unknown as LinkView;

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-wait-"));
  await openPersistentIndexedDb(join(dir, "db"));
  registerFileBytes("native", async () => new NodeFileBytes(join(dir, "files")), true);
});

function contextFor(mode: "daemon" | "one-shot", transfers: Record<string, unknown> = {}) {
  const sent: number[] = [];
  const node = {
    getState: () => ({ links: [link], groups: [], settings: {}, transport: {}, transfers }) as unknown as EngineState,
    getMessages: vi.fn(async () => []),
    getMessage: vi.fn(async () => undefined),
    sendFile: vi.fn(async ({ timestamp }: { timestamp: number }) => { sent.push(timestamp); }),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode, version: "test" } as unknown as ApiContext;
  return { ctx, sent };
}

async function timedOut(ctx: ApiContext, name: string): Promise<CliError> {
  const path = join(dir, name);
  writeFileSync(path, "notes");
  const error = await callApi(ctx, "file.send", { chat: "Bob", path, wait: "sent", timeout: 1 }).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("timeout");
  return error as CliError;
}

describe("file send whose wait runs out", () => {
  it("names the message and the file, and says the file stays and goes (one-shot)", async () => {
    const { ctx, sent } = contextFor("one-shot");
    const error = await timedOut(ctx, "away.txt");
    expect(error.details).toMatchObject({ chat: "chat-away", messageId: `me_${sent[0]}`, file: expect.stringMatching(/^chat-away-out-/) });
    expect(error.message).toMatch(/^Timed out after 1 s/);
    expect(error.message).toContain("kept here and goes with this profile's next command");
  });

  it("says it goes on by itself on a daemon", async () => {
    const { ctx, sent } = contextFor("daemon");
    const error = await timedOut(ctx, "daemon.txt");
    expect(error.details).toMatchObject({ chat: "chat-away", messageId: `me_${sent[0]}` });
    expect(error.message).toContain("kept here and still goes by itself while this profile is online");
  });

  it("keeps where the transfer stands", async () => {
    const transfers: Record<string, unknown> = {};
    const { ctx, sent } = contextFor("daemon", new Proxy(transfers, { get: (_, id) => typeof id === "string" && id.startsWith("chat-away-out-") ? { transferred: 1_000, size: 5_000, direction: "out", state: "transferring", stage: "asking" } : undefined }));
    const error = await timedOut(ctx, "moving.txt");
    expect(error.details).toMatchObject({ chat: "chat-away", messageId: `me_${sent[0]}`, transferred: 1_000, size: 5_000, stage: "asking" });
    expect(error.message).toContain("1000 of 5000 bytes, waiting for the contact to take it");
  });
});
