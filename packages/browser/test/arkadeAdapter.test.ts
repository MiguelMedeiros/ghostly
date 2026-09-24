import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentReview, PaymentTarget } from "@ghostly/core";
import { ArkadeAdapter, type ArkPrepared as Prepared } from "../src/engine/paymentAdapters/arkade";
import { PaymentCoordinator, type IntentRepository, type SavedIntent } from "../src/engine/paymentAdapters/coordinator";
// covers: payments.arkade.send, payments.arkade.request, payments.chat.reconcile, wallet.ark.send

/**
 * A scripted stand-in for the part of @arkade-os/sdk the adapter touches. Transactions are JSON inside base64
 * (the adapter only moves them around and reads amounts/scripts); an address is `<hrp>1<server x-only key><script>`.
 * One shared `ark` server holds pending (submitted, not finalized) transactions and the indexer's virtual outputs.
 */
const ark = vi.hoisted(() => {
  const enc = (value: unknown) => btoa(JSON.stringify(value));
  const bytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
  const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  interface Io { amount?: string; script?: string; leaf?: string }
  interface TxData { id: string; inputs: Io[]; outputs: Io[]; cosigned?: string; sigs?: number[] }
  class Transaction {
    constructor(readonly data: TxData) {}
    static fromPSBT(psbt: Uint8Array) { return new Transaction(JSON.parse(new TextDecoder().decode(psbt))); }
    get id() { return this.data.id; }
    get inputsLength() { return this.data.inputs.length; }
    get outputsLength() { return this.data.outputs.length; }
    getInput(i: number) {
      const input = this.data.inputs[i];
      return { witnessUtxo: input.amount === undefined ? undefined : { amount: BigInt(input.amount), script: bytes(input.script!) }, tapLeafScript: input.leaf ? [[{}, bytes(input.leaf)]] : undefined };
    }
    getOutput(i: number) { const out = this.data.outputs[i]; return { amount: out.amount === undefined ? undefined : BigInt(out.amount), script: out.script ? bytes(out.script) : undefined }; }
    toPSBT() { return new TextEncoder().encode(JSON.stringify(this.data)); }
    signed(index: number) { return new Transaction({ ...this.data, sigs: [...(this.data.sigs ?? []), index] }); }
  }
  const decodeAddress = (address: string) => {
    const match = /^(t?ark)1([a-f0-9]{64})([a-f0-9]{4,})$/.exec(address);
    if (!match) throw new Error("not an Ark address");
    return { hrp: match[1], serverPubKey: bytes(match[2]), pkScript: bytes(match[3]), subdustPkScript: bytes(match[3] + "dd") };
  };
  const server = {
    key: "a".repeat(64),
    info: { network: "signet", signerPubkey: "02" + "a".repeat(64) } as { network: string; signerPubkey: string },
    own: "5120" + "0e".repeat(32),
    balance: 100_000,
    fee: 3,
    counter: 0,
    submits: [] as string[],
    finalizes: [] as string[],
    pending: new Map<string, { tx: TxData; checkpoints: string[] }>(),
    vtxos: [] as Array<{ txid: string; value: number; script: string; createdAt: Date }>,
    /** Changes the transaction the SDK builds, as a misbehaving SDK or provider would. */
    tamper: undefined as undefined | ((tx: TxData) => void),
    sendError: undefined as Error | undefined,
    submitFails: false,
    finalizeFails: 0,
    respond: undefined as unknown as (tx: TxData, checkpoints: TxData[]) => { arkTxid: string; finalArkTx: string; signedCheckpointTxs: string[] },
    defaultRespond: (tx: TxData, checkpoints: TxData[]) => ({ arkTxid: tx.id, finalArkTx: enc({ ...tx, cosigned: server.key }), signedCheckpointTxs: checkpoints.map((c) => enc({ ...c, cosigned: server.key })) }),
    /** The SDK asks for pending transactions and finalizes them with these (server-signed) checkpoints. */
    recoveryTxid: undefined as string | undefined,
    contracts: [] as Array<{ script: string; type: string; metadata?: { signingDescriptor?: string }; params: { pubKey: string } }>,
    walletState: { settings: { hasPendingTx: false } } as { settings: Record<string, unknown> } | undefined,
    created: [] as Array<Record<string, unknown>>,
    identities: [] as Array<{ isMainnet: boolean }>,
    reset() {
      Object.assign(server, { info: { network: "signet", signerPubkey: "02" + "a".repeat(64) }, balance: 100_000, fee: 3, submits: [], finalizes: [], vtxos: [], tamper: undefined, sendError: undefined, submitFails: false, finalizeFails: 0, recoveryTxid: undefined, respond: server.defaultRespond, created: [], identities: [], walletState: { settings: { hasPendingTx: false } } });
      server.pending.clear();
      server.contracts = [{ script: server.own, type: "default", params: { pubKey: "11".repeat(32) } }];
    },
  };
  class RestArkProvider {
    constructor(readonly url: string) {}
    async getInfo() { return { ...server.info }; }
    async submitTx(signedTx: string, checkpoints: string[]) {
      const tx = JSON.parse(atob(signedTx)) as TxData;
      server.submits.push(tx.id);
      const locals = checkpoints.map((c) => JSON.parse(atob(c)) as TxData);
      const response = server.respond(tx, locals);
      server.pending.set(tx.id, { tx, checkpoints: response.signedCheckpointTxs });
      if (server.submitFails) throw new Error("connection reset");
      return response;
    }
    async finalizeTx(txid: string, checkpoints: string[]) {
      server.finalizes.push(txid);
      if (server.finalizeFails > 0) { server.finalizeFails--; throw new Error("gateway timeout"); }
      const pending = server.pending.get(txid);
      if (!pending) throw new Error("transaction already finalized");
      if (checkpoints.some((c) => !(JSON.parse(atob(c)) as TxData).sigs?.length && !(JSON.parse(atob(c)) as TxData).cosigned)) throw new Error("unsigned checkpoint");
      server.pending.delete(txid);
      pending.tx.outputs.forEach((out) => { if (out.script !== server.own) server.vtxos.push({ txid, value: Number(out.amount), script: out.script!, createdAt: new Date() }); });
    }
  }
  class RestIndexerProvider { constructor(readonly url: string) {} async getVtxos() { return { vtxos: server.vtxos.map((v) => ({ ...v })) }; } }
  class Wallet {
    constructor(readonly options: { arkProvider: RestArkProvider; settlementConfig: unknown; storage: Record<string, unknown> }) {}
    static async create(options: Wallet["options"]) { server.created.push(options as unknown as Record<string, unknown>); return new Wallet(options); }
    async getBalance() { return { available: server.balance, recoverable: undefined, boarding: { total: 7 } }; }
    async getAddress() { return `tark1${server.key}${server.own}`; }
    async send({ address, amount }: { address: string; amount: number }) {
      if (server.sendError) throw server.sendError;
      const destination = hexOf(decodeAddress(address).pkScript);
      const id = (++server.counter).toString(16).padStart(64, "0");
      const input = amount + server.fee + 1_000;
      const tx: TxData = { id, inputs: [{ amount: String(input), script: server.own, leaf: "c0ffee" + "c0" }], outputs: [{ amount: String(amount), script: destination }, { amount: "1000", script: server.own }] };
      server.tamper?.(tx);
      const checkpoint: TxData = { id: "cp" + id.slice(2), inputs: [{ amount: String(input), script: server.own, leaf: "beef" + "c0" }], outputs: [] };
      await new Promise((resolve) => setTimeout(resolve, 0)); // lets a concurrent operation run if nothing serializes them
      await this.options.arkProvider.submitTx(enc(tx), [enc(checkpoint)]);
    }
    async finalizePendingTxs() {
      for (const [txid, pending] of server.pending) if (!server.recoveryTxid || server.recoveryTxid === txid) await this.options.arkProvider.finalizeTx(txid, pending.checkpoints);
    }
    async getContractManager() { return { getContracts: async () => server.contracts }; }
    async signerForDescriptor(descriptor: string) { return { sign: async (tx: Transaction, [index]: number[]) => (descriptor === "good" ? tx.signed(index) : tx) }; }
    async dispose() {}
  }
  const MnemonicIdentity = {
    fromMnemonic: (_mnemonic: string, options: { isMainnet: boolean }) => {
      server.identities.push(options);
      return { xOnlyPublicKey: async () => bytes("11".repeat(32)), sign: async (tx: Transaction, [index]: number[]) => tx.signed(index) };
    },
  };
  class Repository {
    constructor(readonly name: string) {}
    async getWalletState() { return server.walletState && structuredClone(server.walletState); }
    async saveWalletState(state: { settings: Record<string, unknown> }) { server.walletState = state; }
  }
  const sdk = {
    Wallet, MnemonicIdentity, RestArkProvider, RestIndexerProvider, Transaction,
    EsploraProvider: class { constructor(readonly url: string) {} },
    IndexedDBWalletRepository: Repository, IndexedDBContractRepository: Repository,
    ArkAddress: { decode: decodeAddress },
    assertSubmittedArkTxid: (response: { arkTxid: string }, tx: Transaction) => { if (response.arkTxid !== tx.id) throw new Error("server answered for another transaction"); },
    matchServerCheckpoints: (signed: string[], locals: Transaction[]) => {
      if (signed.length !== locals.length) throw new Error("checkpoint count differs");
      return locals.map((local) => {
        const server = signed.map((s) => Transaction.fromPSBT(new TextEncoder().encode(atob(s)))).find((s) => s.id === local.id);
        if (!server) throw new Error("checkpoint does not match");
        return { server, local };
      });
    },
    assertAllowedSighashTypes: () => {},
    verifyTapscriptSignatures: (tx: Transaction, _index: number, keys: string[]) => { if (tx.data.cosigned !== keys[0]) throw new Error("not signed by the pinned server key"); },
  };
  return { server, sdk, enc, Transaction };
});
vi.mock("@arkade-os/sdk", () => ark.sdk);
vi.mock("@scure/btc-signer/payment.js", () => ({ tapLeafHash: () => new Uint8Array(32) }));

