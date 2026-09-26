import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORES, openDb, store, transact, wrap } from "../src/shared/idb";
import { TEST_MINT } from "../src/shared/mints";
import type { CashuWallet } from "../src/engine/wallet";
import { GhostlyNode } from "../src/engine/node";
import { sealSeed, newDeviceKey } from "../src/engine/paymentAdapters/persistence";
import { CASHU_MINT_SOURCE, cashuMint } from "../src/engine/paymentAdapters/providers/cashuMint";
import type { LightningProviderDescriptor } from "../src/engine/paymentAdapters/providers/lightning";
import { CASHU_CARD, LEGACY_CARD, LightningCards, cardsKey, loadLightningCards } from "../src/engine/paymentAdapters/providers/lightningCards";
import type { LightningEvents, LightningOp } from "../src/engine/paymentAdapters/providers/lightningService";
import { LIGHTNING_PROVIDERS } from "../src/engine/paymentAdapters/providers/registry";
import { FakeLightningProvider, fakeInvoice, fakeLightning } from "../src/engine/paymentAdapters/providers/testing";
import { walletRemoval } from "../src/shared/walletRemoval";
// covers: wallet.lightning.cards, wallet.lightning.sources, wallet.instances.create

/**
 * Several Lightning cards on one network: each its own source, balance and journal; a payment goes through the card
 * picked; a request's invoice comes from the default for receiving; removing one card leaves the others; and the one
 * source a network had before becomes a card without moving a secret.
 */

const keys = async () => (await wrap((await store(STORES.settings, "readonly")).getAllKeys())).map(String).sort();
const read = async (key: string) => wrap((await store(STORES.settings, "readonly")).get(key));
const put = (key: string, value: unknown) => transact([STORES.settings], (s) => { s[STORES.settings].put(value, key); });
const journal = (op: LightningOp) => put(`lightningOp-${op.direction}-${op.paymentHash}`, op);
const hash = () => crypto.getRandomValues(new Uint8Array(32));

/** A fake node per name: its name is its only setting (nothing to seal), so tests stay fast. */
const nodes = new Map<string, FakeLightningProvider>();
const fakeNode: LightningProviderDescriptor = {
  ...fakeLightning, id: "fake-node", label: "Fake node", validate: undefined,
  fields: [{ name: "alias", label: "Name", kind: "text" }],
  create: async ({ config }) => {
    const node = nodes.get(config.alias);
    if (!node || node.closed) nodes.set(config.alias, new FakeLightningProvider({ alias: config.alias, settleMs: 600_000 }));
    return nodes.get(config.alias)!;
  },
};

let mints = true;
const registries: LightningCards[] = [];
function cards(network: "testnet" | "mainnet" = "testnet") {
  const events = { changed: vi.fn(), received: vi.fn(), resolved: vi.fn() } satisfies LightningEvents;
  const cashu = { view: async () => ({ balance: 7, mints: [], history: [], feesPaid: 0 }) } as unknown as CashuWallet;
  const registry = new LightningCards(network, { descriptors: () => [cashuMint, fakeNode], host: () => ({ platform: "web", cashu }), events, hasMints: () => mints });
  registries.push(registry);
  return { registry, events };
}

beforeEach(async () => {
  mints = true;
  nodes.clear();
  await openDb();
  await transact([STORES.settings, STORES.intents, STORES.payments], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); s[STORES.payments].clear(); });
});
afterEach(async () => { for (const r of registries.splice(0)) await r.stop(); vi.restoreAllMocks(); });

