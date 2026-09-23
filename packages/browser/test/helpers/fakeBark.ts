/**
 * An in-memory stand-in for Second's Bark SDK, shaped like what the real one does on regtest: addresses
 * belong to one server, Arkade addresses do not parse, a send records a `send` movement on the payer and
 * a `receive` movement (with the address it arrived on) on the payee.
 */
import type { BarkMovement, BarkOpen, BarkSdk, BarkWalletHandle } from "../../src/engine/paymentAdapters/barkSdk";

const NETWORK = { bitcoin: "Bitcoin", signet: "Signet", regtest: "Regtest" } as const;
const vtxo = (n: number) => `${n.toString(16).padStart(64, "0")}:0`;

export class FakeBarkServer {
  readonly wallets = new Map<string, FakeBarkWallet>();
  sent = 0;
  vtxos = 0;
  /** What the next send does: go out and then throw (a lost answer), or throw before anything leaves. */
  nextSend?: "throw-after" | "throw-before";
  fee = 0;
  /** The server does not answer at all. */
  down = false;
  constructor(public key = "02" + "ab".repeat(32), public network: keyof typeof NETWORK = "signet", readonly tag = "srv") {}
  sdk(): BarkSdk {
    return {
      open: async (params: BarkOpen) => {
        // Like the SDK, opening leaves its database behind (when this test has IndexedDB at all).
        if (typeof indexedDB !== "undefined") await new Promise<void>((resolve) => { const request = indexedDB.open(params.database); request.onsuccess = () => { request.result.close(); resolve(); }; request.onerror = () => resolve(); });
        let wallet = this.wallets.get(params.database);
        if (!wallet) this.wallets.set(params.database, wallet = new FakeBarkWallet(this, params));
        wallet.freed = false; wallet.connected = false;
        return { wallet, onchain: { newAddress: async () => `tb1q${params.database.slice(-8)}`, balance: async () => ({ confirmedSats: wallet!.onchain, pendingSats: 0, totalSats: wallet!.onchain }), sync: async () => 0, initialScan: async () => 0, free: () => {} } };
      },
      isArkAddress: (address) => address.startsWith("tark1p") || address.startsWith("ark1p"),
    };
  }
  owner(address: string) { return [...this.wallets.values()].find((w) => w.addresses.includes(address)); }
}

export class FakeBarkWallet implements BarkWalletHandle {
  addresses: string[] = [];
  movements: BarkMovement[] = [];
  spendable = 0;
  onchain = 0;
  freed = false;
  constructor(private server: FakeBarkServer, readonly params: BarkOpen) {}
  private address(index: number) {
    while (this.addresses.length <= index) this.addresses.push(`tark1p${this.server.tag}${this.params.database.slice(-6)}x${this.addresses.length}`);
    return this.addresses[index];
  }
  /** Like the real SDK, a wallet opened again has not reached its server yet: empty until asked to refresh. */
  connected = false;
  async arkInfo() { return this.connected ? { network: NETWORK[this.server.network], serverPubkey: this.server.key } : undefined; }
  async refreshServer() { this.connected = !this.server.down; }
  async balance() { return { spendableSats: this.spendable, pendingInRoundSats: 0, pendingExitSats: 0, pendingLightningSendSats: 0, claimableLightningReceiveSats: 0, pendingBoardSats: 0 }; }
  async peekAddress(index: number) { if (index >= this.addresses.length) throw new Error(`VTXO key ${index} does not exist, please derive it first`); return this.addresses[index]; }
  async newAddressWithIndex() { const index = this.addresses.length; return { address: this.address(index), index }; }
  async validateArkoorAddress(address: string) {
    if (address.startsWith("tark1q")) throw new Error("invalid ark address: address is an Arkade address and cannot be used here");
    return address.startsWith(`tark1p${this.server.tag}`);
  }
  async estimateArkoorPaymentFee() { return { feeSats: this.server.fee }; }
  private record(m: Omit<BarkMovement, "id" | "status" | "createdAt" | "offchainFeeSats" | "sentToAddresses" | "receivedOnAddresses" | "outputVtxoIds"> & Partial<BarkMovement>) {
    this.movements.unshift({ id: this.movements.length + 1, status: "successful", createdAt: new Date().toISOString(), offchainFeeSats: 0, sentToAddresses: [], receivedOnAddresses: [], outputVtxoIds: [vtxo(++this.server.vtxos)], ...m });
  }
  /** Money in from outside (a faucet, another wallet not in this server's map). */
  fund(sats: number, index = 0) { this.spendable += sats; this.record({ subsystemKind: "receive", intendedBalanceSats: sats, effectiveBalanceSats: sats, receivedOnAddresses: [JSON.stringify({ type: "ark", value: this.address(index) })] }); }
  async sendArkoorPayment(address: string, amount: number) {
    if (this.server.nextSend === "throw-before") { this.server.nextSend = undefined; throw new Error("connection reset"); }
    if (amount + this.server.fee > this.spendable) throw new Error("Insufficient money available");
    this.server.sent++;
    this.spendable -= amount + this.server.fee;
    this.record({ subsystemKind: "send", intendedBalanceSats: -amount, effectiveBalanceSats: -amount - this.server.fee, offchainFeeSats: this.server.fee, sentToAddresses: [JSON.stringify({ type: "ark", value: address })] });
    const payee = this.server.owner(address);
    if (payee) { payee.spendable += amount; payee.record({ subsystemKind: "receive", intendedBalanceSats: amount, effectiveBalanceSats: amount, receivedOnAddresses: [JSON.stringify({ type: "ark", value: address })] }); }
    if (this.server.nextSend === "throw-after") { this.server.nextSend = undefined; throw new Error("deadline exceeded"); }
  }
  async history() { return this.movements.map((m) => ({ ...m })); }
  async sync() {}
  async maintenance() {}
  async boardAll() { const amountSats = this.onchain; this.onchain = 0; this.spendable += amountSats; return { amountSats, txid: "b".repeat(64) }; }
  async stopDaemonWait() {}
  free() { this.freed = true; }
}