type Adapter = ArkadeAdapter;
const { server } = ark;
const PROVIDER = "https://ark.example", EXPLORER = "https://esplora.example";
const config = (over: object = {}) => ({ network: "signet" as const, provider: PROVIDER, explorer: EXPLORER, serverKey: "02" + server.key, walletId: "w1", ...over });
const bob = (script = "5120" + "b0".repeat(32), hrp = "tark", key = server.key) => `${hrp}1${key}${script}`;
const target = (over: Partial<PaymentTarget> = {}): PaymentTarget => ({ method: "arkade", network: "signet", provider: PROVIDER, asset: "BTC", unit: "sat", address: bob(), expiresAt: Date.now() + 60_000, ...over });
const review = (t: PaymentTarget, amount: number, fee: number, feeCap = 10): PaymentReview => ({ ...t, id: crypto.randomUUID(), payee: "Bob", amount, fee, feeCap, createdAt: Date.now(), state: "submitted" });
const connect = (over: object = {}) => ArkadeAdapter.connect(config(over), "abandon ".repeat(11) + "about", { walletRepository: new ark.sdk.IndexedDBWalletRepository("test") as never, contractRepository: new ark.sdk.IndexedDBContractRepository("test") as never });
async function prepared(adapter: Adapter, amount = 2_000, feeCap = 10) {
  const t = target(), { fee, prepared } = await adapter.prepare(t, amount, feeCap);
  return { t, fee, prepared, review: review(t, amount, fee, feeCap) };
}
beforeEach(() => server.reset());

