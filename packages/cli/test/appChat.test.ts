import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appCardId } from "@ghostly/core";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { reportAppFrames } from "../src/appEvents";
import type { ServedApp } from "../src/appServe";
// covers: headless.api

/** A served app in a chat, over a fake engine: what `app open` and `app close` ask of it, and what they refuse first. */
const REF = `${"y".repeat(52)}/chess`;
const CHESS: ServedApp = { ref: REF, title: "Chess", version: "2.3.0", sequence: 4, digest: "E".repeat(43), url: "https://raw.githubusercontent.com/o/chess/HEAD/app.ghostlyapp", permissions: ["chat", "name"], granted: ["chat", "name"], servedAt: 1 };
const link = (id: string, fields: Partial<LinkView> = {}) => ({ id, peerPubKeyZ32: "p" + id, createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", ...fields }) as unknown as LinkView;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fake({ mode = "daemon", apps = true, served = [CHESS] }: { mode?: string; apps?: boolean; served?: readonly ServedApp[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ghostly-app-chat-"));
  dirs.push(dir);
  writeFileSync(join(dir, "apps.json"), JSON.stringify(served));
  const node = {
    getState: () => ({ links: [link("chat-one", { label: "Alice" })], groups: [] }) as unknown as EngineState,
    appId: ({ linkId, ref }: { linkId: string; ref: string }) => ({ app: `id:${linkId}:${ref.split("/")[1]}` }),
    appOpen: vi.fn(async () => ({ app: "id" })),
    appClose: vi.fn(),
    appSend: vi.fn(async (): Promise<{ error: string | null }> => ({ error: null })),
    sendMessage: vi.fn(async (): Promise<{ error: string | null; refused?: boolean; messageId?: string }> => ({ error: null, messageId: "me_1" })),
  };
  let frames: (chat: string, frame: never) => void = () => {};
  const hub = { onAppFrame: (listener: typeof frames) => { frames = listener; return () => {}; }, emit: vi.fn() };
  reportAppFrames(hub as never, node, dir);
  const ctx = { runtime: { server: { node }, paths: { dir }, apps }, hub, mode, version: "test" } as unknown as ApiContext;
  return { ctx, node, frame: (frame: Record<string, unknown>) => frames("chat-one", frame as never) };
}

describe("app open", () => {
  it("says the app is open and sends its card, made from the served bundle", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "app.open", { chat: "Alice", ref: "chess" })).toEqual({ chat: "chat-one", app: REF, version: "2.3.0", card: "me_1", peer: null, live: false });
    expect(node.appOpen).toHaveBeenCalledWith({ linkId: "chat-one", ref: REF, version: "2.3.0" });
    expect(node.sendMessage).toHaveBeenCalledWith({ linkId: "chat-one", text: "", card: { kind: "app", id: appCardId(REF), ref: REF, digest: CHESS.digest, sequence: 4, title: "Chess", version: "2.3.0", url: CHESS.url, opened: true } });
  });

  it("sends no card when the contact's app is open there already, or with noCard", async () => {
    const { ctx, node, frame } = fake();
    frame({ app: "id:chat-one:chess", o: "open", v: "2.2.0" });
    expect(await callApi(ctx, "app.open", { chat: "Alice", ref: REF })).toMatchObject({ card: null, peer: "2.2.0" });
    frame({ app: "id:chat-one:chess", o: "close" });
    expect(await callApi(ctx, "app.open", { chat: "Alice", ref: REF, noCard: true })).toMatchObject({ card: null, peer: null });
    expect(node.appOpen).toHaveBeenCalledTimes(2);
    expect(node.sendMessage).not.toHaveBeenCalled();
  });

  it("is not left half open when the card cannot go", async () => {
    const { ctx, node } = fake();
    node.sendMessage.mockResolvedValueOnce({ error: "You are offline" });
    await expect(callApi(ctx, "app.open", { chat: "Alice", ref: REF })).rejects.toMatchObject({ code: "unavailable", message: "You are offline" });
    expect(node.appClose).toHaveBeenCalledWith({ linkId: "chat-one", ref: REF });
  });

  it("refuses an app that is not served, a one-shot, and a daemon that offers no apps/1 yet, before the engine is asked", async () => {
    for (const [options, code] of [[{ served: [] }, "not_found"], [{ mode: "one-shot" }, "unavailable"], [{ apps: false }, "unavailable"]] as const) {
      const { ctx, node } = fake(options);
      await expect(callApi(ctx, "app.open", { chat: "Alice", ref: REF }), code).rejects.toMatchObject({ code });
      await expect(callApi(ctx, "app.close", { chat: "Alice", ref: REF }), code).rejects.toMatchObject({ code });
      expect(node.appOpen).not.toHaveBeenCalled();
      expect(node.appClose).not.toHaveBeenCalled();
    }
    const { ctx } = fake();
    await expect(callApi(ctx, "app.open", { chat: "Nobody", ref: REF })).rejects.toMatchObject({ code: "not_found" });
  });

  it("says why in the engine's words when the chat cannot carry an app", async () => {
    const { ctx, node } = fake();
    node.appOpen.mockRejectedValueOnce(new Error("This chat is not paired yet"));
    await expect(callApi(ctx, "app.open", { chat: "Alice", ref: REF })).rejects.toMatchObject({ code: "refused", message: "This chat is not paired yet" });
    expect(node.sendMessage).not.toHaveBeenCalled();
  });
});

describe("app close", () => {
  it("closes the served app in the chat", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "app.close", { chat: "Alice", ref: "chess" })).toEqual({ chat: "chat-one", app: REF, closed: true });
    expect(node.appClose).toHaveBeenCalledWith({ linkId: "chat-one", ref: REF });
  });
});

describe("app send", () => {
  it("hands the app's message to the engine as it is", async () => {
    const { ctx, node } = fake();
    for (const data of [{ p: "chess", v: 2, k: "move", g: "00", n: 0, m: "e2e4" }, 0, null, "", [1, 2]]) {
      expect(await callApi(ctx, "app.send", { chat: "Alice", ref: "chess", data })).toEqual({ chat: "chat-one", app: REF, sent: true });
      expect(node.appSend).toHaveBeenLastCalledWith({ linkId: "chat-one", ref: REF, data });
    }
  });

  it("says why a frame did not go, by the engine's name for it", async () => {
    const { ctx, node } = fake();
    for (const [reason, code] of [["not-open", "refused"], ["too-large", "bad_request"], ["offline", "unavailable"], ["peer-closed", "unavailable"], ["too-fast", "refused"]] as const) {
      node.appSend.mockResolvedValueOnce({ error: reason });
      await expect(callApi(ctx, "app.send", { chat: "Alice", ref: REF, data: 1 }), reason).rejects.toMatchObject({ code, details: { reason } });
    }
  });

  it("refuses no message, an app not served and a one-shot, before the engine is asked", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "app.send", { chat: "Alice", ref: REF })).rejects.toMatchObject({ code: "bad_request" });
    await expect(callApi(fake({ served: [] }).ctx, "app.send", { chat: "Alice", ref: REF, data: 1 })).rejects.toMatchObject({ code: "not_found" });
    await expect(callApi(fake({ mode: "one-shot" }).ctx, "app.send", { chat: "Alice", ref: REF, data: 1 })).rejects.toMatchObject({ code: "unavailable" });
    expect(node.appSend).not.toHaveBeenCalled();
  });
});
