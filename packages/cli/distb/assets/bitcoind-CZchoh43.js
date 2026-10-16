import { s as networkMode, t as NothingSpentError } from "./types-C4_KafL_.js";
import "./bitcoindProvider-DGw3xBSa.js";
import { base64, hex } from "@scure/base";
import { Address, OutScript, Transaction } from "@scure/btc-signer";
//#region ../browser/src/engine/paymentAdapters/providers/bitcoind.ts
var BitcoindRpcError = class extends Error {
	kind;
	code;
	constructor(kind, message, code) {
		super(message);
		this.kind = kind;
		this.code = code;
		this.name = "BitcoindRpcError";
	}
	/** The node never ran the call: it was not sent, could not connect, or the credentials were refused. */
	get neverRan() {
		return this.kind === "refused" || this.kind === "connect" || this.kind === "auth";
	}
};
/** The Tauri command, through the Desktop host. */
function tauriTransport(invoke) {
	if (!invoke) throw new Error("Bitcoin Core needs the Ghostly desktop app: a browser cannot reach its RPC");
	return (call) => invoke("bitcoind_rpc", { ...call });
}
/** Bitcoin Core's JSON-RPC error codes this module acts on (src/rpc/protocol.h). */
var RPC = {
	INVALID_ADDRESS_OR_KEY: -5,
	VERIFY_ERROR: -25,
	VERIFY_REJECTED: -26,
	VERIFY_ALREADY_IN_CHAIN: -27,
	DESERIALIZATION_ERROR: -22
};
var CHAINS = {
	main: "bitcoin",
	test: "testnet",
	testnet4: "testnet",
	signet: "signet",
	regtest: "regtest"
};
/** A fee rate for the test networks when the node has too few blocks to estimate one (regtest always). */
var TEST_FALLBACK_FEE_RATE = 2;
var TXID = /^[0-9a-f]{64}$/;
/** Address encodings, for btc-signer to read the outputs back as addresses. */
var TESTNET_ENCODING = {
	bech32: "tb",
	pubKeyHash: 111,
	scriptHash: 196,
	wif: 239
};
var BTC_NETWORKS = {
	bitcoin: {
		bech32: "bc",
		pubKeyHash: 0,
		scriptHash: 5,
		wif: 128
	},
	testnet: TESTNET_ENCODING,
	signet: TESTNET_ENCODING,
	mutinynet: TESTNET_ENCODING,
	regtest: {
		...TESTNET_ENCODING,
		bech32: "bcrt"
	}
};
var TX_OPTS = {
	allowUnknownOutputs: true,
	allowUnknownInputs: true,
	disableScriptCheck: true,
	allowLegacyWitnessUtxo: true
};
/** Whole sats as the exact decimal string bitcoind reads as BTC (never a float). */
var satsToBtc = (sats) => {
	if (!Number.isSafeInteger(sats) || sats < 0) throw new Error("Amounts are whole sats");
	const digits = sats.toString().padStart(9, "0");
	return `${digits.slice(0, -8)}.${digits.slice(-8)}`;
};
/** A BTC amount from bitcoind (a JSON number with at most 8 decimals) as whole sats. */
var btcToSats = (btc) => {
	if (typeof btc !== "number" || !Number.isFinite(btc)) throw new Error("The node returned an amount that is not a number");
	return Math.round(btc * 1e8);
};
var object = (value, what) => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`The node returned no ${what}`);
	return value;
};
var text = (value, what) => {
	if (typeof value !== "string" || !value) throw new Error(`The node returned no ${what}`);
	return value;
};
var BitcoindOnchain = class BitcoindOnchain {
	config;
	transport;
	closed = false;
	network;
	constructor(config, transport) {
		this.config = config;
		this.transport = transport;
	}
	/** Connects and checks the wallet is there and the node is on a network of `mode`. */
	static async connect(config, mode, transport, signal) {
		const provider = new BitcoindOnchain(config, transport);
		signal?.addEventListener("abort", () => void provider.close(), { once: true });
		const { network } = await provider.info();
		if (networkMode(network) !== mode) throw new Error(mode === "mainnet" ? `This node is on ${network}, not Bitcoin mainnet` : "This node is on Bitcoin mainnet: set it up as a Mainnet wallet instead");
		if (object(await provider.call("getwalletinfo"), "wallet information").private_keys_enabled === false) throw new Error("This wallet has no private keys: it cannot sign a payment");
		return provider;
	}
	async call(method, ...params) {
		if (this.closed) throw new BitcoindRpcError("refused", "This Bitcoin Core source is closed");
		try {
			return await this.transport({
				...this.config,
				method,
				params
			});
		} catch (error) {
			if (error instanceof BitcoindRpcError) throw error;
			const failure = error;
			if (failure && typeof failure === "object" && typeof failure.kind === "string" && typeof failure.message === "string") throw new BitcoindRpcError(failure.kind, failure.message, failure.code);
			throw new BitcoindRpcError("transport", error instanceof Error ? error.message : String(error));
		}
	}
	async info() {
		const chain = object(await this.call("getblockchaininfo"), "chain information").chain;
		const network = typeof chain === "string" ? CHAINS[chain] : void 0;
		if (!network) throw new Error(`Ghostly does not know the chain "${String(chain).slice(0, 20)}"`);
		this.network = network;
		return {
			network,
			alias: this.config.wallet || "Bitcoin Core"
		};
	}
	async receiveAddress() {
		return text(await this.call("getnewaddress", "Ghostly"), "address");
	}
	async balance() {
		const mine = object(object(await this.call("getbalances"), "balances").mine, "balances");
		return {
			confirmed: btcToSats(mine.trusted),
			unconfirmed: btcToSats(mine.untrusted_pending)
		};
	}
	async feeRate(request) {
		if (request.feeRate !== void 0) {
			if (!Number.isFinite(request.feeRate) || request.feeRate < 1 || request.feeRate > 1e4) throw new Error("The fee rate must be between 1 and 10,000 sat/vB");
			return request.feeRate;
		}
		const estimate = object(await this.call("estimatesmartfee", 6), "fee estimate");
		if (typeof estimate.feerate === "number" && estimate.feerate > 0) return Math.max(1, Math.ceil(estimate.feerate * 1e5 * 1e3) / 1e3);
		if ((this.network ?? (await this.info()).network) === "bitcoin") throw new Error("Your node cannot estimate a fee yet. Nothing was sent.");
		return TEST_FALLBACK_FEE_RATE;
	}
	async prepareSend(request) {
		if (!Number.isSafeInteger(request.amount) || request.amount <= 0) throw new Error("Amounts are whole sats");
		const network = this.network ?? (await this.info()).network;
		const feeRate = await this.feeRate(request);
		const funded = object(await this.call("walletcreatefundedpsbt", [], [{ [request.address]: satsToBtc(request.amount) }], 0, {
			fee_rate: feeRate,
			lockUnspents: true,
			replaceable: true
		}), "funded transaction");
		const inputs = this.outpoints(Transaction.fromPSBT(base64.decode(text(funded.psbt, "funded transaction")), TX_OPTS));
		try {
			const fee = btcToSats(funded.fee);
			if (fee > request.feeCap) throw new Error(`The fee (${fee} sats) is above your limit of ${request.feeCap}`);
			const signed = object(await this.call("walletprocesspsbt", funded.psbt, true, "ALL"), "signed transaction");
			if (signed.complete !== true) throw new Error("The wallet could not sign this payment (is it locked, or watch-only?)");
			const final = object(await this.call("finalizepsbt", signed.psbt, false), "finalized transaction");
			if (final.complete !== true) throw new Error("The wallet could not finalize this payment");
			return this.check(Transaction.fromPSBT(base64.decode(text(final.psbt, "finalized transaction")), TX_OPTS), request, inputs, feeRate, network);
		} catch (error) {
			await this.unlock(inputs).catch(() => {});
			throw error;
		}
	}
	/** The transaction the node signed is exactly the one asked for, before anyone reviews it. */
	check(tx, request, funded, feeRate, network) {
		const same = (a, b) => a.length === b.length && a.every((o, i) => o.txid === b[i].txid && o.vout === b[i].vout);
		if (!same(this.outpoints(tx), funded)) throw new Error("The node signed other coins than it funded the payment with");
		const script = (() => {
			try {
				return hex.encode(OutScript.encode(Address(BTC_NETWORKS[network]).decode(request.address)));
			} catch {
				return;
			}
		})();
		let paid = 0;
		for (let i = 0; i < tx.outputsLength; i++) {
			const output = tx.getOutput(i);
			if (script !== void 0 && output.script && hex.encode(output.script) === script) paid += Number(output.amount ?? 0n);
		}
		if (paid !== request.amount) throw new Error("The node built a transaction that does not pay the address and amount asked for");
		const fee = Number(tx.fee);
		if (!Number.isSafeInteger(fee) || fee < 0 || fee > request.feeCap) throw new Error(`The fee (${fee} sats) is above your limit of ${request.feeCap}`);
		const txid = tx.id;
		if (!TXID.test(txid)) throw new Error("The node returned a transaction without a valid id");
		return {
			txid,
			address: request.address,
			amount: request.amount,
			fee,
			feeRate,
			signed: hex.encode(tx.extract())
		};
	}
	outpoints(tx) {
		const out = [];
		for (let i = 0; i < tx.inputsLength; i++) {
			const input = tx.getInput(i);
			if (!input.txid || input.index === void 0) throw new Error("The node returned a transaction with an unreadable input");
			out.push({
				txid: hex.encode(input.txid),
				vout: input.index
			});
		}
		return out;
	}
	async unlock(outpoints) {
		if (outpoints.length) await this.call("lockunspent", true, outpoints);
	}
	signedTx(prepared) {
		if (!/^[0-9a-f]+$/.test(prepared.signed)) throw new Error("This prepared payment has no signed transaction");
		const tx = Transaction.fromRaw(hex.decode(prepared.signed), TX_OPTS);
		if (tx.id !== prepared.txid) throw new Error("This prepared payment's transaction is not the one reviewed");
		return tx;
	}
	async broadcast(prepared) {
		const tx = this.signedTx(prepared);
		let txid;
		try {
			txid = await this.call("sendrawtransaction", prepared.signed);
		} catch (error) {
			if (!(error instanceof BitcoindRpcError)) throw error;
			if (error.kind === "rpc" && error.code === RPC.VERIFY_ALREADY_IN_CHAIN) return prepared.txid;
			const rejected = error.kind === "rpc" && [
				RPC.VERIFY_ERROR,
				RPC.VERIFY_REJECTED,
				RPC.DESERIALIZATION_ERROR
			].includes(error.code ?? 0);
			if (!error.neverRan && !rejected) throw error;
			const seen = rejected ? await this.known(prepared.txid) : await this.known(prepared.txid).catch(() => void 0);
			if (seen) {
				if (["mempool", "confirmed"].includes((await this.status(prepared)).state)) return prepared.txid;
				throw error;
			}
			if (seen === false) await this.unlock(this.outpoints(tx)).catch(() => {});
			throw new NothingSpentError(`Your node did not send it: ${error.message}`);
		}
		if (txid !== prepared.txid) throw new Error("The node broadcast a different transaction than the one reviewed");
		return prepared.txid;
	}
	/** Whether the wallet knows this transaction (it does once its node accepted it, even if it was dropped since). */
	async known(txid) {
		try {
			await this.call("gettransaction", txid);
			return true;
		} catch (error) {
			if (error instanceof BitcoindRpcError && error.kind === "rpc" && error.code === RPC.INVALID_ADDRESS_OR_KEY) return false;
			throw error;
		}
	}
	async status(prepared) {
		if (!TXID.test(prepared.txid)) throw new Error("Not a transaction id");
		let tx;
		try {
			tx = object(await this.call("gettransaction", prepared.txid), "transaction");
		} catch (error) {
			if (error instanceof BitcoindRpcError && error.kind === "rpc" && error.code === RPC.INVALID_ADDRESS_OR_KEY) return {
				state: "missing",
				confirmations: 0
			};
			throw error;
		}
		const confirmations = typeof tx.confirmations === "number" ? tx.confirmations : 0;
		if (confirmations > 0) return {
			state: "confirmed",
			confirmations
		};
		if (confirmations < 0) return {
			state: "conflicted",
			confirmations: 0
		};
		if (Array.isArray(tx.mempoolconflicts) && tx.mempoolconflicts.length > 0) return {
			state: "conflicted",
			confirmations: 0
		};
		try {
			await this.call("getmempoolentry", prepared.txid);
			return {
				state: "mempool",
				confirmations: 0
			};
		} catch (error) {
			if (error instanceof BitcoindRpcError && error.kind === "rpc" && error.code === RPC.INVALID_ADDRESS_OR_KEY) return {
				state: "missing",
				confirmations: 0
			};
			throw error;
		}
	}
	async release(prepared) {
		await this.unlock(this.outpoints(this.signedTx(prepared)));
	}
	async history(limit) {
		const count = Math.max(1, Math.min(200, Math.floor(limit) * 3));
		const entries = await this.call("listtransactions", "*", count, 0, true);
		if (!Array.isArray(entries)) throw new Error("The node returned no transaction list");
		const byTxid = /* @__PURE__ */ new Map();
		for (const raw of entries) {
			if (!raw || typeof raw.txid !== "string" || !TXID.test(raw.txid) || raw.category === "orphan") continue;
			const tx = byTxid.get(raw.txid) ?? {
				txid: raw.txid,
				amount: 0,
				confirmations: typeof raw.confirmations === "number" ? Math.max(0, raw.confirmations) : 0
			};
			tx.amount += btcToSats(raw.amount);
			if (raw.category === "send" && typeof raw.fee === "number" && tx.fee === void 0) tx.fee = Math.abs(btcToSats(raw.fee));
			if (typeof raw.time === "number") tx.timestamp = raw.time * 1e3;
			byTxid.delete(raw.txid);
			byTxid.set(raw.txid, tx);
		}
		return [...byTxid.values()].reverse().slice(0, Math.max(0, limit));
	}
	/** The wallet's receives on this address, newest first: only `receive` entries paying exactly it count. */
	async received(address) {
		const entries = await this.call("listtransactions", "*", 200, 0, true);
		if (!Array.isArray(entries)) throw new Error("The node returned no transaction list");
		const byTxid = /* @__PURE__ */ new Map();
		for (const raw of entries) {
			if (!raw || raw.category !== "receive" || raw.address !== address || typeof raw.txid !== "string" || !TXID.test(raw.txid)) continue;
			const tx = byTxid.get(raw.txid) ?? {
				txid: raw.txid,
				amount: 0,
				confirmations: typeof raw.confirmations === "number" ? Math.max(0, raw.confirmations) : 0
			};
			tx.amount += btcToSats(raw.amount);
			byTxid.delete(raw.txid);
			byTxid.set(raw.txid, tx);
		}
		return [...byTxid.values()].reverse();
	}
	async close() {
		this.closed = true;
	}
};
//#endregion
export { BitcoindOnchain, tauriTransport };

//# sourceMappingURL=bitcoind-CZchoh43.js.map