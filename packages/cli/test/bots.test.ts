import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { EngineState, FileTransferView, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import type { GhostlyEvent } from "../src/events";
import { resumeHolds } from "../src/holds";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.files, headless.typing, headless.chat, headless.api

/**
 * What a bot leans on, over a fake engine: waiting for a file, typing kept alive, and a chat held off its direct
 * link for a while.
 */
beforeAll(async () => {
  await openPersistentIndexedDb(join(mkdtempSync(join(tmpdir(), "ghostly-bots-")), "db"));
});
afterEach(() => { vi.useRealTimers(); });

const link = (id: string, fields: Partial<LinkView> = {}) => ({ id, peerPubKeyZ32: "p" + id, createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", dataLink: "open", pairing: { status: "ready" }, ...fields }) as unknown as LinkView;

function fake(mode: "daemon" | "one-shot" = "daemon") {
  const events = new Set<(e: GhostlyEvent) => void>();
  const states = new Set<(s: EngineState) => void>();
  const emitted: GhostlyEvent[] = [];
  const s = {
    links: [link("chat-one", { label: "Alice" }), link("chat-two", { peerNick: "Bob" })],
    groups: [], settings: {}, transport: {}, transfers: {} as Record<string, FileTransferView>,
  } as unknown as EngineState;
  const node = {
    getState: () => s,
    setTyping: vi.fn(),
    sendMessage: vi.fn(async () => ({ error: null, messageId: "me_1" })),
    getMessages: vi.fn(async () => []),
    fileAction: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    connect: vi.fn(async () => undefined),
    setChatTransport: vi.fn(async ({ linkId, transport }: { linkId: string; transport: string }) => { if (transport === "dht") setLink(linkId, { deliveryMode: "dht", textDelivery: "dht" }); }),
    setDeliveryMode: vi.fn(async ({ linkId, mode: m }: { linkId: string; mode: string }) => { setLink(linkId, { deliveryMode: m as never }); }),
  };
  const setLink = (linkId: string, fields: Partial<LinkView>) => { s.links = s.links.map((l) => (l.id === linkId ? { ...l, ...fields } : l)); };
  const dir = mkdtempSync(join(tmpdir(), "ghostly-bots-profile-"));
  const ctx = {
    runtime: { server: { node }, paths: { name: "default", dir } },
    hub: {
      onEvent: (l: (e: GhostlyEvent) => void) => { events.add(l); return () => events.delete(l); },
      onState: (l: (s: EngineState) => void) => { states.add(l); return () => states.delete(l); },
      emit: (type: string, id: string, fields: Record<string, unknown> = {}) => { const e = { seq: emitted.length + 1, id, type, at: 1, ...fields }; emitted.push(e); for (const l of events) l(e); return e; },
      lastSeq: 0, replay: () => [],
    },
    mode, version: "test",
  } as unknown as ApiContext;
  const transfer = (id: string, t: FileTransferView) => { s.transfers = { ...s.transfers, [id]: t }; for (const l of states) l(s); };
  const event = (e: Partial<GhostlyEvent>) => { for (const l of events) l({ seq: 0, id: "x", at: 1, type: "x", ...e }); };
  return { ctx, node, s, dir, emitted, transfer, event, setLink };
}

describe("file wait", () => {
  it("answers once the file is all here, by its id alone or with its chat", async () => {
    const { ctx, transfer } = fake();
    transfer("chat-one-in-a", { state: "transferring", transferred: 10, size: 100, direction: "in" });
    const waiting = callApi(ctx, "file.wait", { file: "chat-one-in-a", timeout: 5 });
    transfer("chat-one-in-a", { state: "done", transferred: 100, size: 100, direction: "in" });
    expect(await waiting).toEqual({ chat: "chat-one", file: "chat-one-in-a", state: "done", size: 100 });
    expect(await callApi(ctx, "file.wait", { chat: "Alice", file: "chat-one-in-a" })).toMatchObject({ state: "done" });
    await expect(callApi(ctx, "file.wait", { chat: "Bob", file: "chat-one-in-a" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("fails with the transfer's error, and says whether it can be sent again", async () => {
    const { ctx, transfer } = fake();
    transfer("chat-one-out-b", { state: "transferring", transferred: 0, size: 9, direction: "out" });
    const waiting = callApi(ctx, "file.wait", { file: "chat-one-out-b" });
    transfer("chat-one-out-b", { state: "failed", transferred: 3, size: 9, direction: "out", error: "The contact declined it", retry: true });
    await expect(waiting).rejects.toMatchObject({ code: "engine", message: "The contact declined it", details: { file: "chat-one-out-b", chat: "chat-one", retry: true } });
  });

  it("times out with how far it got; an unknown file is not found", async () => {
    const { ctx, transfer } = fake();
    transfer("chat-one-in-c", { state: "transferring", transferred: 40, size: 100, direction: "in", stage: "paused" });
    await expect(callApi(ctx, "file.wait", { file: "chat-one-in-c", timeout: 1 })).rejects.toMatchObject({ code: "timeout", details: { transferred: 40, size: 100, stage: "paused" } });
    await expect(callApi(ctx, "file.wait", { file: "chat-one-in-nothing" })).rejects.toMatchObject({ code: "not_found" });
    await expect(callApi(ctx, "file.wait", { file: "nochat-in-x" })).rejects.toMatchObject({ code: "not_found" });
  }, 10_000);

  it("file save --wait waits first; the file commands take the file alone", async () => {
    const { ctx, node, transfer } = fake();
    transfer("chat-two-in-d", { state: "transferring", transferred: 0, size: 5, direction: "in", stage: "asking" });
    expect(await callApi(ctx, "file.action", { file: "chat-two-in-d", action: "accept" })).toMatchObject({ chat: "chat-two", action: "accept" });
    expect(node.fileAction).toHaveBeenLastCalledWith({ linkId: "chat-two", fileId: "chat-two-in-d", action: "accept" });
    await expect(callApi(ctx, "file.action", { chat: "Alice", file: "chat-two-in-d", action: "cancel" })).rejects.toMatchObject({ code: "not_found" });
    // The bytes are not in this fake's store: saving fails after the wait, not before it.
    const saving = callApi(ctx, "file.save", { file: "chat-two-in-d", wait: true, timeout: 5 });
    let settled = false;
    void saving.catch(() => {}).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    transfer("chat-two-in-d", { state: "done", transferred: 5, size: 5, direction: "in" });
    await expect(saving).rejects.toMatchObject({ code: "not_found", message: "No file chat-two-in-d" });
  });
});

describe("typing --for", () => {
  it("says it again until the time is up, then says it stopped", async () => {
    vi.useFakeTimers();
    const { ctx, node } = fake();
    const answer = await callApi(ctx, "chat.typing", { chat: "Alice", for: 5 }) as { until: number };
    expect(answer).toMatchObject({ chat: "chat-one", typing: true, live: true });
    expect(answer.until).toBeGreaterThan(Date.now());
    expect(node.setTyping).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4_600);
    expect(node.setTyping.mock.calls.filter(([a]) => a.typing).length).toBeGreaterThanOrEqual(4);
    vi.advanceTimersByTime(500);
    expect(node.setTyping).toHaveBeenLastCalledWith({ linkId: "chat-one", typing: false });
    const calls = node.setTyping.mock.calls.length;
    vi.advanceTimersByTime(10_000);
    expect(node.setTyping).toHaveBeenCalledTimes(calls);
  });

  it("ends with a message to the chat (sent here or from anywhere) or a stop", async () => {
    vi.useFakeTimers();
    const { ctx, node, event } = fake();
    await callApi(ctx, "chat.typing", { chat: "Alice", for: 60 });
    await callApi(ctx, "chat.send", { chat: "Alice", text: "hi" });
    let calls = node.setTyping.mock.calls.length;
    vi.advanceTimersByTime(10_000);
    expect(node.setTyping).toHaveBeenCalledTimes(calls);

    await callApi(ctx, "chat.typing", { chat: "Alice", for: 60 });
    event({ type: "message.sent", chat: "chat-two" });
    vi.advanceTimersByTime(2_000);
    expect(node.setTyping.mock.calls.length).toBeGreaterThan(calls + 1);
    event({ type: "message.sent", chat: "chat-one" });
    calls = node.setTyping.mock.calls.length;
    vi.advanceTimersByTime(10_000);
    expect(node.setTyping).toHaveBeenCalledTimes(calls);

    await callApi(ctx, "chat.typing", { chat: "Alice", for: 60 });
    await callApi(ctx, "chat.typing", { chat: "Alice", stop: true });
    calls = node.setTyping.mock.calls.length;
    expect(node.setTyping).toHaveBeenLastCalledWith({ linkId: "chat-one", typing: false });
    vi.advanceTimersByTime(10_000);
    expect(node.setTyping).toHaveBeenCalledTimes(calls);
    await expect(callApi(ctx, "chat.typing", { chat: "Alice", for: 5, stop: true })).rejects.toMatchObject({ code: "bad_request" });
    await expect(callApi(ctx, "chat.typing", { chat: "Alice", for: 601 })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("a one-shot stays until the time is up", async () => {
    vi.useFakeTimers();
    const { ctx, node } = fake("one-shot");
    let done = false;
    const typing = callApi(ctx, "chat.typing", { chat: "Alice", for: 2 }).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    await typing;
    expect(node.setTyping).toHaveBeenLastCalledWith({ linkId: "chat-one", typing: false });
  });
});

describe("chat disconnect --hold", () => {
  it("puts the chat on DHT only for that long, keeps it in the profile folder, and chat connect ends it", async () => {
    const { ctx, node, dir, emitted } = fake();
    const held = await callApi(ctx, "chat.disconnect", { chat: "Alice", hold: 30 }) as { heldUntil: number };
    expect(node.setChatTransport).toHaveBeenCalledWith({ linkId: "chat-one", transport: "dht" });
    expect(held.heldUntil).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect(JSON.parse(readFileSync(join(dir, "holds.json"), "utf8"))["chat-one"].until).toBe(held.heldUntil);
    expect(await callApi(ctx, "chat.get", { chat: "Alice" })).toMatchObject({ heldUntil: held.heldUntil, deliveryMode: "dht" });
    // Again: from now, with no second switch.
    await callApi(ctx, "chat.disconnect", { chat: "Alice", hold: 60 });
    expect(node.setChatTransport).toHaveBeenCalledTimes(1);
    await callApi(ctx, "chat.connect", { chat: "Alice" });
    expect(node.setDeliveryMode).toHaveBeenCalledWith({ linkId: "chat-one", mode: "stream" });
    expect(node.connect).toHaveBeenCalled();
    expect(await callApi(ctx, "chat.get", { chat: "Alice" })).toMatchObject({ heldUntil: null, deliveryMode: "stream" });
    expect(emitted.map((e) => [e.type, e.reason ?? null])).toEqual([["chat.held", null], ["chat.held", null], ["chat.released", "connect"]]);
    // Without --hold, disconnect is what it was.
    await callApi(ctx, "chat.disconnect", { chat: "Bob" });
    expect(node.disconnect).toHaveBeenCalledWith({ linkId: "chat-two" });
  });

  it("never takes back a DHT only the chat chose itself; --hold 0 ends a hold now", async () => {
    const { ctx, node, setLink, emitted } = fake();
    setLink("chat-two", { deliveryMode: "dht" });
    await expect(callApi(ctx, "chat.disconnect", { chat: "Bob", hold: 5 })).rejects.toMatchObject({ code: "refused" });
    await callApi(ctx, "chat.connect", { chat: "Bob" });
    expect(node.setDeliveryMode).not.toHaveBeenCalled();
    await callApi(ctx, "chat.disconnect", { chat: "Alice", hold: 5 });
    await callApi(ctx, "chat.disconnect", { chat: "Alice", hold: 0 });
    expect(node.setDeliveryMode).toHaveBeenCalledWith({ linkId: "chat-one", mode: "stream" });
    expect(emitted.at(-1)).toMatchObject({ type: "chat.released", chat: "chat-one", reason: "lifted" });
    await expect(callApi(ctx, "chat.disconnect", { chat: "Alice", hold: 10_081 })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("ends by itself when the time is up, also after a restart", async () => {
    const first = fake();
    await callApi(first.ctx, "chat.disconnect", { chat: "Alice", hold: 1 });
    // The daemon went away; the next start finds a hold whose time is up.
    const holds = join(first.dir, "holds.json");
    writeFileSync(holds, JSON.stringify({ "chat-one": { until: Date.now() - 1, since: 1 } }));
    const second = fake();
    (second.ctx.runtime.paths as { dir: string }).dir = first.dir;
    second.setLink("chat-one", { deliveryMode: "dht" });
    resumeHolds(second.ctx);
    await vi.waitFor(() => expect(second.node.setDeliveryMode).toHaveBeenCalledWith({ linkId: "chat-one", mode: "stream" }));
    await vi.waitFor(() => expect(JSON.parse(readFileSync(holds, "utf8"))).toEqual({}));
    expect(second.emitted.at(-1)).toMatchObject({ type: "chat.released", reason: "expired" });
    expect(existsSync(holds)).toBe(true);
  });
});
