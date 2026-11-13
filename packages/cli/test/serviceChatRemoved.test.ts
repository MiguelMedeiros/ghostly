import { mkdtempSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { callApi, type ApiContext } from "../src/api";
import { SERVICE_METHODS } from "../src/services";
// covers: headless.services

/** Whether anything still answers on the port (a refused connection is `false`). */
const answers = (port: number) => new Promise<boolean>((resolve) => {
  const req = httpRequest({ host: "127.0.0.1", port, path: "/" }, (res) => { res.resume(); resolve(true); });
  req.on("error", () => resolve(false));
  req.end();
});

/** A daemon whose engine holds these chats; `removeLink` takes one out. */
function daemonWith(links: { id: string; peerPubKeyZ32: string }[]): ApiContext {
  const node = { getState: () => ({ links, groups: [], settings: {} }), getSettings: () => ({}), removeLink: async ({ linkId }: { linkId: string }) => { links.splice(links.findIndex((l) => l.id === linkId), 1); }, removalsPending: () => [] };
  return {
    mode: "daemon", version: "test", runtime: { server: { node }, paths: { name: "default", dir: mkdtempSync(join(tmpdir(), "ghostly-service-chat-removed-")) } },
    calls: { list: () => [], forgetChat: () => {} }, groupAuto: { forgetChat: () => {} },
  } as unknown as ApiContext;
}

/** `chat remove`: a contact's service opened from that chat closes with it. */
describe("a service opened from a chat that is removed", () => {
  it("is closed by chat remove, not left on its port for good", async () => {
    const link = { id: "gonechat", peerPubKeyZ32: "gonepeer", peerServices: [{ id: "app", name: "App" }] };
    const links = [link];
    const ctx = daemonWith(links);
    const { url } = (await SERVICE_METHODS["service.open"](ctx, { chat: link.id, service: "app" })) as { url: string };
    const port = Number(new URL(url).port);
    expect(await answers(port)).toBe(true);

    await callApi(ctx, "chat.remove", { chat: link.id, yes: true });

    // Before, the server stayed (every request a 503), and `service close` answered `No chat "gonechat"`.
    expect(await answers(port)).toBe(false);
  });

  it("is closed by the raw engine removeLink too", async () => {
    const link = { id: "rawchat", peerPubKeyZ32: "rawpeer", peerServices: [{ id: "app", name: "App" }] };
    const ctx = daemonWith([link]);
    const { url } = (await SERVICE_METHODS["service.open"](ctx, { chat: link.id, service: "app" })) as { url: string };

    await callApi(ctx, "engine.call", { method: "removeLink", params: { linkId: link.id }, yes: true });

    expect(await answers(Number(new URL(url).port))).toBe(false);
  });

  it("stays open while another chat with the same contact is left", async () => {
    const one = { id: "firstchat", peerPubKeyZ32: "keptpeer", peerServices: [{ id: "app", name: "App" }] };
    const links = [one, { ...one, id: "secondchat" }];
    const ctx = daemonWith(links);
    const { url } = (await SERVICE_METHODS["service.open"](ctx, { chat: one.id, service: "app" })) as { url: string };

    await callApi(ctx, "chat.remove", { chat: one.id, yes: true });

    expect(await answers(Number(new URL(url).port))).toBe(true);
    expect(await SERVICE_METHODS["service.close"](ctx, { chat: "secondchat", service: "app" })).toEqual({ closed: "keptpeer/app" });
  });
});
