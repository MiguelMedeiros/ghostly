import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { EngineState, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { CliError } from "../src/errors";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { chatViewOf } from "./support/chatView";
// covers: headless.files

/**
 * `forward <chat> <file message> --to <chat> --wait sent` to a contact who is away: the copy's file waits for them, as a
 * `file send` does. Its timeout said only "Timed out after 1 s waiting for file … to arrive", not that the copy is kept
 * and still goes, nor the copy's chat and message: a bot read a failure and forwarded the file again, which went twice.
 */
const chat = (id: string, deliveryMode = "auto") => ({ id, label: id, peerPubKeyZ32: `p${id}`, createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "closed",
  capabilities: { files: true }, pairing: { status: "ready" }, deliveryMode }) as unknown as LinkView;

beforeAll(async () => {
  await openPersistentIndexedDb(join(mkdtempSync(join(tmpdir(), "ghostly-forward-file-")), "db"));
});

function contextFor(to: LinkView) {
  const file = { id: "source-in-notes", name: "notes.txt", size: 5, mime: "text/plain" };
  const rows = new Map<string, StoredMessage>([["peer_1", { linkId: "source", id: "peer_1", text: "📎 notes.txt", sender: "peer", timestamp: 1, file } as StoredMessage]]);
  const transfers: Record<string, unknown> = {};
  const node = {
    chatView: chatViewOf,
    getState: () => ({ links: [chat("source"), to], groups: [], settings: {}, transport: {}, transfers }) as unknown as EngineState,
    getMessage: vi.fn(async (_: string, id: string) => rows.get(id)),
    forwardMessages: vi.fn(async ({ to: targets }: { to: string[] }) => {
      // The copy is a new file of mine in the chat, waiting for the contact.
      const copy = { id: `${to.id}-out-copy`, name: "notes.txt", size: 5, mime: "text/plain" };
      transfers[copy.id] = { state: "transferring", transferred: 0, size: 5, direction: "out", stage: "waiting" };
      rows.set("me_2", { linkId: to.id, id: "me_2", text: "📎 notes.txt", sender: "me", timestamp: 2, delivery: "waiting", file: copy } as StoredMessage);
      return { results: targets.map(() => ({ messageIds: ["me_2"], sent: [], error: null })) };
    }),
  };
  return { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
}

const forward = (ctx: ApiContext) => callApi(ctx, "chat.forward", { chat: "source", messages: ["peer_1"], to: ["bob"], wait: "sent", timeout: 1 }).then(() => null, (e: unknown) => e) as Promise<CliError>;

describe("forward --wait sent of a file to a contact away", () => {
  it("times out saying the copy is kept and still goes, with its chat and message, as file send does", async () => {
    const error = await forward(contextFor(chat("bob")));
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe("timeout");
    expect(error.message).toMatch(/^Timed out after 1 s waiting for file bob-out-copy to arrive \(0 of 5 bytes, .*\)\. It is kept here and still goes by itself while this profile is online$/);
    expect(error.details).toMatchObject({ chat: "bob", messageId: "me_2", file: "bob-out-copy", results: [{ to: "bob", messageIds: ["me_2"] }] });
  }, 10_000);

  it("in a chat on the DHT only, says what ends the wait, not that it goes by itself", async () => {
    const error = await forward(contextFor(chat("bob", "dht")));
    expect(error.code).toBe("timeout");
    expect(error.message).not.toMatch(/goes by itself/);
    expect(error.message).toContain("A file goes only on a live session, and this chat is on the DHT only");
    expect(error.details).toMatchObject({ chat: "bob", messageId: "me_2" });
  }, 10_000);
});
