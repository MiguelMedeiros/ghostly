import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Wallet, createBlindSignature, createNewMintKeys, hashToCurve, pointFromHex, serializeMintKeys, verifyUnblindedSignature, type Proof } from "@cashu/cashu-ts";
import { createIdentity, type GroupSession, type Payment } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { CashuWallet } from "../src/engine/wallet";
import { fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { TEST_MINT } from "../src/shared/mints";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import type { StoredLink, StoredProof, StoredQuote, WalletAwaitingView } from "../src/shared/types";
// covers: payments.cashu.reclaim

/**
 * Ecash sent in a chat that the contact never takes, and the chat deleted: the engine keeps the payment so it can be
 * taken back, but its bubble (the only Take it back) went with the chat. The Wallet page's view says which ecash sent
 * lost its chat, so the page offers it back. Real cashu-ts in front of an in-memory Testnet mint (BDHKE, real keys).
 */
const MINT = TEST_MINT;
const json = { "content-type": "application/json" };
const answer = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: json });
const refuse = (code: number, detail: string) => new Response(JSON.stringify({ code, detail }), { status: 400, headers: json });

interface Output { id: string; amount: number; B_: string }

function fakeMint() {
  const made = createNewMintKeys(8, undefined, { versionByte: 0 });
  const keyset = { id: made.keysetId, keys: serializeMintKeys(made.pubKeys), secret: made.privKeys };
  const spent = new Set<string>();
  const signed = new Map<string, { id: string; amount: number; C_: string }>();
  const quotes = new Map<string, { amount: number; state: string }>();
  const Y = (secret: string) => hashToCurve(new TextEncoder().encode(secret)).toHex(true);
  const total = (items: { amount: number | string }[]) => items.reduce((sum, item) => sum + Number(item.amount), 0);
  const sign = (outputs: Output[]) => outputs.map((output) => {
    const { C_ } = createBlindSignature(pointFromHex(output.B_), keyset.secret[String(output.amount)], output.id);
    const signature = { id: output.id, amount: Number(output.amount), C_: C_.toHex(true) };
    signed.set(output.B_, signature);
    return signature;
  });
  const inputsRefusal = (inputs: Proof[]) => {
    for (const input of inputs) {
      const key = keyset.secret[String(input.amount)];
      if (input.id !== keyset.id || !key || !verifyUnblindedSignature({ secret: new TextEncoder().encode(input.secret), C: pointFromHex(input.C) } as never, key)) return refuse(10003, "Proof could not be verified");
      if (spent.has(Y(input.secret))) return refuse(11001, "Token already spent");
    }
    return undefined;
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== new URL(MINT).origin) return new Response("offline", { status: 503 });
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/v1/info") {
      const bolt11 = { methods: [{ method: "bolt11", unit: "sat", min_amount: 1, max_amount: 1_000_000 }], disabled: false };
      return answer({ name: "Fake", version: "cdk-mintd/0.18.0", nuts: { 4: bolt11, 5: bolt11, 7: { supported: true }, 8: { supported: true }, 9: { supported: true } } });
    }
    if (path === "/v1/keysets") return answer({ keysets: [{ id: keyset.id, unit: "sat", active: true, input_fee_ppk: 0 }] });
    if (path === "/v1/keys" || path === `/v1/keys/${keyset.id}`) return answer({ keysets: [{ id: keyset.id, unit: "sat", keys: keyset.keys }] });
    if (path.startsWith("/v1/mint/quote/bolt11/")) {
      const id = path.slice("/v1/mint/quote/bolt11/".length);
      const quote = quotes.get(id)!;
      return answer({ quote: id, request: fakeInvoice(quote.amount, new Uint8Array(32).fill(1)), amount: quote.amount, unit: "sat", state: quote.state, expiry: null });
    }
    if (path === "/v1/mint/bolt11") {
      const quote = quotes.get(body.quote)!;
      if (quote.state !== "PAID") return refuse(20002, "Quote not paid");
      quote.state = "ISSUED";
      return answer({ signatures: sign(body.outputs) });
    }
    if (path === "/v1/swap") {
      const refused = inputsRefusal(body.inputs);
      if (refused) return refused;
      if (total(body.inputs) !== total(body.outputs)) return refuse(11002, "Transaction is not balanced");
      for (const p of body.inputs as Proof[]) spent.add(Y(p.secret));
      return answer({ signatures: sign(body.outputs) });
    }
    if (path === "/v1/checkstate") return answer({ states: (body.Ys as string[]).map((y) => ({ Y: y, state: spent.has(y) ? "SPENT" : "UNSPENT", witness: null })) });
    if (path === "/v1/restore") {
      const found = (body.outputs as Output[]).filter((o) => signed.has(o.B_));
      return answer({ outputs: found, signatures: found.map((o) => signed.get(o.B_)!) });
    }
    return new Response("not found", { status: 404 });
  }));
  return { paid: (quote: string, amount: number) => quotes.set(quote, { amount, state: "PAID" }) };
}

