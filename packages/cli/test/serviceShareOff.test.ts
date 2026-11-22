import { describe, expect, it, vi } from "vitest";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { chatViewOf } from "./support/chatView";
// covers: headless.services

/**
 * On the socket, `service.share` and `service.enable` answer `shared` and `enabled`, but took only `off`: any other key
 * was dropped. So `{"shared": false}`, the answer's own key sent back to take a grant away, gave the contact the service,
 * and `{"enabled": false}` turned it on. Now the answer's key is read as the request it says, and refused beside an
 * `off` that says the opposite.
 */
const KEY = "y".repeat(52);
function fake() {
  const links = [{ id: "chat-bob", label: "bob", peerNick: "Bob", peerPubKeyZ32: KEY, profile: "paired-chat/1" }] as unknown as LinkView[];
  const node = {
    chatView: chatViewOf, getState: () => ({ links, groups: [], settings: {}, transport: {},
      services: [{ id: "svc-1", name: "Notes", target: "http://127.0.0.1:8080", enabled: true, sharedWith: [KEY], requests: 0 }] }) as unknown as EngineState,
    setServiceShared: vi.fn(async () => {}),
    setServiceEnabled: vi.fn(async () => {}),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

describe("service share and enable over the socket", () => {
  it("shared: false takes the grant back, as off does", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "service.share", { service: "svc-1", chat: "bob", shared: false })).toEqual({ service: "svc-1", chat: "chat-bob", shared: false });
    expect(node.setServiceShared).toHaveBeenLastCalledWith({ serviceId: "svc-1", peerPubKeyZ32: KEY, shared: false });
    expect(await callApi(ctx, "service.share", { service: "svc-1", chat: "bob", shared: true })).toMatchObject({ shared: true });
    expect(await callApi(ctx, "service.share", { service: "svc-1", chat: "bob", off: true })).toMatchObject({ shared: false });
  });

  it("enabled: false turns the service off, as off does", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "service.enable", { service: "svc-1", enabled: false })).toEqual({ service: "svc-1", enabled: false });
    expect(node.setServiceEnabled).toHaveBeenLastCalledWith({ serviceId: "svc-1", enabled: false });
    expect(await callApi(ctx, "service.enable", { service: "svc-1" })).toEqual({ service: "svc-1", enabled: true });
  });

  it("refuses the answer's key beside an off that says the opposite, or a key that is no true or false, and changes nothing", async () => {
    const { ctx, node } = fake();
    for (const params of [{ shared: true, off: true }, { shared: false, off: false }, { shared: "no" }]) {
      await expect(callApi(ctx, "service.share", { service: "svc-1", chat: "bob", ...params })).rejects.toMatchObject({ code: "bad_request" });
    }
    for (const params of [{ enabled: true, off: true }, { enabled: 0 }]) {
      await expect(callApi(ctx, "service.enable", { service: "svc-1", ...params })).rejects.toMatchObject({ code: "bad_request" });
    }
    expect(node.setServiceShared).not.toHaveBeenCalled();
    expect(node.setServiceEnabled).not.toHaveBeenCalled();
  });
});
