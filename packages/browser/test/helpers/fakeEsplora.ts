import { sha256 } from "@noble/hashes/sha2.js";
import { Transaction } from "@scure/btc-signer";

/**
 * An Esplora server in memory, for the BDK provider's unit tests: a regtest chain of blocks, a mempool,
 * broadcasts that are checked against what is already spent, and the endpoints BDK and the provider read
 * (recorded against a real electrs; see e2e/support/bdk-regtest). Use it as `fetch`:
 *
 *   const esplora = new FakeEsplora(); vi.stubGlobal("fetch", esplora.fetch);
 *
 * `fund` pays an address from nowhere (a transaction whose input is made up) and mines it.
 */
const REGTEST_GENESIS = "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206";
const REGTEST = { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
const LOOSE = { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true, allowLegacyWitnessUtxo: true } as const;

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (h) => parseInt(h, 16));
const randomHash = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const scripthash = (script: string) => hex(sha256(unhex(script)));
/** btc-signer's `id` wants a finalized transaction; a made-up input never is. */
const txid = (tx: Transaction) => hex(sha256(sha256(tx.toBytes(true, false))).reverse());

interface Block { hash: string; height: number; time: number }
interface Output { script: string; value: number }
interface Input { txid: string; vout: number; scriptSig: string; witness: string[]; sequence: number }
interface Stored { txid: string; version: number; locktime: number; vin: Input[]; vout: Output[]; size: number; weight: number; block?: Block }

export type BroadcastFault = "none" | "offline" | "lost" | "reject" | "error";

export class FakeEsplora {
  readonly blocks: Block[] = [{ hash: REGTEST_GENESIS, height: 0, time: 1_296_688_602 }];
  readonly txs = new Map<string, Stored>();
  /** `txid:vout` → the txid spending it. */
  readonly spends = new Map<string, string>();
  readonly requests: string[] = [];
  broadcasts = 0;
  /**
   * offline: no answer at all; lost: accepted, then the answer is lost; reject: a 400 from the node;
   * error: a 503 before anything reached the node.
   */
  fault: BroadcastFault = "none";
  genesis = REGTEST_GENESIS;
  feeEstimates: Record<string, number> = {};

  constructor() { this.mine(100); }

  get tip() { return this.blocks[this.blocks.length - 1]; }

  mine(count = 1) {
    for (let i = 0; i < count; i++) {
      const block = { hash: randomHash(), height: this.tip.height + 1, time: this.tip.time + 600 };
      this.blocks.push(block);
      for (const tx of this.txs.values()) if (!tx.block) tx.block = block;
    }
  }

  /** Pays `sats` to `address` from nowhere, and mines it unless `confirm` is false. Returns the txid. */
  fund(address: string, sats: number, confirm = true): string {
    const tx = new Transaction({ ...LOOSE, version: 2 });
    tx.addInput({ txid: unhex(randomHash()), index: 0, sequence: 0xfffffffd });
    tx.addOutputAddress(address, BigInt(sats), REGTEST);
    const txid = this.accept(tx.toBytes(true, false));
    if (confirm) this.mine();
    return txid;
  }

  /** Spends the same coins as `txid` elsewhere (another wallet of the same keys, a fee bump): conflicts it. */
  conflict(txid: string) {
    const tx = this.txs.get(txid);
    if (!tx) throw new Error("unknown tx");
    for (const input of tx.vin) this.spends.set(`${input.txid}:${input.vout}`, randomHash());
    this.txs.delete(txid);
  }

