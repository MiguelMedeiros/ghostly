import { closeSync, ftruncateSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineState, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import type { StatusCard } from "@ghostly/core";
import { callApi, type ApiContext } from "../src/api";
import type { GhostlyEvent } from "../src/events";
import { serve, type Host, type Served } from "../src/host";
import { answerWithin } from "../src/main";
import { createProfile, profilePaths } from "../src/profiles";
import { chatViewOf } from "./support/chatView";
import { error, home, Running, type Result } from "./support/cli";
// covers: headless.daemon, headless.usage

/**
 * A call that waits once per chat or per copy (`usage send --all --wait sent`, `forward ... --to a --to b --wait sent`),
 * through a daemon, with the contacts away. The client gives the daemon one wait's `--timeout` plus 10 s to answer
 * (main.ts `answerWithin`); the waits ran one after another, a timeout each, so the command failed as "The daemon did
 * not answer usage.send in 11 s" (exit 4), told to restart a sound daemon, and every chat's result was lost.
 */
const link = (id: string) => ({ id, label: id, peerPubKeyZ32: `p${id}`, createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" } }) as unknown as LinkView;

/** An engine whose contacts are all away: what is sent waits for them, until `deliver`. */
function away(chats: string[], mode: "daemon" | "one-shot" = "daemon") {
  const rows = new Map<string, StoredMessage[]>();
  const of = (linkId: string) => rows.get(linkId) ?? rows.set(linkId, []).get(linkId)!;
  const listeners = new Set<(event: GhostlyEvent) => void>();
  let n = 0;
  const store = (linkId: string, fields: Partial<StoredMessage> = {}) => {
    const id = `me_${++n}`;
    of(linkId).push({ linkId, id, text: "hello", sender: "me", timestamp: Date.now(), via: "pkarr", delivery: "waiting", ...fields });
    return id;
  };
  const node = {
    chatView: chatViewOf,
    getState: () => ({ links: chats.map(link), groups: [], settings: {}, transport: {} }) as unknown as EngineState,
    getMessages: async (linkId: string) => of(linkId).map((m) => ({ ...m })),
    getMessage: async (linkId: string, id: string) => { const m = of(linkId).find((x) => x.id === id); return m && { ...m }; },
    groupMessages: async () => [],
    sendMessage: vi.fn(async ({ linkId, text, card }: { linkId: string; text: string; card?: unknown }) => ({ error: null, messageId: store(linkId, { text: text || "usage", card: card as StatusCard }) })),
    forwardMessages: vi.fn(async ({ messageIds, to }: { linkId: string; messageIds: string[]; to: string[] }) => ({
      results: to.map((linkId) => ({ to: linkId, messageIds: messageIds.map(() => store(linkId)), sent: [], error: null })),
    })),
  };
  const ctx = {
    runtime: { server: { node }, paths: { name: "default" } },
    hub: { onEvent: (listener: (event: GhostlyEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); }, onState: () => () => {}, lastSeq: 0, replay: () => [] },
    mode, version: "test",
  } as unknown as ApiContext;
  const deliver = (linkId: string, id: string) => {
    of(linkId).find((m) => m.id === id)!.delivery = "sent";
    for (const listener of listeners) listener({ type: "message.delivery", chat: linkId, messageId: id } as unknown as GhostlyEvent);
  };
  return { ctx, node, rows: of, store, deliver };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

/** A profile whose daemon runs in this process over `ctx` (the real socket API), held by this process as a daemon holds it. */
async function daemonOver(name: string, ctx: ApiContext): Promise<string> {
  const dir = home(name);
  const paths = createProfile(dir, "default");
  writeFileSync(paths.lock, String(process.pid));
  Object.assign(ctx.runtime, { paths: profilePaths(dir, "default") });
  const served: Served = await serve({ ctx } as unknown as Host);
  cleanups.push(() => served.close());
  return dir;
}

/** The command's result, or a failure in `ms` that leaves no `ghostly` behind. */
async function within(ms: number, args: string[]): Promise<Result & { ms: number }> {
  const started = performance.now();
  const run = new Running(args);
  try {
    const code = await run.exited(ms);
    return { code: code ?? -1, stdout: JSON.stringify(run.lines), stderr: run.stderr, json: run.lines.at(-1) ?? {}, ms: performance.now() - started };
  } finally { await run.stop(); }
}

describe.skipIf(process.platform === "win32")("a call that waits for several contacts away, through a daemon", () => {
  it("usage send --all --wait sent answers each chat's timeout within about one --timeout, as a one-shot does, not \"The daemon did not answer\"", async () => {
    // 12 chats at 1 s each, one after another, is past the client's 11 s.
    const chats = Array.from({ length: 12 }, (_, i) => `chat-${i}`);
    const { ctx, node } = away(chats);
    const dir = await daemonOver("usage-all-away", ctx);
    const result = await within(30_000, ["--home", dir, "usage", "send", "--all", "--left", "40", "--wait", "sent", "--timeout", "1"]);
    // Every chat timed out: the call fails as their timeout (exit 4), each chat's result in details, as a one-shot's.
    const failure = error(result, "timeout", 4) as { message: string; details?: { chats?: { chat: string; error: { code: string } }[] } };
    expect(failure.message).not.toMatch(/did not answer/);
    expect(failure.message).toMatch(/^No chat took the usage card: chat-0: Timed out after 1 s/);
    expect(failure.details?.chats?.map((c) => [c.chat, c.error.code])).toEqual(chats.map((chat) => [chat, "timeout"]));
    // The cards went one chat at a time, in order, each before its wait.
    expect(node.sendMessage.mock.calls.map(([call]) => call.linkId)).toEqual(chats);
    expect(result.ms, "the waits ran side by side: about one --timeout, not one per chat").toBeLessThan(9_000);
  }, 40_000);

  it("forward to two chats away with --wait sent answers the first copy's timeout with every target's result", async () => {
    const { ctx, store } = away(["source", "chat-a", "chat-b"]);
    const original = store("source", { sender: "peer", delivery: undefined });
    const dir = await daemonOver("forward-away", ctx);
    const result = await within(20_000, ["--home", dir, "forward", "source", original, "--to", "chat-a", "--to", "chat-b", "--wait", "sent", "--timeout", "1"]);
    const failure = error(result, "timeout", 4) as { message: string; details?: { messageId?: string; results?: { to: string; messageIds: string[] }[] } };
    expect(failure.message).not.toMatch(/did not answer/);
    expect(failure.details?.results?.map((r) => r.to)).toEqual(["chat-a", "chat-b"]);
    expect(failure.details?.messageId).toBe(failure.details?.results?.[0]?.messageIds[0]);
    expect(result.ms).toBeLessThan(9_000);
  }, 30_000);
});

describe("waits for several copies", () => {
  it("forward --wait sent waits for every copy at once: a copy that goes after the first's wait ended still has only --timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    const { ctx, store, deliver, rows } = away(["source", "chat-a", "chat-b"]);
    const original = store("source", { sender: "peer", delivery: undefined });
    let settled = false;
    const answer = callApi(ctx, "chat.forward", { chat: "source", messages: [original], to: ["chat-a", "chat-b"], wait: "sent", timeout: 1 }).catch((e: unknown) => e).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    const [a, b] = [rows("chat-a")[0]!.id, rows("chat-b")[0]!.id];
    // Chat a's copy goes at 0.6 s; chat b's never.
    setTimeout(() => deliver("chat-a", a), 600);
    await vi.advanceTimersByTimeAsync(1_050);
    // Before: b's wait began when a's ended (0.6 s) and ran its whole second from there, 1.6 s in all; with 5 targets
    // and 5 messages, 25 timeouts one after another.
    expect(settled, "answered once --timeout was over for every copy").toBe(true);
    expect(await answer).toMatchObject({ code: "timeout", details: { messageId: b, from: "source", results: [{ to: "chat-a", messageIds: [a] }, { to: "chat-b", messageIds: [b] }] } });
  });

  it("forward --wait sent with every copy away still names the first copy's timeout, as the copies went", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    const { ctx, store, rows } = away(["source", "chat-a", "chat-b"]);
    const original = store("source", { sender: "peer", delivery: undefined });
    const answer = callApi(ctx, "chat.forward", { chat: "source", messages: [original], to: ["chat-a", "chat-b"], wait: "sent", timeout: 1 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_050);
    expect(await answer).toMatchObject({ code: "timeout", details: { messageId: rows("chat-a")[0]!.id, results: [{ to: "chat-a" }, { to: "chat-b" }] } });
  });

  it("usage send --all --wait sent waits for every chat at once, each chat's card sent in order before its wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    const { ctx, node, deliver, rows } = away(["chat-a", "chat-b", "chat-c"]);
    let settled = false;
    const answer = callApi(ctx, "usage.send", { all: true, card: { left: 40 }, wait: "sent", timeout: 1 }).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(node.sendMessage.mock.calls.map(([call]) => call.linkId)).toEqual(["chat-a", "chat-b", "chat-c"]);
    // Chat b's card goes at 0.5 s, the others' never: each chat says its own, in the chats' order.
    setTimeout(() => deliver("chat-b", rows("chat-b")[0]!.id), 500);
    await vi.advanceTimersByTimeAsync(1_050);
    expect(settled, "answered after one --timeout, not one per chat").toBe(true);
    const { chats } = await answer as { chats: Record<string, unknown>[] };
    expect(chats.map((c) => c.chat)).toEqual(["chat-a", "chat-b", "chat-c"]);
    expect(chats[0]).toMatchObject({ error: { code: "timeout" } });
    expect(chats[1]).toMatchObject({ delivery: "sent", updated: false });
    expect(chats[2]).toMatchObject({ error: { code: "timeout" } });
  });
});

describe("file send's deadline", () => {
  it("gives the daemon the time to copy a large file in, on top of the wait's", () => {
    const dir = home("staging-deadline");
    const path = join(dir, "big.bin");
    // 1 GiB, sparse: no disk spent. The daemon copies it in before its wait starts (6-30 s here).
    const fd = openSync(path, "w");
    try { ftruncateSync(fd, 1024 ** 3); } finally { closeSync(fd); }
    expect(answerWithin("file.send", { chat: "bob", path, wait: "sent", timeout: 5 })).toBe((5 + 10 + 128) * 1000);
    expect(answerWithin("file.send", { chat: "bob", path, wait: "sent" })).toBe((300 + 10 + 128) * 1000);
    // A small one, or one it cannot read (the daemon refuses it at once), adds nothing worth a second.
    writeFileSync(join(dir, "small.txt"), "hi");
    expect(answerWithin("file.send", { chat: "bob", path: join(dir, "small.txt"), wait: "sent", timeout: 5 })).toBe(16_000);
    expect(answerWithin("file.send", { chat: "bob", path: join(dir, "gone.bin"), wait: "sent", timeout: 5 })).toBe(15_000);
    // Without a wait there is no deadline, as before: the copy takes as long as it takes.
    expect(answerWithin("file.send", { chat: "bob", path })).toBeUndefined();
  });
});