describe("connecting an Ark wallet", () => {
  it("refuses an unknown network, a plain-HTTP provider, and a server whose network or signing key changed", async () => {
    await expect(connect({ network: "testnet" })).rejects.toThrow("Unsupported Ark network");
    await expect(connect({ provider: "http://ark.example" })).rejects.toThrow("HTTPS");
    server.info = { network: "regtest", signerPubkey: "02" + server.key };
    await expect(connect()).rejects.toThrow("network or signing key changed");
    server.info = { network: "signet", signerPubkey: "02" + "b".repeat(64) };
    await expect(connect()).rejects.toThrow("network or signing key changed");
  });
  it("derives mainnet keys only on bitcoin, and lets the SDK renew outputs everywhere but regtest", async () => {
    await connect();
    server.info = { network: "bitcoin", signerPubkey: "02" + server.key };
    await connect({ network: "bitcoin" });
    server.info = { network: "regtest", signerPubkey: "02" + server.key };
    await ArkadeAdapter.connect(config({ network: "regtest", walletId: "fresh" }), "abandon ".repeat(11) + "about");
    expect(server.identities).toEqual([{ isMainnet: false }, { isMainnet: true }, { isMainnet: false }]);
    expect(server.created.map((c) => c.settlementConfig)).toEqual([{ boardingUtxoSweep: true }, { boardingUtxoSweep: true }, false]);
    expect((server.created[2].storage as { walletRepository: { name: string } }).walletRepository.name, "each profile keeps its own Ark database").toBe("ghostly-ark-fresh");
  });
});