describe("the one source a network had becomes its first card", () => {
  const sealed = { iv: "aXY", salt: "c2FsdA", data: "b3BhcXVl" };
  // Every Lightning source a profile may hold today, as the older app stored it: its sealed secrets are never opened.
  it.each([
    ["nwc", "NWC", { relay: "" }],
    ["lnd", "LND", { url: "https://127.0.0.1:8080" }],
    ["core-lightning", "Core Lightning", { url: "ws://127.0.0.1:9737" }],
    ["breez", "Breez", {}],
    ["fedimint", "Fedimint", { federation: "fed-id" }],
    ["webln", "WebLN", {}],
  ])("%s: a card reading that same key, the default for receiving; nothing else written, twice or not", async (providerId, name, config) => {
    const source = { providerId, config, secrets: sealed, deviceKey: "device-key", savedAt: 1 };
    await put("lightningSource-testnet", source);
    await put("lightningSource-mainnet", { providerId: "lnd", config: {}, savedAt: 1 });
    const first = await loadLightningCards("testnet", (id) => id, 5);
    expect(first).toEqual({ cards: [{ id: LEGACY_CARD, name, providerId, createdAt: 5 }], receive: LEGACY_CARD });
    expect(await loadLightningCards("testnet", (id) => id, 9), "a second run changes nothing").toEqual(first);
    expect(await read("lightningSource-testnet"), "the source, byte for byte").toEqual(source);
    expect(await keys()).toEqual(["lightningCards-testnet", "lightningSource-mainnet", "lightningSource-testnet"]);

    // The card is that source: the real provider's form reads its settings, and its secrets are saved (not asked again).
    const descriptor = LIGHTNING_PROVIDERS.find((d) => d.id === providerId);
    if (!descriptor) return;
    const registry = new LightningCards("testnet", { descriptors: () => LIGHTNING_PROVIDERS, host: () => ({ platform: "desktop" }), events: { changed: vi.fn(), received: vi.fn(), resolved: vi.fn() }, hasMints: () => false });
    registries.push(registry);
    await registry.start();
    const [card] = registry.views();
    expect(card).toMatchObject({ card: LEGACY_CARD, providerId, config, receive: true });
    expect(card.secrets).toEqual(descriptor.fields.filter((f) => f.kind === "secret").map((f) => f.name));
  });

  it("no source saved: the Cashu mints' card, shown once the network has mints", async () => {
    mints = false;
    const { registry } = cards();
    await registry.start();
    expect(await read(cardsKey("testnet"))).toMatchObject({ cards: [{ id: CASHU_CARD, providerId: CASHU_MINT_SOURCE }], receive: CASHU_CARD });
    expect(registry.views()).toEqual([]);
    mints = true;
    expect(registry.views()).toMatchObject([{ card: CASHU_CARD, providerId: CASHU_MINT_SOURCE, receive: true }]);
  });

  it("a sealed source connects with its very secret, and its old journal is its own; the mints' operations stay the Cashu card's", async () => {
    const deviceKey = newDeviceKey();
    let seen: Record<string, string> | undefined;
    const secretNode: LightningProviderDescriptor = { ...fakeLightning, create: async ({ secrets }) => { seen = secrets; return new FakeLightningProvider({ settleMs: 600_000 }); } };
    await put("lightningSource-testnet", { providerId: "fake-lightning", config: {}, secrets: await sealSeed(JSON.stringify({ token: "the-old-token" }), deviceKey), deviceKey, savedAt: 1 });
    const mine = { direction: "out" as const, providerId: "fake-lightning", mode: "testnet" as const, paymentHash: "aa", invoice: "x", amount: 5, expiresAt: 0, createdAt: 2, state: "paid" as const };
    await journal(mine);
    await journal({ ...mine, providerId: CASHU_MINT_SOURCE, paymentHash: "bb", selfSettled: true });
    const registry = new LightningCards("testnet", { descriptors: () => [cashuMint, secretNode], host: () => ({ platform: "web" }), events: { changed: vi.fn(), received: vi.fn(), resolved: vi.fn() }, hasMints: () => true });
    registries.push(registry);
    await registry.start();
    await registry.ensureReady();
    expect(seen).toEqual({ token: "the-old-token" });
    expect(registry.card(LEGACY_CARD).view.recent.map((op) => op.paymentHash)).toEqual(["aa"]);
    expect(registry.owner({ ...mine, providerId: CASHU_MINT_SOURCE })).toBe(CASHU_CARD);
  });
});