const balance = async () => (await wrap<StoredProof[]>((await store(STORES.proofs, "readonly")).getAll())).filter((p) => !p.reserved).reduce((sum, p) => sum + p.amount, 0);

/**
 * A connected contact who never takes the ecash: what goes out is kept, nothing comes back. `as`: the chat's row as it
 * is stored (the same invite joined again, or a group member's edge), else a new 1:1 chat.
 */
function addChat(node: GhostlyNode, frames: Payment[], as?: StoredLink): StoredLink {
  const link = {
    requirePaymentSupport: vi.fn(async () => {}), allowsPayment: vi.fn(() => true), paymentEnabled: vi.fn(() => true),
    isDataLinkOpen: true, supportsPayments: true,
    sendPayment: vi.fn(async (payment: Payment) => { frames.push(payment); }),
    sendPaymentRequest: vi.fn(async () => {}), sendPaymentAsk: vi.fn(async () => {}), sendPaymentResult: vi.fn(),
    stop: vi.fn(async () => {}), depart: vi.fn(),
    // A group member's edge: no group frame goes over it here.
    supportsGroupVersion: vi.fn(() => false),
  };
  const row: StoredLink = as ?? { id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64 };
  node["links"].set(row.id, { stored: row, myPubKeyZ32: "me", link: link as never, status: "online", dataLink: "open",
    presence: { online: true, lastPacketAt: 0, services: null }, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
    poll: { polling: false, nextAt: 0, interval: 0 }, files: { receivedBytes: 0, wireIds: new Set(), incoming: new Map() } });
  return row;
}

const nodes: GhostlyNode[] = [];
async function engine() {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() }, { automaticWallets: false });
  nodes.push(node);
  node["settings"].mints = [MINT];
  // As at the end of a start: the chats are loaded.
  node["transfersRestored"] = true;
  await node["refreshWallet"]();
  return node;
}
/** What the Wallet page reads of the Testnet wallets: the ecash sent, not taken yet. */
const sent = (node: GhostlyNode): WalletAwaitingView[] => (node.getState().wallet.networks?.testnet.awaiting ?? []).filter((a) => a.kind === "sent");