describe("preparing an Ark payment (the review)", () => {
  it("builds and checks the transaction but sends nothing to the server", async () => {
    const adapter = await connect();
    const { fee, prepared: p } = await prepared(adapter);
    expect(fee).toBe(3);
    expect(p).toMatchObject({ address: bob(), amount: 2_000, fee: 3, txid: "1".padStart(64, "0") });
    expect(server.submits, "nothing leaves at review").toEqual([]);
  });
  it("refuses a request for another method, network or provider, or an address of another server or network", async () => {
    const adapter = await connect();
    await expect(adapter.prepare(target({ provider: "https://other.example" }), 100, 10)).rejects.toThrow("does not match this wallet");
    await expect(adapter.prepare(target({ network: "mutinynet" }), 100, 10)).rejects.toThrow("does not match this wallet");
    await expect(adapter.prepare(target({ method: "bark" }), 100, 10)).rejects.toThrow("does not match this wallet");
    await expect(adapter.prepare(target({ address: bob(undefined, "tark", "c".repeat(64)) }), 100, 10)).rejects.toThrow("another provider or network");
    await expect(adapter.prepare(target({ address: bob(undefined, "ark") }), 100, 10)).rejects.toThrow("another provider or network");
    await expect(adapter.prepare(target(), 1.5, 10)).rejects.toThrow("whole amount");
    expect(server.submits).toEqual([]);
  });
  it("refuses when the server changed, funds are short, or the SDK fails, without echoing the SDK's error", async () => {
    const adapter = await connect();
    server.info = { network: "signet", signerPubkey: "03" + "d".repeat(64) };
    await expect(adapter.prepare(target(), 100, 10)).rejects.toThrow("configuration changed");
    server.reset();
    server.balance = 50;
    await expect(adapter.prepare(target(), 100, 10)).rejects.toThrow("Insufficient");
    server.reset();
    server.sendError = new Error("psbt cHNidP8BAH0CAAAAAb signed secret material");
    const error = await adapter.prepare(target(), 100, 10).catch((e: Error) => e);
    expect(error.message).toBe("Could not prepare this Ark payment. Check funds, address and provider.");
  });
  it("refuses a fee above the cap, a transaction that pays another amount, or one with an input of unknown value", async () => {
    const adapter = await connect();
    server.fee = 11;
    await expect(adapter.prepare(target(), 2_000, 10)).rejects.toThrow("does not match your review");
    server.fee = 3;
    server.tamper = (tx) => { tx.outputs[0].amount = "1999"; };
    await expect(adapter.prepare(target(), 2_000, 10)).rejects.toThrow("does not match your review");
    server.tamper = (tx) => { tx.outputs[0].script = "5120" + "ee".repeat(32); tx.outputs[1].amount = String(Number(tx.outputs[1].amount) + 2_000); };
    await expect(adapter.prepare(target(), 2_000, 10), "paying someone else").rejects.toThrow("does not match your review");
    server.tamper = (tx) => { delete tx.inputs[0].amount; };
    await expect(adapter.prepare(target(), 2_000, 10)).rejects.toThrow("Missing Ark input amount");
    server.tamper = (tx) => { tx.outputs[0].amount = "1000"; tx.outputs.push({ amount: "1000", script: tx.outputs[0].script!.replace(/$/, "dd") }); tx.outputs[1].amount = "1000"; };
    await expect(adapter.prepare(target(), 2_000, 10), "a sub-dust output to the same payee counts").resolves.toMatchObject({ fee: 3 });
  });
  it("two reviews at once each get their own transaction", async () => {
    const adapter = await connect();
    const [a, b] = await Promise.all([adapter.prepare(target(), 1_000, 10), adapter.prepare(target({ address: bob("5120" + "c1".repeat(32)) }), 2_000, 10)]);
    expect([a.prepared.amount, b.prepared.amount]).toEqual([1_000, 2_000]);
    expect(a.prepared.txid).not.toBe(b.prepared.txid);
    const outputOf = (p: Prepared) => (JSON.parse(atob(p.signedTx)) as { outputs: Array<{ amount: string }> }).outputs[0].amount;
    expect([outputOf(a.prepared), outputOf(b.prepared)]).toEqual(["1000", "2000"]);
  });
});

