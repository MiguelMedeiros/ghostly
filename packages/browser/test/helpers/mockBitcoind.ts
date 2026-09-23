import { secp256k1 } from "@noble/curves/secp256k1.js";
import { base64, hex } from "@scure/base";
import { Transaction, p2wpkh } from "@scure/btc-signer";
import type { BitcoindCall, BitcoindRpcFailure, BitcoindTransport } from "../../src/engine/paymentAdapters/providers/bitcoind";

/**
 * A Bitcoin Core wallet in memory, answering the JSON-RPC methods the Bitcoin Core source uses the way
 * bitcoind does (same shapes, same error codes). It builds, signs and finalizes real PSBTs with keys
 * made for the test, so what the source parses and checks is a real transaction. Regtest only, no money.
 *
 * `failNext(method, failure)` makes the next call to a method fail like the Tauri command would.
 */
export const REGTEST = { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
const TX_OPTS = { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true };

interface Utxo { txid: string; vout: number; amount: bigint; script: Uint8Array; confirmations: number; mine: boolean }
interface WalletTx { txid: string; hex?: string; confirmations: number; entries: { category: "send" | "receive"; amount: number; fee?: number }[]; inMempool: boolean }

const btc = (sats: bigint | number) => Number(sats) / 1e8;
const rpcError = (code: number, message: string): BitcoindRpcFailure => ({ kind: "rpc", code, message });
const key = (txid: string, vout: number) => `${txid}:${vout}`;

export class MockBitcoind {
  chain = "regtest";
  privateKeys = true;
  readonly calls: BitcoindCall[] = [];
  readonly utxos = new Map<string, Utxo>();
  readonly locked = new Set<string>();
  readonly txs = new Map<string, WalletTx>();
  private readonly keys = new Map<string, Uint8Array>(); // output script (hex) → private key
  private readonly failures = new Map<string, BitcoindRpcFailure | Error>();
  /** Run sendrawtransaction, then fail as if the answer was lost. */
  loseNextBroadcastAnswer = false;

  failNext(method: string, failure: BitcoindRpcFailure | Error) { this.failures.set(method, failure); }

  /** A fresh address of this wallet. */
  newAddress() {
    const priv = secp256k1.utils.randomSecretKey();
    const payment = p2wpkh(secp256k1.getPublicKey(priv, true), REGTEST);
    this.keys.set(hex.encode(payment.script), priv);
    return payment.address!;
  }

  /** Someone pays this wallet `sats`, confirmed. */
  fund(sats: number) {
    const txid = hex.encode(crypto.getRandomValues(new Uint8Array(32)));
    const address = this.newAddress();
    this.utxos.set(key(txid, 0), { txid, vout: 0, amount: BigInt(sats), script: addressScript(address), confirmations: 1, mine: false });
    this.txs.set(txid, { txid, confirmations: 1, inMempool: false, entries: [{ category: "receive", amount: btc(sats) }] });
  }

  /** A block: whatever is in the mempool confirms. */
  mine() {
    for (const tx of this.txs.values()) { if (tx.confirmations > 0 || tx.inMempool) { tx.confirmations++; tx.inMempool = false; } }
    for (const utxo of this.utxos.values()) utxo.confirmations++;
  }

  /** The mempool forgets a transaction (evicted, or the node restarted). */
  drop(txid: string) { const tx = this.txs.get(txid); if (tx) tx.inMempool = false; }

  readonly transport: BitcoindTransport = async (call) => {
    this.calls.push(call);
    const failure = this.failures.get(call.method);
    if (failure) { this.failures.delete(call.method); throw failure; }
    const result = this.answer(call.method, call.params);
    if (call.method === "sendrawtransaction" && this.loseNextBroadcastAnswer) { this.loseNextBroadcastAnswer = false; throw { kind: "transport", message: "The node timed out" } satisfies BitcoindRpcFailure; }
    return result;
  };

  private spendable() { return [...this.utxos.values()].filter((u) => (u.confirmations > 0 || u.mine) && !this.locked.has(key(u.txid, u.vout))); }

  private answer(method: string, params: unknown[]): unknown {
    switch (method) {
      case "getblockchaininfo": return { chain: this.chain, blocks: 101 };
      case "getwalletinfo": return { walletname: "mock", private_keys_enabled: this.privateKeys };
      case "getnewaddress": return this.newAddress();
      case "estimatesmartfee": return { errors: ["Insufficient data or no feerate found"], blocks: 0 };
      case "getbalances": {
        let trusted = 0n, pending = 0n;
        for (const u of this.utxos.values()) if (u.confirmations > 0 || u.mine) trusted += u.amount; else pending += u.amount;
        return { mine: { trusted: btc(trusted), untrusted_pending: btc(pending), immature: 0 } };
      }
      case "walletcreatefundedpsbt": {
        const [, outputs, , options] = params as [unknown, Record<string, string>[], number, { fee_rate: number; lockUnspents?: boolean }];
        const [[address, amountBtc]] = Object.entries(outputs[0]);
        const amount = BigInt(Math.round(Number(amountBtc) * 1e8));
        const tx = new Transaction(TX_OPTS);
        let total = 0n;
        const chosen: Utxo[] = [];
        let fee = 0n;
        for (const utxo of this.spendable()) {
          chosen.push(utxo); total += utxo.amount;
          fee = BigInt(Math.ceil(options.fee_rate * (11 + 68 * chosen.length + 31 * 2)));
          if (total >= amount + fee) break;
        }
        if (total < amount + fee) throw rpcError(-4, "Insufficient funds");
        for (const u of chosen) tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: u.script, amount: u.amount }, sequence: 0xfffffffd });
        tx.addOutputAddress(address, amount, REGTEST);
        const change = total - amount - fee;
        if (change > 546n) tx.addOutputAddress(this.newAddress(), change, REGTEST);
        if (options.lockUnspents) for (const u of chosen) this.locked.add(key(u.txid, u.vout));
        return { psbt: base64.encode(tx.toPSBT()), fee: btc(total - amount - (change > 546n ? change : 0n)), changepos: change > 546n ? 1 : -1 };
      }
      case "walletprocesspsbt": {
        const tx = Transaction.fromPSBT(base64.decode(params[0] as string), TX_OPTS);
        let complete = this.privateKeys;
        for (let i = 0; i < tx.inputsLength; i++) {
          const priv = this.keys.get(hex.encode(tx.getInput(i).witnessUtxo!.script));
          if (priv && this.privateKeys) tx.signIdx(priv, i); else complete = false;
        }
        return { psbt: base64.encode(tx.toPSBT()), complete };
      }
      case "finalizepsbt": {
        const tx = Transaction.fromPSBT(base64.decode(params[0] as string), TX_OPTS);
        tx.finalize();
        return params[1] === false ? { psbt: base64.encode(tx.toPSBT()), complete: true } : { hex: hex.encode(tx.extract()), complete: true };
      }
      case "sendrawtransaction": {
        let tx: Transaction;
        try { tx = Transaction.fromRaw(hex.decode(params[0] as string), TX_OPTS); } catch { throw rpcError(-22, "TX decode failed"); }
        const known = this.txs.get(tx.id);
        if (known?.confirmations) throw rpcError(-27, "Transaction outputs already in utxo set");
        if (known) { known.inMempool = true; return tx.id; }
        const inputs: Utxo[] = [];
        for (let i = 0; i < tx.inputsLength; i++) {
          const input = tx.getInput(i), utxo = this.utxos.get(key(hex.encode(input.txid!), input.index!));
          if (!utxo) throw rpcError(-25, "bad-txns-inputs-missingorspent");
          inputs.push(utxo);
        }
        let spent = 0n, received = 0n, sent = 0n;
        for (const u of inputs) { spent += u.amount; this.utxos.delete(key(u.txid, u.vout)); this.locked.delete(key(u.txid, u.vout)); }
        for (let i = 0; i < tx.outputsLength; i++) {
          const output = tx.getOutput(i);
          if (this.keys.has(hex.encode(output.script!))) { received += output.amount!; this.utxos.set(key(tx.id, i), { txid: tx.id, vout: i, amount: output.amount!, script: output.script!, confirmations: 0, mine: true }); }
          else sent += output.amount!;
        }
        const fee = spent - sent - received;
        this.txs.set(tx.id, { txid: tx.id, hex: params[0] as string, confirmations: 0, inMempool: true, entries: [{ category: "send", amount: -btc(sent), fee: -btc(fee) }] });
        return tx.id;
      }
      case "gettransaction": {
        const tx = this.txs.get(params[0] as string);
        if (!tx) throw rpcError(-5, "Invalid or non-wallet transaction id");
        return { txid: tx.txid, confirmations: tx.confirmations, hex: tx.hex };
      }
      case "getmempoolentry": {
        if (!this.txs.get(params[0] as string)?.inMempool) throw rpcError(-5, "Transaction not in mempool");
        return { vsize: 141 };
      }
      case "lockunspent": {
        const [unlock, outpoints] = params as [boolean, { txid: string; vout: number }[]];
        for (const o of outpoints) {
          if (unlock && !this.locked.has(key(o.txid, o.vout))) throw rpcError(-8, "Invalid parameter, expected locked output");
          if (unlock) this.locked.delete(key(o.txid, o.vout)); else this.locked.add(key(o.txid, o.vout));
        }
        return true;
      }
      case "listtransactions": {
        const [, count] = params as [string, number];
        return [...this.txs.values()].flatMap((tx) => tx.entries.map((e) => ({ txid: tx.txid, category: e.category, amount: e.amount, fee: e.fee, confirmations: tx.confirmations, time: 1_700_000_000 }))).slice(-count);
      }
      default: throw rpcError(-32601, "Method not found");
    }
  }
}

function addressScript(address: string) {
  const tx = new Transaction(TX_OPTS);
  tx.addOutputAddress(address, 1n, REGTEST);
  return tx.getOutput(0).script!;
}
