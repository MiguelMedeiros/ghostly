import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { EngineState, GroupPayNote, GroupView, PaymentView, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { EventHub, type GhostlyEvent } from "../src/events";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { pageOf } from "./support/messagePage";
import { groupMessageJson, type MessageJson } from "../src/views";
// covers: headless.groups

/**
 * A group's payment as `group history` says it (WISP 902 § Payments): the note's line carries who pays whom, how much,
 * over what and how it stands (`groupPay`), and the payment's own line on this profile (the requester's request, the
 * request as it came over the edge) says it is that note's twin (`twinOf`), as the app draws the payment once.
 */
beforeAll(async () => { await openPersistentIndexedDb(join(mkdtempSync(join(tmpdir(), "ghostly-group-pay-")), "db")); });

const members = [
  { key: "mekey", role: "admin", me: false, online: true, missing: 0, nick: "Me" },
  { key: "anakey", role: "member", me: false, online: true, missing: 0, nick: "Ana" },
  { key: "bokey", role: "member", me: false, online: true, missing: 0, nick: "Bo" },
];
/** The group as `who` sees it. */
const groupOf = (who: string) => ({
  id: "g1", name: "Crew", createdAt: 1, profile: "mesh", isAdmin: who === "mekey", canSend: true, lastMessageAt: 0, invited: [], memberLinks: {}, myKey: who,
  members: members.map((m) => ({ ...m, me: m.key === who, ...(m.key !== who && { edge: { linkId: `edge-${m.key}`, state: "open" } }) })),
}) as unknown as GroupView;

const REQUESTED = "⚡ Requested 50 test sats";
const note = (fields: Partial<GroupPayNote> = {}): GroupPayNote => ({ id: "req12345", kind: "request", from: "*", to: "mekey", amount: "50", unit: "sat", decimals: 0,
  rail: "cashu", test: true, createdAt: 1, state: "open", ...fields });
/** The note's line, as GroupPayments keeps it in every member's history. */
const noteLine = (who: string, fields: Partial<GroupPayNote> = {}): StoredMessage => ({ linkId: "group:g1", id: "gpay:req12345", text: REQUESTED,
  sender: who === "mekey" ? "me" : "peer", member: "mekey", timestamp: 1, via: "datalink", groupPay: note(fields) });
/** The requester's own line about it. */
const ownRequest: StoredMessage = { linkId: "group:g1", id: "me_2", text: `${REQUESTED} from the group`, sender: "me", timestamp: 2, via: "datalink", paymentId: "req12345" };
/** The request as it came to another member, over its edge with the requester. */
const edgeRequest: StoredMessage = { linkId: "group:g1", id: "edge1:peer_req12345", text: `${REQUESTED} from the group`, sender: "peer", member: "mekey", timestamp: 2,
  via: "datalink", paymentId: "req12345" };
const plain: StoredMessage = { linkId: "group:g1", id: "anakey:1:3", text: "hello", sender: "peer", member: "anakey", timestamp: 3, via: "datalink" };

function fake(who: string, messages: StoredMessage[], payments: Record<string, Partial<PaymentView>>) {
  const node = {
    getState: () => ({ links: [], groups: [groupOf(who)], settings: {}, transport: {}, payments }) as unknown as EngineState,
    messagePage: vi.fn(async (params: { limit?: number; before?: string | number }) => pageOf(messages, params)),
    getMessage: vi.fn(async (_chat: string, id: string) => messages.find((m) => m.id === id)),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] },
    groupAuto: { get: () => ({ on: false, from: [] }) }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

const history = async (ctx: ApiContext, params: Record<string, unknown> = {}) =>
  (await callApi(ctx, "group.history", { group: "Crew", ...params }) as { messages: MessageJson[] }).messages;

describe("a group payment note in group history", () => {
  it("says how the request stands, who asked and who paid, with its text as it was", () => {
    const line = (fields: Partial<GroupPayNote>) => groupMessageJson(noteLine("anakey", fields), groupOf("anakey"));
    const open = line({});
    expect(open.groupPay).toEqual({ id: "req12345", kind: "request", from: "*", to: "mekey", by: null, claims: [], amount: "50", decimals: 0, unit: "sat",
      rail: "cashu", state: "open", test: true });
    expect(open).toMatchObject({ id: "gpay:req12345", text: REQUESTED, member: "mekey", nick: "Me" });
    // Paid: who paid it, and who said they did (one member's word was taken back); then a closed one.
    expect(line({ state: "paid", by: "bokey", claims: ["bokey", "anakey"] }).groupPay).toMatchObject({ state: "paid", by: "bokey", claims: ["bokey", "anakey"] });
    expect(line({ state: "paid", by: "bokey" }).text).toBe(REQUESTED);
    expect(line({ state: "closed" }).groupPay).toMatchObject({ state: "closed", by: null });
    // A payment sent to a member names both; a request to the group paid by invoice names nobody, as the app says it.
    expect(line({ kind: "payment", from: "anakey", to: "bokey", state: "sent" }).groupPay).toMatchObject({ kind: "payment", from: "anakey", to: "bokey", state: "sent" });
    expect(line({ rail: "lightning", state: "paid", by: "bokey", claims: ["bokey"] }).groupPay).toMatchObject({ by: null, claims: ["bokey"], rail: "lightning" });
  });

  it("marks the requester's own line about it as the note's twin, and leaves a plain message as it was", async () => {
    const { ctx } = fake("mekey", [noteLine("mekey"), ownRequest, plain], { req12345: { id: "req12345", kind: "request", direction: "out" } });
    const [n, own, text] = await history(ctx);
    expect(own).toMatchObject({ id: "me_2", paymentId: "req12345", twinOf: "gpay:req12345", text: `${REQUESTED} from the group` });
    expect(own.groupPay).toBeUndefined();
    expect(n).toMatchObject({ id: "gpay:req12345", groupPay: { state: "open", to: "mekey" } });
    expect(n.twinOf).toBeUndefined();
    expect(text).toEqual(groupMessageJson(plain, groupOf("mekey")));
    expect(text).not.toHaveProperty("groupPay");
    expect(text).not.toHaveProperty("twinOf");
  });

  it("marks the request another member got over its edge, also when the note's line is on another page", async () => {
    const paid = noteLine("anakey", { state: "paid", by: "anakey", claims: ["anakey"] });
    const { ctx, node } = fake("anakey", [paid, edgeRequest], { req12345: { id: "req12345", kind: "request", direction: "in" } });
    const all = await history(ctx);
    expect(all.map((m) => [m.id, m.twinOf ?? null, m.groupPay?.state ?? null])).toEqual([["gpay:req12345", null, "paid"], ["edge1:peer_req12345", "gpay:req12345", null]]);
    expect(all[0].groupPay).toMatchObject({ by: "anakey", claims: ["anakey"] });
    expect(node.getMessage).not.toHaveBeenCalled();
    const [newest] = await history(ctx, { limit: 1 });
    expect(newest).toMatchObject({ id: "edge1:peer_req12345", twinOf: "gpay:req12345" });
    expect(node.getMessage).toHaveBeenCalledWith("group:g1", "gpay:req12345");
  });

  it("marks no twin of a note this profile does not have, nor a payment line no note is about", async () => {
    const someoneElses = noteLine("anakey", { to: "bokey" });
    const { ctx } = fake("anakey", [someoneElses, edgeRequest], { req12345: { id: "req12345", kind: "request", direction: "in" } });
    // The note says another member asked: the requester's edge line is no twin of it (a note reusing its id).
    expect((await history(ctx)).map((m) => m.twinOf ?? null)).toEqual([null, null]);
    const { ctx: none } = fake("anakey", [edgeRequest], { req12345: { id: "req12345", kind: "request", direction: "in" } });
    expect((await history(none))[0].twinOf).toBeUndefined();
  });

  it("marks a payment that pays a member's request as its twin, never one whose request reuses another member's note's id", async () => {
    // Ana pays a request that came over an edge; the payment's line on her profile, and its record.
    const myPayment: StoredMessage = { linkId: "group:g1", id: "edge-x:me_4", text: "50 test sats", sender: "me", timestamp: 4, via: "datalink", paymentId: "pay1" };
    const paying = (edge: string) => ({ pay1: { id: "pay1", kind: "payment" as const, direction: "out" as const, requestId: "req12345", linkId: edge } });
    const twins = async (who: string, line: StoredMessage, payments: Record<string, Partial<PaymentView>>, fields: Partial<GroupPayNote> = {}) =>
      (await history(fake(who, [noteLine(who, fields), line], payments).ctx)).map((m) => m.twinOf ?? null);
    // The requester's own request, paid over the edge with them: said once.
    expect(await twins("anakey", myPayment, paying("edge-mekey"))).toEqual([null, "gpay:req12345"]);
    // Bo asked Ana under the id of the requester's note: Ana's payment to Bo is no twin of it, both lines show.
    expect(await twins("anakey", myPayment, paying("edge-bokey"))).toEqual([null, null]);
    // Nor of a request someone else was asked to pay, nor of a payment note.
    expect(await twins("anakey", myPayment, paying("edge-mekey"), { from: "bokey" })).toEqual([null, null]);
    expect(await twins("anakey", myPayment, paying("edge-mekey"), { kind: "payment", from: "anakey" })).toEqual([null, null]);
    // A payment that came in answering a request: the twin of my request only, not of a note of another member's.
    const paidMe: StoredMessage = { linkId: "group:g1", id: "edge-bokey:peer_5", text: "50 test sats", sender: "peer", member: "bokey", timestamp: 5, via: "datalink", paymentId: "pay2" };
    const came = { pay2: { id: "pay2", kind: "payment" as const, direction: "in" as const, requestId: "req12345", linkId: "edge-bokey" } };
    expect(await twins("mekey", paidMe, came)).toEqual([null, "gpay:req12345"]);
    expect(await twins("mekey", paidMe, came, { to: "anakey" })).toEqual([null, null]);
  });

  it("in listen's group events", async () => {
    const h = new EventHub(join(mkdtempSync(join(tmpdir(), "ghostly-group-pay-")), "events.jsonl"), () => 1000, "group-pay-events");
    await h.open();
    const events: GhostlyEvent[] = [];
    h.onEvent((e) => events.push(e));
    h.baseline({ links: [], groups: [groupOf("mekey")], settings: {}, transport: {}, payments: { req12345: { id: "req12345", kind: "request", direction: "out" } } } as unknown as EngineState,
      new Map([["group:g1", []]]));
    h.sink.post({ kind: "messages", linkId: "group:g1", messages: [noteLine("mekey"), ownRequest] });
    expect(events.map((e) => (e as { message?: MessageJson }).message).map((m) => [m?.id, m?.twinOf ?? null, m?.groupPay?.state ?? null]))
      .toEqual([["gpay:req12345", null, "open"], ["me_2", "gpay:req12345", null]]);
  });
});