describe("several cards on one network", () => {
  it("each connects first and keeps its own source and balance; the same wallet twice is refused; a failure saves nothing", async () => {
    const { registry } = cards();
    await registry.start();
    const home = await registry.add("fake-node", { alias: "Home" });
    const office = await registry.add("fake-node", { alias: "Office" });
    await registry.ensureReady();
    nodes.get("Home")!.balance = 1_000;
    await Promise.all(registry.all().map((s) => s.sources.refresh()));
    const views = registry.views();
    expect(views.map((v) => [v.card, v.name, v.receive])).toEqual([[CASHU_CARD, "Cashu", true], [home, "Home (Fake node)", false], [office, "Office (Fake node)", false]]);
    expect(views.find((v) => v.card === home)?.balance).toBe(1_000);
    expect(views.find((v) => v.card === office)?.balance).toBe(100_000);
    expect(await keys()).toEqual(expect.arrayContaining([`lightningSource-testnet-${home}`, `lightningSource-testnet-${office}`]));

    await expect(registry.add("fake-node", { alias: "Home" })).rejects.toThrow("That wallet is already your card “Home (Fake node)”");
    const failing: LightningProviderDescriptor = { ...fakeNode, create: async () => { throw new Error("connection refused"); } };
    vi.spyOn(fakeNode, "create").mockImplementation(failing.create);
    const before = await keys();
    await expect(registry.add("fake-node", { alias: "Down" })).rejects.toThrow("connection refused");
    expect(await keys(), "nothing half-made").toEqual(before);
    expect(registry.views()).toHaveLength(3);
  });

  it("names: the source's short name, a number when taken, renamable, unique", async () => {
    const { registry } = cards();
    await registry.start();
    const quiet = { ...fakeNode, create: async () => new FakeLightningProvider({ alias: "", settleMs: 600_000 }) };
    vi.spyOn(fakeNode, "create").mockImplementation(quiet.create);
    const a = await registry.add("fake-node", { alias: "a" });
    const b = await registry.add("fake-node", { alias: "b" });
    expect(registry.views().map((v) => v.name)).toEqual(["Cashu", "Fake Lightning (Fake node)", "Fake Lightning (Fake node) 2"]);
    await registry.rename(b, "  Home   LND ");
    expect(registry.views().find((v) => v.card === b)?.name).toBe("Home LND");
    await expect(registry.rename(a, "home lnd")).rejects.toThrow("Another card has that name");
    await expect(registry.rename(a, " ")).rejects.toThrow("Enter a name");
    await expect(registry.rename(a, "x".repeat(33))).rejects.toThrow("At most 32 characters");
  });

  it("the default for receiving: the first card shown, then the one set; a removed one hands it on; the last one gone brings the mints back", async () => {
    mints = false;
    const { registry } = cards();
    await registry.start();
    const home = await registry.add("fake-node", { alias: "Home" });
    expect(registry.receivingId, "the mints' card is not shown without mints").toBe(home);
    const office = await registry.add("fake-node", { alias: "Office" });
    expect(registry.receivingId).toBe(home);
    await registry.setReceive(office);
    expect(registry.views().filter((v) => v.receive).map((v) => v.card)).toEqual([office]);
    await expect(registry.setReceive("ln-gone")).rejects.toThrow("That Lightning card is gone");
    await registry.remove(office);
    expect(registry.receivingId).toBe(home);
    await registry.remove(home);
    expect(registry.has(CASHU_CARD)).toBe(true);
    mints = true;
    expect(registry.views()).toMatchObject([{ card: CASHU_CARD, receive: true }]);
  });
});