describe("executing an approved Ark payment", () => {
  it("submits once, writes the signed checkpoints down, then finalizes", async () => {
    const adapter = await connect();
    const { prepared: p, review: r } = await prepared(adapter);
    const persist = vi.fn(async () => {
      expect(p.finalCheckpoints, "what finalizes is in the journal first").toHaveLength(1);
      expect(server.finalizes, "journal before finalization").toEqual([]);
    });
    await expect(adapter.execute(r, p, persist)).resolves.toEqual({ txid: p.txid, settled: true });
    expect(persist).toHaveBeenCalledOnce();
    expect([server.submits, server.finalizes]).toEqual([[p.txid], [p.txid]]);
    expect(JSON.parse(atob(p.finalCheckpoints![0])).sigs, "our signature is on the server-signed checkpoint").toEqual([0]);
    expect(await adapter.verifyReceipt(p.txid, p.address, p.amount)).toBe(true);
  });
  it("refuses, before anything leaves, a review that no longer matches what was prepared", async () => {
    const adapter = await connect();
    const { prepared: p, review: r } = await prepared(adapter);
    await expect(adapter.execute({ ...r, amount: 2_001 }, p)).rejects.toThrow("does not match the approved review");
    await expect(adapter.execute({ ...r, feeCap: 2 }, p)).rejects.toThrow("does not match the approved review");
    await expect(adapter.execute(r, { ...p, txid: "f".repeat(64) })).rejects.toThrow("does not match the approved review");
    await expect(adapter.execute(r, { ...p, address: bob("5120" + "c1".repeat(32)) })).rejects.toThrow("does not match the approved review");
    await expect(adapter.execute({ ...r, provider: "https://other.example" }, p)).rejects.toThrow("does not match this wallet");
    server.info = { network: "signet", signerPubkey: "02" + "d".repeat(64) };
    await expect(adapter.execute(r, p)).rejects.toThrow("configuration changed");
    expect(server.submits).toEqual([]);
  });
  it("does not finalize when the server answers for another transaction or without its pinned key's signature", async () => {
    const adapter = await connect();
    const persist = vi.fn();
    const answer = (change: (tx: Parameters<typeof server.defaultRespond>[0], cps: Parameters<typeof server.defaultRespond>[1]) => object) => { server.respond = (tx, cps) => ({ ...server.defaultRespond(tx, cps), ...change(tx, cps) }); };
    answer(() => ({ arkTxid: "e".repeat(64) }));
    const wrongTxid = await prepared(adapter);
    await expect(adapter.execute(wrongTxid.review, wrongTxid.prepared, persist)).rejects.toThrow("another transaction");
    answer(() => ({ finalArkTx: "" }));
    const noFinal = await prepared(adapter);
    await expect(adapter.execute(noFinal.review, noFinal.prepared, persist)).rejects.toThrow("no signed transaction");
    answer((tx) => ({ finalArkTx: ark.enc({ ...tx, cosigned: "d".repeat(64) }) }));
    const forged = await prepared(adapter);
    await expect(adapter.execute(forged.review, forged.prepared, persist)).rejects.toThrow("pinned server key");
    answer((_tx, cps) => ({ signedCheckpointTxs: cps.map((c) => ark.enc({ ...c, cosigned: "d".repeat(64) })) }));
    const forgedCheckpoint = await prepared(adapter);
    await expect(adapter.execute(forgedCheckpoint.review, forgedCheckpoint.prepared, persist)).rejects.toThrow("pinned server key");
    expect(persist).not.toHaveBeenCalled();
    expect(server.finalizes).toEqual([]);
  });
  it("signs a checkpoint only for an output this wallet profile owns, with its descriptor or its own key", async () => {
    const adapter = await connect();
    server.contracts = [];
    const notOurs = await prepared(adapter);
    await expect(adapter.execute(notOurs.review, notOurs.prepared)).rejects.toThrow("not owned by this wallet profile");
    server.contracts = [{ script: server.own, type: "default", params: { pubKey: "22".repeat(32) } }];
    const noSigner = await prepared(adapter);
    await expect(adapter.execute(noSigner.review, noSigner.prepared)).rejects.toThrow("descriptor missing");
    server.contracts = [{ script: server.own, type: "default", metadata: { signingDescriptor: "good" }, params: { pubKey: "22".repeat(32) } }];
    const described = await prepared(adapter);
    await expect(adapter.execute(described.review, described.prepared, async () => {})).resolves.toMatchObject({ settled: true });
    expect(server.finalizes).toEqual([described.prepared.txid]);
  });
});

