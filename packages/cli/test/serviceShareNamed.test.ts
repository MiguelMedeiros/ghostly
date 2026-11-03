import { describe, expect, it, vi } from "vitest";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
// covers: headless.services

/**
 * `service share` is a grant the contact keeps using: their app reaches the service until it is taken back. So, as
 * `call auto --from` and `listen --from`, it names its chat by the chat's id, its contact's key or this side's label,
 * never only by what the contact chose (a prefix of the id, the name it gave itself). Before, `service share notes alice`
 * shared the service with whichever contact called itself "alice" when no chat had that label.
 */
const KEY = "y".repeat(52);
function fake() {
  const links = [
    { id: "chat-real-alice", label: "Alice", peerNick: "alice", peerPubKeyZ32: "o".repeat(51) + "y", profile: "paired-chat/1" },
    { id: "chat-mallory", label: null, peerNick: "Bob", peerPubKeyZ32: KEY, profile: "paired-chat/1" },
  ] as unknown as LinkView[];
  const node = {
    getState: () => ({ links, groups: [], settings: {}, transport: {},
      services: [{ id: "svc-1", name: "Notes", target: "http://127.0.0.1:8080", enabled: true, sharedWith: [], requests: 0 }] }) as unknown as EngineState,
    setServiceShared: vi.fn(async () => {}),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

describe("service share names its chat", () => {
  it("by the chat's id, its contact's key or this side's label", async () => {
    const { ctx, node } = fake();
    for (const chat of ["chat-mallory", KEY]) {
      expect(await callApi(ctx, "service.share", { service: "svc-1", chat })).toEqual({ service: "svc-1", chat: "chat-mallory", shared: true });
    }
    expect(await callApi(ctx, "service.share", { service: "svc-1", chat: "alice" })).toEqual({ service: "svc-1", chat: "chat-real-alice", shared: true });
    expect(node.setServiceShared).toHaveBeenCalledTimes(3);
  });

  it("never only by its contact's own name or a prefix of its id, and shares nothing", async () => {
    const { ctx, node } = fake();
    for (const chat of ["Bob", "chat-mall"]) {
      await expect(callApi(ctx, "service.share", { service: "svc-1", chat })).rejects.toMatchObject({ code: "bad_request", details: { chat: "chat-mallory", contact: KEY } });
    }
    expect(node.setServiceShared).not.toHaveBeenCalled();
  });
});