describe("a payment goes through the card picked", () => {
  it("invoices and quotes of each card go through its own source, journaled with the card; its history is its own", async () => {
    const { registry } = cards();
    await registry.start();
    const home = await registry.add("fake-node", { alias: "Home" });
    const office = await registry.add("fake-node", { alias: "Office" });
    await registry.setReceive(home);
    const got = await registry.card().createInvoice(21);
    expect(nodes.get("Home")!.invoices.has(got.paymentHash)).toBe(true);
    await registry.card(office).createInvoice(22);
    expect(nodes.get("Office")!.invoices.size).toBe(1);

    const invoice = fakeInvoice(50, hash());
    const quote = await registry.card(office).quote(invoice);
    expect(registry.withQuote(quote.quote)).toBe(registry.card(office));
    expect(await registry.withQuote(quote.quote)!.pay(quote.quote)).toBe(true);
    expect(nodes.get("Office")!.paid).toHaveLength(1);
    expect(nodes.get("Home")!.paid).toEqual([]);
    await registry.reconcile();
    const ops = await registry.list();
    expect(ops.map((op) => [op.direction, op.amount, op.card]).sort()).toEqual([["in", 21, home], ["in", 22, office], ["out", 50, office]]);
    expect(registry.card(home).view.recent.map((op) => op.amount)).toEqual([21]);
    expect(registry.card(office).view.recent.map((op) => op.amount).sort()).toEqual([22, 50]);
    // The same invoice is paid once, whichever card tries again.
    const again = await registry.card(home).quote(invoice);
    await expect(registry.card(home).pay(again.quote)).rejects.toThrow("This invoice is already paid");
    expect(() => registry.card("ln-gone")).toThrow("That Lightning card is gone");
  });

  it("a card is removed only once its payments ended; the others go on", async () => {
    const { registry } = cards();
    await registry.start();
    const home = await registry.add("fake-node", { alias: "Home" });
    const office = await registry.add("fake-node", { alias: "Office" });
    await journal({ direction: "out", providerId: "fake-node", mode: "testnet", card: home, paymentHash: "cc", invoice: "x", amount: 5, expiresAt: 0, createdAt: 1, state: "pending" });
    await expect(registry.remove(home)).rejects.toThrow("has not ended yet (1)");
    expect(registry.has(home)).toBe(true);
    await registry.remove(office);
    expect(registry.views().map((v) => v.card)).toEqual([CASHU_CARD, home]);
    expect((await keys()).filter((k) => k.includes(office))).toEqual([]);
  });

  it("a Mainnet card never takes a source on a test chain, nor pays a test invoice", async () => {
    const { registry } = cards("mainnet");
    await registry.start();
    await expect(registry.add("fake-node", { alias: "Home" })).rejects.toThrow();
    expect(registry.views()).toMatchObject([{ card: CASHU_CARD }]);
    await expect(registry.card().quote(fakeInvoice(5, hash()))).rejects.toThrow("pay it from a Testnet wallet");
  });
});