describe("reconciling an Ark payment whose outcome is unknown", () => {
  it("a payment the indexer already shows is settled without touching the wallet", async () => {
    const adapter = await connect();
    const { prepared: p, review: r } = await prepared(adapter);
    await adapter.execute(r, p, async () => {});
    server.walletState = undefined;
    await expect(adapter.reconcile(r, p)).resolves.toEqual({ txid: p.txid, settled: true });
    expect(server.submits).toHaveLength(1);
  });
  it("a lost submit answer is finished through the SDK's pending recovery, for the approved transaction only", async () => {
    const adapter = await connect();
    const { prepared: p, review: r } = await prepared(adapter);
    server.submitFails = true;
    await expect(adapter.execute(r, p, async () => {})).rejects.toThrow("connection reset");
    expect(p.finalCheckpoints).toBeUndefined();
    const persist = vi.fn(async () => { expect(server.finalizes, "journal before finalization").toEqual([]); });
    await expect(adapter.reconcile(r, p, persist)).resolves.toEqual({ txid: p.txid, settled: true });
    expect(server.walletState?.settings.hasPendingTx, "the SDK is told to look for the pending transaction").toBe(true);
    expect(persist).toHaveBeenCalledOnce();
    expect(p.finalCheckpoints).toHaveLength(1);
    expect(server.submits, "never submitted a second time").toHaveLength(1);
  });
  it("the SDK's recovery cannot finalize a different, unapproved transaction, nor after the reconcile ended", async () => {
    const adapter = await connect();
    const approved = await prepared(adapter);
    const other = await prepared(adapter);
    server.submitFails = true;
    await adapter.execute(other.review, other.prepared, async () => {}).catch(() => {});
    server.submitFails = false;
    server.recoveryTxid = other.prepared.txid;
    const bare = { ...approved.prepared };
    await expect(adapter.reconcile(approved.review, bare)).rejects.toThrow("cannot finalize an unapproved payment");
    expect(server.finalizes).toEqual([]);
    server.recoveryTxid = undefined;
    const wallet = (adapter as unknown as { wallet: { finalizePendingTxs(): Promise<void> } }).wallet;
    await expect(wallet.finalizePendingTxs(), "outside a reconcile nothing is authorized").rejects.toThrow("unapproved payment");
  });
  it("without the wallet's saved state it stops instead of guessing", async () => {
    const adapter = await connect();
    const { prepared: p, review: r } = await prepared(adapter);
    server.walletState = undefined;
    await expect(adapter.reconcile(r, p)).rejects.toThrow("wallet state is unavailable");
  });
  it("resumes the same finalization after a lost finalize answer, and a repeated one is harmless", async () => {
    const adapter = await connect();
    const { prepared: p, review: r } = await prepared(adapter);
    server.finalizeFails = 1;
    await expect(adapter.execute(r, p, async () => {})).rejects.toThrow("gateway timeout");
    expect(await adapter.reconcile(r, p)).toEqual({ txid: p.txid, settled: true });
    expect(await adapter.reconcile(r, p), "a finalized transaction rejects finalization again; the receipt decides").toEqual({ txid: p.txid, settled: true });
    expect(server.submits).toHaveLength(1);
  });
  it("stays unsettled while the server keeps failing, and refuses a review that does not match", async () => {
    const adapter = await connect();
    const { prepared: p, review: r } = await prepared(adapter);
    server.finalizeFails = 5;
    await adapter.execute(r, p, async () => {}).catch(() => {});
    expect(await adapter.reconcile(r, p)).toEqual({ txid: p.txid, settled: false });
    await expect(adapter.reconcile({ ...r, amount: 1 }, p)).rejects.toThrow("does not match the approved review");
  });
});