  private accept(raw: Uint8Array): string {
    const tx = Transaction.fromRaw(raw, LOOSE);
    const vin: Input[] = [], vout: Output[] = [];
    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i);
      vin.push({ txid: hex(input.txid!), vout: input.index!, scriptSig: hex(input.finalScriptSig ?? new Uint8Array()), witness: (input.finalScriptWitness ?? []).map(hex), sequence: input.sequence ?? 0xffffffff });
    }
    for (let i = 0; i < tx.outputsLength; i++) { const output = tx.getOutput(i); vout.push({ script: hex(output.script!), value: Number(output.amount) }); }
    const id = txid(tx);
    this.txs.set(id, { txid: id, version: tx.version, locktime: tx.lockTime, vin, vout, size: raw.length, weight: tx.toBytes(true, false).length * 3 + raw.length });
    for (const input of vin) if (this.txs.has(input.txid)) this.spends.set(`${input.txid}:${input.vout}`, id);
    return id;
  }

  /** What `POST /tx` does: 400 for a spent or unknown input, the txid for a new or already known one. */
  private broadcast(body: string): { status: number; body: string } {
    this.broadcasts++;
    let tx: Transaction;
    try { tx = Transaction.fromRaw(unhex(body.trim()), LOOSE); } catch { return { status: 400, body: "sendrawtransaction RPC error: {\"code\":-22,\"message\":\"TX decode failed\"}" }; }
    if (this.txs.has(txid(tx))) return { status: 200, body: txid(tx) };
    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i), key = `${hex(input.txid!)}:${input.index}`;
      if (!this.txs.has(hex(input.txid!)) || this.spends.has(key)) return { status: 400, body: "sendrawtransaction RPC error: {\"code\":-25,\"message\":\"bad-txns-inputs-missingorspent\"}" };
    }
    return { status: 200, body: this.accept(unhex(body.trim())) };
  }

  private json(tx: Stored) {
    return {
      txid: tx.txid, version: tx.version, locktime: tx.locktime, size: tx.size, weight: tx.weight, fee: this.fee(tx),
      vin: tx.vin.map((input) => {
        const prev = this.txs.get(input.txid)?.vout[input.vout];
        return { txid: input.txid, vout: input.vout, prevout: prev ? { scriptpubkey: prev.script, value: prev.value } : null, scriptsig: input.scriptSig, witness: input.witness, is_coinbase: false, sequence: input.sequence };
      }),
      vout: tx.vout.map((output) => ({ scriptpubkey: output.script, value: output.value })),
      status: this.status(tx),
    };
  }
  private fee(tx: Stored) {
    const inputs = tx.vin.map((input) => this.txs.get(input.txid)?.vout[input.vout]?.value);
    return inputs.every((v) => v !== undefined) ? inputs.reduce((a, b) => a! + b!, 0)! - tx.vout.reduce((a, b) => a + b.value, 0) : 0;
  }
  private status(tx: Stored) {
    return tx.block ? { confirmed: true, block_height: tx.block.height, block_hash: tx.block.hash, block_time: tx.block.time } : { confirmed: false };
  }
  private summary(block: Block) {
    const previous = this.blocks[block.height - 1];
    return { id: block.hash, height: block.height, version: 0x20000000, timestamp: block.time, mediantime: block.time, tx_count: 1, size: 250, weight: 1000, merkle_root: "00".repeat(32), ...(previous ? { previousblockhash: previous.hash } : {}), nonce: 0, bits: 0x207fffff, difficulty: 0 };
  }

  private route(method: string, path: string, body: string): { status: number; body: string } {
    const ok = (value: unknown) => ({ status: 200, body: typeof value === "string" ? value : JSON.stringify(value) });
    const missing = { status: 404, body: "Transaction not found" };
    let m: RegExpExecArray | null;
    if (method === "POST" && path === "/tx") return this.broadcast(body);
    if (path === "/blocks/tip/height") return ok(String(this.tip.height));
    if (path === "/blocks/tip/hash") return ok(this.tip.hash);
    if (path === "/fee-estimates") return ok(this.feeEstimates);
    if ((m = /^\/block-height\/(\d+)$/.exec(path))) { const block = this.blocks[Number(m[1])]; return block ? ok(Number(m[1]) === 0 ? this.genesis : block.hash) : { status: 404, body: "Block not found" }; }
    if ((m = /^\/blocks(?:\/(\d+))?$/.exec(path))) { const from = m[1] ? Number(m[1]) : this.tip.height; return ok(this.blocks.slice(Math.max(0, from - 9), from + 1).reverse().map((b) => this.summary(b))); }
    if ((m = /^\/block\/([0-9a-f]{64})\/status$/.exec(path))) { const block = this.blocks.find((b) => b.hash === m![1]); return ok(block ? { in_best_chain: true, height: block.height, next_best: this.blocks[block.height + 1]?.hash ?? null } : { in_best_chain: false }); }
    if ((m = /^\/scripthash\/([0-9a-f]{64})\/txs(\/chain\/[0-9a-f]{64})?$/.exec(path))) {
      if (m[2]) return ok([]);
      const hash = m[1];
      const touching = [...this.txs.values()].filter((tx) => tx.vout.some((o) => scripthash(o.script) === hash) || tx.vin.some((i) => { const prev = this.txs.get(i.txid)?.vout[i.vout]; return prev && scripthash(prev.script) === hash; }));
      touching.sort((a, b) => (b.block?.height ?? Infinity) - (a.block?.height ?? Infinity));
      return ok(touching.map((tx) => this.json(tx)));
    }
    if ((m = /^\/tx\/([0-9a-f]{64})(\/status|\/hex|\/raw|\/outspends|\/outspend\/(\d+))?$/.exec(path))) {
      const [, txid, what, vout] = m;
      if (what?.startsWith("/outspend")) {
        const spent = (index: number) => { const by = this.spends.get(`${txid}:${index}`); return by ? { spent: true, txid: by, vin: 0, status: this.txs.get(by) ? this.status(this.txs.get(by)!) : { confirmed: false } } : { spent: false }; };
        if (vout !== undefined) return ok(spent(Number(vout)));
        const tx = this.txs.get(txid);
        return tx ? ok(tx.vout.map((_, i) => spent(i))) : missing;
      }
      const tx = this.txs.get(txid);
      if (!tx) return missing;
      if (what === "/status") return ok(this.status(tx));
      return ok(this.json(tx));
    }
    return { status: 404, body: `not in the fake: ${method} ${path}` };
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname.replace(/^\/api/, "");
    const body = request.method === "POST" ? await request.text() : "";
    this.requests.push(`${request.method} ${path}`);
    if (request.method === "POST" && path === "/tx") {
      if (this.fault === "offline") throw new TypeError("fetch failed");
      if (this.fault === "error") return new Response("upstream unavailable", { status: 503 });
      if (this.fault === "reject") return new Response("sendrawtransaction RPC error: {\"code\":-26,\"message\":\"min relay fee not met\"}", { status: 400 });
      if (this.fault === "lost") { this.route("POST", path, body); throw new TypeError("fetch failed"); }
    }
    const { status, body: text } = this.route(request.method, path, body);
    const response = new Response(text, { status, headers: { "content-type": text.startsWith("[") || text.startsWith("{") ? "application/json" : "text/plain" } });
    // BDK's HTTP client (reqwest) parses the response's URL, which a made-up Response does not have.
    Object.defineProperty(response, "url", { value: request.url });
    return response;
  };
}
