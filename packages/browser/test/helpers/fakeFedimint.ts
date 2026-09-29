import { randomBytes } from "@ghostly/core";
import type { FederationInfo, FedimintClient, FedimintOperation, FedimintSdk, PayOutcome, ReceiveState, RedeemState, SpendState } from "../../src/engine/paymentAdapters/fedimintSdk";
import { fakeInvoice } from "../../src/engine/paymentAdapters/providers/testing";

const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Federations and their clients, in memory, shaped on the web SDK as fedimintSdk.ts narrows it (checked against
 * a real regtest federation, e2e/support/fedimint-regtest): notes are a bearer string only their federation
 * redeems, once; taking them back fails once they were redeemed; an invoice of a client of the same federation is
 * paid internally (no gateway fee). The real client needs a worker and OPFS, which Node has neither of.
 */
interface Note { federation: string; amountMsats: number; spent: boolean; operation: string; owner: FakeClient }
interface Invoice { federation: string; amountMsats: number; operation: string; owner: FakeClient; state: ReceiveState }

export class FakeFederation {
  readonly id = toHex(randomBytes(32));
  readonly notes = new Map<string, Note>();
  readonly invoices = new Map<string, Invoice>();
  /** What the gateway charges, msats. Undefined: no gateway online. */
  gatewayFeeMsats: number | undefined = 1_000;
  /** Joins by mnemonic: joining fresh twice with one mnemonic is what the real client must never do. */
  readonly joined = new Map<string, number>();
  /** Recoveries give back what a mnemonic held (the federation's backup of it). */
  readonly backups = new Map<string, number>();
  /** What a joined client says of it, over what the preview said (a real client's can come back with no meta yet). */
  joinedInfo: Partial<Omit<FederationInfo, "federationId">> = {};
  constructor(readonly info: Omit<FederationInfo, "federationId">) {}
  /** Bech32 characters only, as a real invite code (fed1…). */
  get invite() { return `fed11${[...this.id.slice(0, 40)].map((c) => "qpzry9x8gf2tvdw0"["0123456789abcdef".indexOf(c)]).join("")}qqqq`; }
  /** Someone pays one of its invoices from outside (over Lightning, through the gateway). */
  payInvoice(invoice: string) {
    const found = this.invoices.get(invoice);
    if (!found || found.state !== "open") throw new Error("no such open invoice");
    found.state = "claimed"; found.owner.balanceMsats += found.amountMsats; found.owner.changed();
  }
}