describe("seeing Ark payments to this wallet", () => {
  const since = Date.UTC(2026, 0, 1, 12);
  const vtxo = (over: object = {}) => ({ txid: "a".repeat(64), value: 1_000, script: "5120" + "b0".repeat(32), createdAt: new Date(since), ...over });
  it("finds a new output paying the address, skipping claimed, older, smaller or foreign ones", async () => {
    const adapter = await connect();
    server.vtxos = [
      vtxo({ txid: "1".repeat(64) }),
      vtxo({ txid: "2".repeat(64), createdAt: new Date(since - 61_000) }),
      vtxo({ txid: "3".repeat(64), value: 999 }),
      vtxo({ txid: "4".repeat(64), script: "5120" + "ee".repeat(32) }),
      vtxo({ txid: "not-a-txid" }),
    ];
    expect(await adapter.received(bob(), 1_000, since, new Set(["1".repeat(64)]))).toBeUndefined();
    server.vtxos.push(vtxo({ txid: "5".repeat(64), createdAt: new Date(since - 30_000), script: "5120" + "b0".repeat(32) + "dd" }));
    expect(await adapter.received(bob(), 1_000, since, new Set(["1".repeat(64)])), "a little clock skew and the sub-dust script are fine").toBe("5".repeat(64));
  });
  it("accepts a receipt only for the exact amount to the address", async () => {
    const adapter = await connect();
    server.vtxos = [vtxo()];
    expect(await adapter.verifyReceipt("a".repeat(64), bob(), 1_000)).toBe(true);
    expect(await adapter.verifyReceipt("a".repeat(64), bob(), 999)).toBe(false);
    expect(await adapter.verifyReceipt("a".repeat(64), bob("5120" + "c1".repeat(32)), 1_000)).toBe(false);
    expect(await adapter.verifyReceipt("b".repeat(64), bob(), 1_000)).toBe(false);
    expect(await adapter.verifyReceipt("A".repeat(64), bob(), 1_000)).toBe(false);
  });
});

describe("the coordinator with the Ark adapter", () => {
  function repository() {
    const records = new Map<string, SavedIntent>();
    const repo: IntentRepository = {
      get: async (id) => structuredClone(records.get(id)), list: async () => structuredClone([...records.values()]),
      put: async (v) => { records.set(v.review.id, structuredClone(v)); },
      cancel: async (id) => { const v = records.get(id)!; v.review.state = "cancelled"; return structuredClone(v); },
      claim: async (id) => { const v = records.get(id); if (!v || v.review.state !== "pending") throw new Error("already submitted"); v.review.state = "submitted"; return structuredClone(v); },
    };
    return { repo, records };
  }
  it("approve, lost answer, restart, reconcile: settled with one submission", async () => {
    const { repo, records } = repository();
    const coordinator = new PaymentCoordinator(repo, [await connect()]);
    const r = await coordinator.prepare(target(), 2_000, 10, { payee: "Bob", requestId: "req", linkId: "chat" });
    server.finalizeFails = 1;
    expect(await coordinator.approve(r.id)).toMatchObject({ state: "unknown" });
    expect((records.get(r.id)!.prepared as Prepared).finalCheckpoints, "the journal holds what to finalize").toHaveLength(1);
    const restarted = new PaymentCoordinator(repo, [await connect()]);
    await expect(restarted.approve(r.id)).rejects.toThrow("cannot be submitted again");
    expect(await restarted.reconcile(r.id)).toMatchObject({ state: "settled", txid: records.get(r.id)!.review.txid });
    expect(server.submits).toHaveLength(1);
  });
  it("a review the server no longer matches is never submitted, and reconciling it sends nothing", async () => {
    const { repo } = repository();
    const coordinator = new PaymentCoordinator(repo, [await connect()]);
    const r = await coordinator.prepare(target(), 2_000, 10, { payee: "Bob" });
    server.info = { network: "signet", signerPubkey: "02" + "d".repeat(64) };
    expect((await coordinator.approve(r.id)).state).not.toBe("settled");
    server.info = { network: "signet", signerPubkey: "02" + server.key };
    expect((await coordinator.reconcile(r.id)).state).toBe("unknown");
    expect([server.submits, server.finalizes]).toEqual([[], []]);
  });
});