beforeEach(async () => {
  await transact([STORES.proofs, STORES.payments, STORES.walletTx, STORES.swaps, STORES.melts, STORES.quotes, STORES.settings, STORES.intents], (s) => { for (const name of Object.keys(s)) s[name].clear(); });
  const mint = fakeMint();
  // 100 test sats in the wallet.
  mint.paid("q0", 100);
  const quote: StoredQuote = { quote: "q0", mint: MINT, amount: 100, invoice: "lnbc", createdAt: Date.now(), expiresAt: null };
  await transact([STORES.quotes], (s) => { s[STORES.quotes].put(quote); });
  const funding = new CashuWallet(() => [MINT], { onChange: vi.fn(), onTestMintNeeded: vi.fn(), onQuotePaid: vi.fn(), onMeltResolved: vi.fn(), onSwapSettled: vi.fn() });
  await funding.checkQuotes([MINT]);
  await funding.stop();
  expect(await balance()).toBe(100);
});
afterEach(async () => {
  for (const node of nodes.splice(0)) await node.shutdown();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ecash sent in a chat deleted before the contact took it", () => {
  it("is offered back on the Wallet page once its chat is gone, and taking it back brings the sats back", async () => {
    const node = await engine();
    const frames: Payment[] = [];
    const chat = addChat(node, frames);
    const { paymentId } = await node.sendPayment({ linkId: chat.id, amount: 13, timestamp: 1_000, network: "testnet" });
    expect(frames).toHaveLength(1);
    expect(await balance()).toBe(87);
    // While its chat is there, its bubble offers it back: the Wallet page does not list it a second time.
    await vi.waitFor(() => expect(sent(node)).toEqual([{ type: "cashu", kind: "sent", amount: 13, paymentId }]));

    node.removeLink({ linkId: chat.id });
    // Kept, with its ecash, as before: and now the Wallet page is told its chat is gone.
    await vi.waitFor(() => expect(sent(node)).toEqual([{ type: "cashu", kind: "sent", amount: 13, paymentId, chatGone: true }]));
    expect(node.getState().payments[paymentId]).toMatchObject({ state: "pending", linkId: chat.id });

    // Take it back, as the Wallet page does: the sats are back, and it leaves the list.
    await node.reclaimPayment({ paymentId });
    expect(await balance()).toBe(100);
    expect(node.getState().payments[paymentId]).toMatchObject({ state: "reclaimed" });
    await vi.waitFor(() => expect(sent(node)).toEqual([]));
  });

  it("leaves the list once the contact took it after all: Take it back finds it spent, and the sats stay theirs", async () => {
    const node = await engine();
    const frames: Payment[] = [];
    const chat = addChat(node, frames);
    const { paymentId } = await node.sendPayment({ linkId: chat.id, amount: 21, timestamp: 2_000, network: "testnet" });
    node.removeLink({ linkId: chat.id });
    await vi.waitFor(() => expect(sent(node)).toEqual([expect.objectContaining({ paymentId, chatGone: true })]));
    // The contact redeems the token they had.
    const theirs = new Wallet(MINT);
    await theirs.loadMint();
    await theirs.receive(frames[0]!.endpoint[1]);

    await node.reclaimPayment({ paymentId });
    expect(node.getState().payments[paymentId]).toMatchObject({ state: "settled" });
    expect(await balance()).toBe(79);
    await vi.waitFor(() => expect(sent(node)).toEqual([]));
  });

  it("says nothing of a chat gone until the chats are loaded: at a start, every chat is missing for a moment", async () => {
    const node = await engine();
    node["transfersRestored"] = false;
    const chat = addChat(node, []);
    const { paymentId } = await node.sendPayment({ linkId: chat.id, amount: 5, timestamp: 3_000, network: "testnet" });
    node["links"].delete(chat.id);
    await node["refreshWallet"]();
    expect(sent(node)).toEqual([{ type: "cashu", kind: "sent", amount: 5, paymentId }]);
    node["transfersRestored"] = true;
    await node["refreshWallet"]();
    expect(sent(node)).toEqual([{ type: "cashu", kind: "sent", amount: 5, paymentId, chatGone: true }]);
  });

  it("is offered back when the same invite is joined again: the chat has the same id, and not the payment's bubble", async () => {
    const node = await engine();
    const frames: Payment[] = [];
    const chat = addChat(node, frames);
    const { paymentId } = await node.sendPayment({ linkId: chat.id, amount: 8, timestamp: 4_000, network: "testnet" });
    node.removeLink({ linkId: chat.id });
    await vi.waitFor(() => expect(sent(node)).toEqual([expect.objectContaining({ paymentId, chatGone: true })]));
    await vi.waitFor(async () => expect(await db.getMessage(chat.id, "me_4000")).toBeUndefined());

    // Joined again: a chat under the same id, whose history began anew.
    addChat(node, frames, chat);
    await node["refreshWallet"]();
    expect(sent(node)).toEqual([{ type: "cashu", kind: "sent", amount: 8, paymentId, chatGone: true }]);

    // Its line comes back (the payment goes out again once the chat is live, `PaymentDesk.replay`): its bubble offers it.
    await node["storeMessage"]({ linkId: chat.id, id: "me_4000", text: "⚡ 8 test sats", sender: "me", timestamp: 4_000, via: "datalink", paymentId });
    await vi.waitFor(() => expect(sent(node)).toEqual([{ type: "cashu", kind: "sent", amount: 8, paymentId }]));
  });

  it("is not offered as of a deleted chat when a group member leaves: the payment's bubble is still in the group", async () => {
    const node = await engine();
    const { groupId } = await node.createGroup({ name: "Ghosts", profile: "mesh" });
    const session = (node["groups"] as unknown as { sessions: Map<string, GroupSession> }).sessions.get(groupId)!;
    const member = createIdentity().pubKeyZ32;
    await session.admit(member);
    const edgeOf = () => [...node["links"].values()].find((live) => live.stored.group === groupId && live.stored.groupPeer === member && !live.stored.groupEntry)?.stored;
    await vi.waitFor(() => expect(edgeOf()).toBeDefined(), { timeout: 10_000 });
    // The edge to that member, able to carry a payment, as a live one is.
    const edge = addChat(node, [], edgeOf()!);
    const { paymentId } = await node.sendPayment({ linkId: edge.id, amount: 3, timestamp: 5_000, network: "testnet" });
    // Its bubble is in the group's history.
    await vi.waitFor(async () => expect(await db.getMessage(`group:${groupId}`, `${edge.id}:me_5000`)).toMatchObject({ paymentId }));
    await node["refreshWallet"]();
    expect(sent(node)).toEqual([{ type: "cashu", kind: "sent", amount: 3, paymentId }]);

    // The member leaves: their edge closes here, the group and its history stay.
    await node["closeGroupLink"](edge.id);
    expect(node["links"].has(edge.id)).toBe(false);
    await node["refreshWallet"]();
    expect(sent(node)).toEqual([{ type: "cashu", kind: "sent", amount: 3, paymentId }]);

    // The group deleted here: its history, and the bubble, go. (Its goodbye to the others is not what is looked at: an
    // admin is refused it with nobody online to take over.)
    vi.spyOn(node["groups"], "leave").mockResolvedValue();
    await node.forgetGroup({ groupId });
    await vi.waitFor(() => expect(sent(node)).toEqual([{ type: "cashu", kind: "sent", amount: 3, paymentId, chatGone: true }]));
  });
});