class FakeClient implements FedimintClient {
  balanceMsats = 0;
  closed = false;
  readonly ops = new Map<string, FedimintOperation & { state: string; internal?: boolean }>();
  private listeners = new Set<(msats: number) => void>();
  constructor(private readonly sdk: FakeFedimintSdk, readonly federation: FakeFederation, readonly mnemonic: string) {}
  get federationId() { return this.federation.id; }
  private op(kind: string, variant: string, amountMsats: number | undefined, ghostly: string, state: string, extra: Partial<FedimintOperation> = {}) {
    const id = toHex(randomBytes(32));
    this.ops.set(id, { id, kind, variant, amountMsats, ghostly, state, outcome: undefined, createdAt: Date.now(), ...extra });
    return id;
  }
  changed() { for (const l of this.listeners) l(this.balanceMsats); this.sdk.backup(this); }
  async info(): Promise<FederationInfo> { return { federationId: this.federation.id, ...this.federation.info, ...this.federation.joinedInfo }; }
  async balance() { this.check(); return this.balanceMsats; }
  onBalance(listener: (msats: number) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async parseNotes(notes: string) {
    const note = this.sdk.findNote(notes);
    if (!note) throw new Error("invalid notes");
    return { amountMsats: note.amountMsats, federationIdPrefix: note.federation.slice(0, 8) };
  }
  async spend(amountMsats: number, { ghostly }: { cancelAfterSecs: number; ghostly: string }) {
    this.check();
    if (this.sdk.failNextSpend) { this.sdk.failNextSpend = false; throw new Error("the federation did not answer"); }
    if (this.balanceMsats < amountMsats) throw new Error(`Insufficient balance: requested ${amountMsats} msat but only ${this.balanceMsats} msat available`);
    this.balanceMsats -= amountMsats;
    const operation = this.op("mint", "spend_o_o_b", amountMsats, ghostly, "created");
    const notes = `fakenotes${this.federation.id.slice(0, 8)}${toHex(randomBytes(16))}`;
    this.federation.notes.set(notes, { federation: this.federation.id, amountMsats, spent: false, operation, owner: this });
    this.sdk.spent++;
    this.changed();
    return { notes, operationId: operation };
  }
  async cancelSpend(operationId: string) {
    const entry = [...this.federation.notes.values()].find((n) => n.operation === operationId && n.owner === this);
    const op = this.ops.get(operationId);
    if (!entry || !op) throw new Error("unknown operation");
    if (entry.spent) { op.state = "taken"; op.outcome = "UserCanceledFailure"; return; }
    entry.spent = true; this.balanceMsats += entry.amountMsats; op.state = "canceled"; op.outcome = "UserCanceledSuccess"; this.changed();
  }
  async spendState(operationId: string): Promise<SpendState | undefined> { return this.ops.get(operationId)?.state as SpendState | undefined; }
  async redeem(notes: string, ghostly: string) {
    this.check();
    const note = this.federation.notes.get(notes.trim());
    const operation = this.op("mint", "reissuance", note?.amountMsats, ghostly, "created");
    const op = this.ops.get(operation)!;
    if (!note || note.spent) { op.state = "failed"; op.outcome = { Failed: "spent" }; }
    else if (!this.sdk.holdRedeems) {
      note.spent = true; this.balanceMsats += note.amountMsats - this.sdk.redeemFeeMsats; op.state = "done"; op.outcome = "Done";
      const spender = note.owner.ops.get(note.operation); if (spender && spender.state === "created") spender.state = "taken";
      this.changed();
    }
    return operation;
  }
  async redeemState(operationId: string): Promise<RedeemState | undefined> { return this.ops.get(operationId)?.state as RedeemState | undefined; }
  async createInvoice(amountMsats: number, _description: string, _expirySecs: number, ghostly: string) {
    this.check();
    if (this.federation.gatewayFeeMsats === undefined) throw new Error("No gateway available");
    const invoice = fakeInvoice(amountMsats / 1000, randomBytes(32));
    const operation = this.op("ln", "receive", undefined, ghostly, "open", { invoice });
    this.federation.invoices.set(invoice, { federation: this.federation.id, amountMsats, operation, owner: this, state: "open" });
    return { operationId: operation, invoice };
  }
  async receiveState(operationId: string): Promise<ReceiveState | undefined> {
    const invoice = [...this.federation.invoices.values()].find((i) => i.operation === operationId && i.owner === this);
    return invoice?.state;
  }
  async gatewayFee(amountMsats: number) { return this.federation.gatewayFeeMsats === undefined ? undefined : this.federation.gatewayFeeMsats + Math.ceil(amountMsats / 1000); }
  async payInvoice(invoice: string, ghostly: string) {
    this.check();
    const internal = this.federation.invoices.get(invoice);
    const amountMsats = internal?.amountMsats ?? this.sdk.external.get(invoice);
    if (amountMsats === undefined) throw new Error("invalid invoice");
    const fee = internal ? 0 : (await this.gatewayFee(amountMsats))!;
    if (this.balanceMsats < amountMsats + fee) throw new Error(`Insufficient balance: requested ${amountMsats + fee} msat`);
    this.balanceMsats -= amountMsats + fee;
    const operation = this.op("ln", "pay", undefined, ghostly, this.sdk.holdPayments ? "pending" : "paid", { invoice, feeMsats: fee, internal: !!internal });
    if (internal && !this.sdk.holdPayments) { internal.state = "claimed"; internal.owner.balanceMsats += amountMsats; }
    if (!internal && !this.sdk.holdPayments) this.sdk.paidOut.push(invoice);
    this.changed();
    return { operationId: operation, feeMsats: fee, internal: !!internal };
  }
  async payState(operationId: string): Promise<PayOutcome> {
    const op = this.ops.get(operationId);
    return op?.state === "paid" ? { state: "paid", preimage: "00".repeat(32) } : op?.state === "failed" ? { state: "failed" } : { state: "pending" };
  }
  async operations(limit: number) {
    const receive = (id: string) => [...this.federation.invoices.values()].find((i) => i.operation === id)?.state;
    return [...this.ops.values()].reverse().slice(0, limit).map(({ state: _s, internal: _i, ...op }) => ({ ...op,
      outcome: op.outcome ?? (op.variant === "receive" ? receive(op.id) : op.kind === "ln" ? (_s === "paid" ? "success" : _s) : undefined) }));
  }
  async close() { this.closed = true; this.listeners.clear(); }
  private check() { if (this.closed) throw new Error("closed"); }
}

export class FakeFedimintSdk {
  readonly federations = new Map<string, FakeFederation>();
  readonly databases = new Map<string, { federation: FakeFederation; mnemonic: string }>();
  readonly clients: FakeClient[] = [];
  readonly removed: string[] = [];
  /** Invoices of the outside world (not of any federation): invoice → msats. */
  readonly external = new Map<string, number>();
  readonly paidOut: string[] = [];
  spent = 0;
  failNextSpend = false;
  holdRedeems = false;
  holdPayments = false;
  redeemFeeMsats = 0;
  unreachable = false;

