import { describe, expect, it, vi } from "vitest";
import type { EngineState, LinkView, Settings } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { chatJson } from "../src/views";
import { chatViewOf } from "./support/chatView";
// covers: headless.cli

const BOB = "b".repeat(52), CAROL = "c".repeat(52);
/** An engine that keeps the block list as the real one does (`setContactBlocked`), and marks each chat of a blocked key. */
function fake() {
  const settings = {} as Settings;
  const rows = [
    { id: "chat-bob", label: "bob", peerNick: "Bob", peerPubKeyZ32: BOB, profile: "paired-chat/1" },
    { id: "chat-bob-2", label: "", peerNick: "Bobby", peerPubKeyZ32: BOB, profile: "paired-chat/1" },
    { id: "chat-carol", label: "carol", peerNick: "Carol", peerPubKeyZ32: CAROL, profile: "paired-chat/1" },
    { id: "chat-pending", label: "pending", peerPubKeyZ32: "", profile: "paired-chat/1", inviteCode: "x" },
  ];
  const links = () => rows.map((l) => ({ ...l, ...(settings.blockedContacts?.includes(l.peerPubKeyZ32) && { blocked: true }) })) as unknown as LinkView[];
  const node = {
    chatView: chatViewOf,
    getSettings: () => settings,
    getState: () => ({ links: links(), groups: [], settings, transport: {}, services: [] }) as unknown as EngineState,
    setContactBlocked: vi.fn(async ({ peerPubKeyZ32, blocked }: { peerPubKeyZ32: string; blocked: boolean }) => {
      const list = (settings.blockedContacts ?? []).filter((k) => k !== peerPubKeyZ32);
      settings.blockedContacts = blocked ? [...list, peerPubKeyZ32] : list;
    }),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node, links };
}

describe("contact block, unblock and blocked", () => {
  it("blocks a chat's contact by its key, which marks every chat with it", async () => {
    const { ctx, node, links } = fake();
    expect(await callApi(ctx, "contact.block", { chat: "bob" })).toEqual({
      peer: BOB, blocked: true, chats: [{ id: "chat-bob", name: "bob" }, { id: "chat-bob-2", name: "Bobby" }],
    });
    expect(node.setContactBlocked).toHaveBeenLastCalledWith({ peerPubKeyZ32: BOB, blocked: true });
    expect(links().map((l) => chatJson(l).blocked)).toEqual([true, true, false, false]);
    expect(await callApi(ctx, "contact.blocked", {})).toEqual({ contacts: [{ peer: BOB, blocked: true, chats: [{ id: "chat-bob", name: "bob" }, { id: "chat-bob-2", name: "Bobby" }] }] });
  });

  it("unblocks by one of its chats, or by its key once no chat is left", async () => {
    const { ctx, node } = fake();
    await callApi(ctx, "contact.block", { chat: "bob" });
    expect(await callApi(ctx, "contact.unblock", { chat: "chat-bob-2" })).toMatchObject({ peer: BOB, blocked: false });
    expect(node.setContactBlocked).toHaveBeenLastCalledWith({ peerPubKeyZ32: BOB, blocked: false });
    await callApi(ctx, "contact.block", { chat: "carol" });
    expect(await callApi(ctx, "contact.unblock", { chat: CAROL })).toMatchObject({ peer: CAROL, blocked: false });
    expect(await callApi(ctx, "contact.blocked", {})).toEqual({ contacts: [] });
  });

  it("refuses a chat nobody joined yet, and a name no chat has", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "contact.block", { chat: "pending" })).rejects.toMatchObject({ code: "refused" });
    await expect(callApi(ctx, "contact.block", { chat: "dave" })).rejects.toMatchObject({ code: "not_found" });
    await expect(callApi(ctx, "contact.unblock", { chat: "dave" })).rejects.toMatchObject({ code: "not_found" });
    expect(node.setContactBlocked).not.toHaveBeenCalled();
  });
});
