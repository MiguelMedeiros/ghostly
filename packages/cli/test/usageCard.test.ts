import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineState, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { STATUS_CARD_LIMITS, checkStatusCard, statusCardText, type StatusCard } from "@ghostly/core";
import { callApi, type ApiContext } from "../src/api";
import { parseArgs } from "../src/args";
import { COMMANDS, idSlot, positionals } from "../src/commands";
import { chatOnly } from "../src/main";
// covers: headless.usage

/** `usage send` (WISP 405 § Usage) against an engine that keeps what it is sent. */
const link = (id: string, fields: Partial<LinkView> = {}) => ({ id, peerPubKeyZ32: "p" + id, createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" }, ...fields }) as unknown as LinkView;

function fake() {
  const rows = new Map<string, StoredMessage[]>();
  const of = (linkId: string) => rows.get(linkId) ?? rows.set(linkId, []).get(linkId)!;
  let n = 0;
  const card = (raw: unknown) => { const checked = checkStatusCard(raw); if ("error" in checked) throw new Error(checked.error); return checked.card; };
  const node = {
    getState: () => ({
      links: [link("chat-one", { label: "Miguel" }), link("chat-two", { label: "Ana" }), link("old-chat", { label: "Old", profile: undefined }), link("invite", { peerPubKeyZ32: "" })],
      groups: [], settings: {}, transport: {},
    }) as unknown as EngineState,
    getMessages: vi.fn(async (linkId: string) => of(linkId).map((m) => ({ ...m }))),
    groupMessages: vi.fn(async () => []),
    sendMessage: vi.fn(async ({ linkId, text, card: raw }: { linkId: string; text: string; card?: unknown }) => {
      const c = card(raw) as StatusCard;
      const id = `me_${++n}`;
      of(linkId).push({ linkId, id, wireId: `w${n}`, text: text || statusCardText(c), sender: "me", timestamp: Date.now(), via: "datalink", delivery: "sent", card: c });
      return { error: null, messageId: id };
    }),
    editMessage: vi.fn(async ({ linkId, messageId, card: raw }: { linkId: string; messageId: string; text: string; card?: unknown }) => {
      const row = of(linkId).find((m) => m.id === messageId)!;
      row.card = card(raw);
      row.edit = { seq: (row.edit?.seq ?? 0) + 1, at: Date.now(), history: [] };
      return { error: null, messageId };
    }),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node, rows: of };
}

function params(argv: string[]): Record<string, unknown> {
  const command = COMMANDS["usage send"]!;
  const parsed = parseArgs(argv, command.options ?? {}, idSlot(command));
  return command.params!(parsed, positionals(command, parsed.positionals));
}

const T0 = Date.UTC(2026, 9, 7, 12, 0);
afterEach(() => { vi.useRealTimers(); });

describe("usage send", () => {
  it("builds the card from flags, the JSON under them", () => {
    expect(params(["Miguel", "--left", "62", "--label", "Claude", "--account", "work", "--window", "5 h", "--resets", "2026-10-07T18:00:00Z",
      "--also", "week=80@2026-10-10T00:00:00Z", "--also", "opus=40", "--json", '{"label":"ignored","used":1,"limit":2}'])).toEqual({
      chat: "Miguel", all: false, text: undefined, wait: undefined, timeout: undefined,
      card: { label: "Claude", account: "work", left: 62, window: "5 h", used: 1, limit: 2, resetsAt: Date.UTC(2026, 9, 7, 18),
        windows: [{ window: "week", left: 80, resetsAt: Date.UTC(2026, 9, 10) }, { window: "opus", left: 40 }] },
    });
    expect(params(["--all", "--left", "5"])).toMatchObject({ chat: undefined, all: true, card: { left: 5 } });
    expect(() => params(["--left", "5"])).toThrow(expect.objectContaining({ code: "usage", message: expect.stringMatching(/Name a chat or group, or give --all/) }));
    expect(() => params(["Miguel", "--also", "week"])).toThrow(/--also takes window=percent/);
    expect(() => params(["Miguel", "--resets", "soon"])).toThrow(/--resets takes a time/);
  });

  it("sends the card once, then edits that one message with each report: one card per chat, whole reports", async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    const { ctx, node, rows } = fake();
    const first = await callApi(ctx, "usage.send", { chat: "Miguel", card: { label: "Claude", account: "work", left: 62, window: "5 h" } }) as Record<string, unknown>;
    expect(first).toMatchObject({ chat: "chat-one", usage: "usage", updated: false });
    expect(rows("chat-one")).toHaveLength(1);
    expect(rows("chat-one")[0].card).toEqual({ kind: "usage", id: "usage", label: "Claude", account: "work", left: 62, window: "5 h", updatedAt: T0 });
    expect(rows("chat-one")[0].text).toBe("📊 Claude · work · 62% left (5 h)");

    vi.setSystemTime(T0 + 600_000);
    const second = await callApi(ctx, "usage.send", { chat: "Miguel", card: { label: "Claude", left: 12 } }) as Record<string, unknown>;
    expect(second).toMatchObject({ usage: "usage", updated: true, queued: false, edits: 1 });
    expect(node.sendMessage).toHaveBeenCalledTimes(1);
    expect(rows("chat-one")).toHaveLength(1);
    // The account and the window were not said again: gone from the card.
    expect(rows("chat-one")[0].card).toEqual({ kind: "usage", id: "usage", label: "Claude", left: 12, updatedAt: T0 + 600_000 });
  });

  it("starts a new message once the card took its edits", async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    const { ctx, node, rows } = fake();
    await callApi(ctx, "usage.send", { chat: "Miguel", card: { left: 62 } });
    rows("chat-one")[0].edit = { seq: STATUS_CARD_LIMITS.edits, at: T0, history: [] };
    vi.setSystemTime(T0 + 600_000);
    expect(await callApi(ctx, "usage.send", { chat: "Miguel", card: { left: 50 } })).toMatchObject({ updated: false });
    expect(node.sendMessage).toHaveBeenCalledTimes(2);
    expect(rows("chat-one")).toHaveLength(2);
  });

  it("--all reports to every 1:1 chat with a contact, and refuses a bad report before sending anything", async () => {
    const { ctx, node, rows } = fake();
    const result = await callApi(ctx, "usage.send", { all: true, card: { left: 30, label: "Claude" } }) as { chats: Record<string, unknown>[] };
    expect(result.chats.map((c) => c.chat)).toEqual(["chat-one", "chat-two"]);
    expect(rows("chat-two")[0].card).toMatchObject({ kind: "usage", left: 30 });
    await expect(callApi(ctx, "usage.send", { all: true, card: { left: 140 } })).rejects.toMatchObject({ code: "bad_request", message: /left is a number from 0 to 100/ });
    await expect(callApi(ctx, "usage.send", { chat: "Miguel", card: { label: "Claude" } })).rejects.toMatchObject({ code: "bad_request", message: /left \(a percent\) or used and limit/ });
    expect(node.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("starts no group sessions for --all, as it reaches 1:1 chats only", () => {
    expect(chatOnly("usage.send", { all: true })).toBe(true);
    expect(chatOnly("usage.send", { chat: "Sala" })).toBe(false);
  });
});