  federation(info: Partial<Omit<FederationInfo, "federationId">> = {}): FakeFederation {
    const f = new FakeFederation({ name: "Test federation", guardians: [{ name: "g0", url: "ws://127.0.0.1:1" }], consensusVersion: "2.1", network: "regtest", modules: ["ln", "meta", "mint", "wallet"], ...info });
    this.federations.set(f.invite, f);
    return f;
  }
  findNote(notes: string) { for (const f of this.federations.values()) { const n = f.notes.get(notes.trim()); if (n) return n; } return undefined; }
  backup(client: FakeClient) { client.federation.backups.set(client.mnemonic, client.balanceMsats); }
  /** A client of this federation opened by the wallet (the latest one). */
  client(federation: FakeFederation) { return [...this.clients].reverse().find((c) => c.federation === federation && !c.closed)!; }

  sdk(): () => Promise<FedimintSdk> {
    const find = (invite: string) => { const f = this.federations.get(invite.trim()); if (!f) throw new Error("Could not join the federation: invalid invite code"); return f; };
    const sdk: FedimintSdk = {
      preview: async (invite) => { if (this.unreachable) throw new Error("guardians did not answer"); const f = find(invite); return { federationId: f.id, ...f.info }; },
      join: async ({ database, mnemonic, invite, recover }) => {
        if (this.unreachable) throw new Error("guardians did not answer");
        const f = find(invite);
        if (this.databases.has(database)) throw new Error("database exists");
        if (!recover && f.joined.get(mnemonic)) throw new Error("joined fresh twice with one mnemonic: its keys collide");
        f.joined.set(mnemonic, (f.joined.get(mnemonic) ?? 0) + 1);
        this.databases.set(database, { federation: f, mnemonic });
        const client = new FakeClient(this, f, mnemonic);
        if (recover) client.balanceMsats = f.backups.get(mnemonic) ?? 0;
        this.clients.push(client);
        return client;
      },
      open: async ({ database, mnemonic }) => {
        if (this.unreachable) throw new Error("guardians did not answer");
        const saved = this.databases.get(database);
        if (!saved) throw new Error("no such database");
        if (saved.mnemonic !== mnemonic) throw new Error("another mnemonic");
        const client = new FakeClient(this, saved.federation, mnemonic);
        const previous = [...this.clients].reverse().find((c) => c.federation === saved.federation && c.mnemonic === mnemonic);
        client.balanceMsats = previous?.balanceMsats ?? 0;
        for (const [id, op] of previous?.ops ?? []) client.ops.set(id, op);
        for (const n of saved.federation.notes.values()) if (n.owner === previous) n.owner = client;
        for (const i of saved.federation.invoices.values()) if (i.owner === previous) i.owner = client;
        this.clients.push(client);
        return client;
      },
      remove: async (database) => { this.removed.push(database); this.databases.delete(database); },
      exists: async (database) => this.databases.has(database),
    };
    return async () => sdk;
  }
}