describe("the engine", () => {
  const engines: GhostlyNode[] = [];
  afterEach(async () => { for (const node of engines.splice(0)) await node.shutdown(); });
  async function engine() {
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false, providers: { lightning: [cashuMint, fakeNode], onchain: [] } });
    engines.push(node);
    vi.spyOn(node["wallet"], "view").mockImplementation(async (network) => ({ mints: network === "testnet" ? [{ url: TEST_MINT } as never] : [], balance: 0, history: [], feesPaid: 0 }));
    node["settings"].mints = [TEST_MINT];
    await Promise.all((["mainnet", "testnet"] as const).map((n) => node["lightnings"][n].start()));
    return node;
  }
  const lightningWallets = (node: GhostlyNode) => node.getState().wallet.wallets?.filter((w) => w.type === "lightning").map((w) => [w.id, w.name, w.receive]);

  it("New adds a card each time; pay with the card picked; receive with the default or the card picked; remove one", async () => {
    const node = await engine();
    const home = await node.walletCreate({ type: "lightning", network: "testnet", providerId: "fake-node", values: { alias: "Home" } });
    const office = await node.walletCreate({ type: "lightning", network: "testnet", providerId: "fake-node", values: { alias: "Office" } });
    expect(home.id).not.toBe(office.id);
    expect(lightningWallets(node)).toEqual([["lightning:testnet:cashu", "Cashu", true], [home.id, "Home (Fake node)", false], [office.id, "Office (Fake node)", false]]);
    expect(node.getState().wallet.offers?.find((o) => o.type === "lightning" && o.network === "testnet")).toMatchObject({ several: true, available: true });

    await node.lightningSetReceive({ network: "testnet", card: office.card! });
    expect(node.getState().wallet.networks?.testnet.lightning).toMatchObject({ card: office.card, providerId: "fake-node" });
    expect(await node.walletReceiveLightning({ amount: 10, network: "testnet" })).toMatchObject({ source: "fake-node" });
    expect(nodes.get("Office")!.invoices.size).toBe(1);
    await node.walletReceiveLightning({ amount: 11, network: "testnet", card: home.card });
    expect(nodes.get("Home")!.invoices.size).toBe(1);

    const quote = await node.walletQuoteInvoice({ invoice: fakeInvoice(40, hash()), network: "testnet", card: home.card });
    expect(await node.walletPayQuote({ quote: quote.quote, mint: quote.mint })).toEqual({ paid: true });
    expect(nodes.get("Home")!.paid).toHaveLength(1);
    expect(nodes.get("Office")!.paid).toEqual([]);

    await node.walletRemove({ type: "lightning", network: "testnet", card: office.card });
    expect(lightningWallets(node)).toEqual([["lightning:testnet:cashu", "Cashu", true], [home.id, "Home (Fake node)", false]]);
    // The mints' card goes alone next to another card; a network's only one comes with its Cashu wallet.
    expect(walletRemoval("lightning", "testnet", node.getState().wallet.networks?.testnet, [], CASHU_CARD).comesWith).toBeUndefined();
    await node.walletRemove({ type: "lightning", network: "testnet", card: CASHU_CARD });
    expect(lightningWallets(node)).toEqual([[home.id, "Home (Fake node)", true]]);
    await node.walletRemove({ type: "lightning", network: "testnet", card: home.card });
    expect(lightningWallets(node)).toEqual([["lightning:testnet:cashu", "Cashu", true]]);
    await expect(node.walletRemove({ type: "lightning", network: "testnet", card: CASHU_CARD })).rejects.toThrow("comes with your Testnet Cashu wallet");
  });

  it("a card of one network never pays for the other: its id is not the other's", async () => {
    const node = await engine();
    const home = await node.walletCreate({ type: "lightning", network: "testnet", providerId: "fake-node", values: { alias: "Home" } });
    await expect(node.walletQuoteInvoice({ invoice: fakeInvoice(5, hash()), network: "mainnet", card: home.card })).rejects.toThrow("That Lightning card is gone");
    expect(nodes.get("Home")!.paid).toEqual([]);
  });

  it("from before cards: a source set with no card names becomes the default for receiving; Back to the mints removes it", async () => {
    const node = await engine();
    await node.lightningSetSource({ providerId: "fake-node", values: { alias: "Home" }, network: "testnet" });
    const [, made] = node.getState().wallet.networks!.testnet.lightnings!;
    expect(made).toMatchObject({ providerId: "fake-node", receive: true });
    await node.lightningSetSource({ providerId: "fake-node", values: { alias: "Home" }, network: "testnet" });
    expect(node.getState().wallet.networks!.testnet.lightnings, "the same wallet is not added twice").toHaveLength(2);
    await expect(node.lightningSetSource({ providerId: CASHU_MINT_SOURCE, values: {}, network: "testnet", card: made.card })).rejects.toThrow("A card keeps its source");
    await node.lightningClearSource({ network: "testnet" });
    expect(node.getState().wallet.networks!.testnet.lightnings).toMatchObject([{ card: CASHU_CARD, receive: true }]);
  });
});
