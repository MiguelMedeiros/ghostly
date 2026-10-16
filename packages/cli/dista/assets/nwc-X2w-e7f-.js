import { zn as decodeBolt11 } from "./src-dfGE33hw.js";
import { t as NothingSpentError } from "./types-C4_KafL_.js";
import { n as parseNwcUri } from "./nwcProvider-wzUFtog3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import * as nip04 from "nostr-tools/nip04";
import * as nip44 from "nostr-tools/nip44";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
//#region ../browser/src/engine/paymentAdapters/providers/nwc.ts
/**
* Lightning through a wallet reached over Nostr Wallet Connect (NIP-47): Alby Hub, a node's NWC service, a
* hosted wallet. The person pastes the wallet's `nostr+walletconnect://` URI; requests are signed with the
* key it carries, encrypted to the wallet (NIP-44, or NIP-04 when its info event offers nothing else) and
* sent through its relay; the answers come back the same way. That wallet holds the sats, applies its own
* fee limit, and is custodial or not depending on what it is.
*
* Money safety (PROVIDERS.md): a request that never reached the relay, or an error code the wallet answers
* before it tries to pay, is `NothingSpentError`. A `pay_invoice` whose answer does not come back in time,
* or any other error, is an unknown outcome, and `paymentStatus` asks `lookup_invoice` until it ends.
*/
var KIND = {
	info: 13194,
	request: 23194,
	response: 23195
};
/** A relay message, an encrypted answer, an info event, an invoice: nothing bigger is read. */
var MAX_MESSAGE = 262144;
var MAX_CONTENT = 65536;
var MAX_INFO = 4096;
var MAX_INVOICE = 7089;
var CONNECT_MS = 1e4;
var ACK_MS = 1e4;
var REQUEST_MS = 2e4;
/** A payment may take a while to route; an answer after this is an unknown outcome, looked up later. */
var PAY_MS = 9e4;
/** The wallet must not start a payment it receives after this (NIP-47 `expiration`). */
var PAY_EXPIRY_S = 60;
/** A payment the wallet never heard of is failed once its invoice can no longer be paid, with room for clocks. */
var EXPIRED_MARGIN_MS = 6e5;
var INVOICE_EXPIRY_S = 3600;
/** Error codes a wallet answers before it tries to pay: nothing can have left it. (`BAD_REQUEST`: Alby Hub, an invoice it cannot read.) */
var REFUSED_BEFORE_PAYING = /* @__PURE__ */ new Set([
	"RATE_LIMITED",
	"NOT_IMPLEMENTED",
	"INSUFFICIENT_BALANCE",
	"QUOTA_EXCEEDED",
	"RESTRICTED",
	"UNAUTHORIZED",
	"UNSUPPORTED_ENCRYPTION",
	"BAD_REQUEST"
]);
var NETWORKS = {
	mainnet: "bitcoin",
	bitcoin: "bitcoin",
	testnet: "testnet",
	testnet3: "testnet",
	testnet4: "testnet",
	signet: "signet",
	mutinynet: "mutinynet",
	regtest: "regtest"
};
var HEX64 = /^[0-9a-f]{64}$/;
var hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
var bytes = (text) => Uint8Array.from(text.match(/../g), (b) => parseInt(b, 16));
var now = () => Math.floor(Date.now() / 1e3);
var isMsat = (value) => Number.isSafeInteger(value) && value >= 0;
/** The request never reached the relay (not connected, refused by it): the wallet cannot have seen it. */
var NotDelivered = class extends Error {
	constructor(message) {
		super(message);
		this.name = "NotDelivered";
	}
};
/** An error the wallet answered, with its NIP-47 code. */
var NwcError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = "NwcError";
	}
};
/** No answer in time. The request may or may not have been acted on. */
var NoAnswer = class extends Error {
	constructor(method) {
		super(`The wallet did not answer ${method} in time`);
		this.name = "NoAnswer";
	}
};
/**
* A minimal NIP-01 client for one relay: it knows exactly whether an event was written to an open socket
* and whether the relay acknowledged it, which is what tells "nothing sent" from "unknown" apart.
* It reconnects when asked to send again, and subscriptions follow it.
*/
var RelayConnection = class {
	url;
	WebSocketImpl;
	socket;
	opening;
	subs = /* @__PURE__ */ new Map();
	acks = /* @__PURE__ */ new Map();
	closed = false;
	constructor(url, WebSocketImpl = globalThis.WebSocket) {
		this.url = url;
		this.WebSocketImpl = WebSocketImpl;
	}
	open() {
		if (this.closed) return Promise.reject(/* @__PURE__ */ new Error("The wallet connection is closed"));
		if (this.socket?.readyState === 1) return Promise.resolve(this.socket);
		if (!this.opening) {
			const opening = this.connectSocket();
			this.opening = opening;
			opening.catch(() => {}).finally(() => {
				if (this.opening === opening) this.opening = void 0;
			});
		}
		return this.opening;
	}
	connectSocket() {
		return new Promise((resolve, reject) => {
			let settled = false;
			const socket = new this.WebSocketImpl(this.url);
			const done = (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error) {
					try {
						socket.close();
					} catch {}
					reject(error);
					return;
				}
				if (this.closed) {
					socket.close();
					reject(/* @__PURE__ */ new Error("The wallet connection is closed"));
					return;
				}
				this.socket = socket;
				for (const [id, sub] of this.subs) this.write([
					"REQ",
					id,
					sub.filter
				]);
				resolve(socket);
			};
			const timer = setTimeout(() => done(/* @__PURE__ */ new Error("The wallet's relay did not answer")), CONNECT_MS);
			socket.onopen = () => done();
			socket.onerror = () => done(/* @__PURE__ */ new Error("Could not reach the wallet's relay"));
			socket.onclose = () => {
				done(/* @__PURE__ */ new Error("The wallet's relay closed the connection"));
				if (this.socket !== socket) return;
				this.socket = void 0;
				for (const [id, ack] of this.acks) {
					this.acks.delete(id);
					ack.fail(/* @__PURE__ */ new Error("The relay connection dropped before it confirmed the request"));
				}
			};
			socket.onmessage = (message) => {
				if (this.socket === socket) this.receive(message.data);
			};
		});
	}
	subscribe(id, filter, sub) {
		this.subs.set(id, {
			...sub,
			filter
		});
		this.write([
			"REQ",
			id,
			filter
		]);
	}
	unsubscribe(id) {
		if (this.subs.delete(id)) this.write(["CLOSE", id]);
	}
	/**
	* Events matching `filter` the relay has stored, until it says that is all (or `ms` pass). With
	* `waitForOne`, a relay that has none yet is listened to until one arrives live, within `ms`.
	*/
	async fetch(filter, { ms = CONNECT_MS, waitForOne = false } = {}) {
		await this.open();
		const id = `q${hex(crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(6)))}`, events = [];
		try {
			await new Promise((resolve) => {
				const timer = setTimeout(resolve, ms);
				let stored = false;
				const finish = () => {
					clearTimeout(timer);
					resolve();
				};
				this.subscribe(id, filter, {
					event: (e) => {
						if (events.length < 20) events.push(e);
						if (stored) finish();
					},
					eose: () => {
						stored = true;
						if (events.length || !waitForOne) finish();
					}
				});
			});
		} finally {
			this.unsubscribe(id);
		}
		return events;
	}
	/**
	* Resolves once the relay accepted the event. `NotDelivered` when it certainly did not reach it (no open
	* socket, refused); any other rejection means it may have.
	*/
	async publish(event) {
		let socket;
		try {
			socket = await this.open();
		} catch (error) {
			throw new NotDelivered(error instanceof Error ? error.message : "Could not reach the wallet's relay");
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.acks.delete(event.id);
				reject(/* @__PURE__ */ new Error("The relay did not confirm the request"));
			}, ACK_MS);
			this.acks.set(event.id, {
				ok: () => {
					clearTimeout(timer);
					resolve();
				},
				fail: (error) => {
					clearTimeout(timer);
					reject(error);
				}
			});
			if (socket.readyState !== 1 || socket !== this.socket) {
				this.acks.delete(event.id);
				clearTimeout(timer);
				reject(new NotDelivered("The relay connection closed"));
				return;
			}
			socket.send(JSON.stringify(["EVENT", event]));
		});
	}
	close() {
		this.closed = true;
		for (const [id, ack] of this.acks) {
			this.acks.delete(id);
			ack.fail(/* @__PURE__ */ new Error("The wallet connection is closed"));
		}
		this.subs.clear();
		try {
			this.socket?.close();
		} catch {}
		this.socket = void 0;
	}
	write(message) {
		if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message));
	}
	receive(data) {
		if (typeof data !== "string" || data.length > MAX_MESSAGE) return;
		let message;
		try {
			message = JSON.parse(data);
		} catch {
			return;
		}
		if (!Array.isArray(message) || typeof message[1] !== "string") return;
		const [type, id] = message;
		if (type === "EVENT") this.subs.get(id)?.event(message[2]);
		else if (type === "EOSE") this.subs.get(id)?.eose?.();
		else if (type === "OK") {
			const ack = this.acks.get(id);
			if (!ack) return;
			this.acks.delete(id);
			const reason = typeof message[3] === "string" ? message[3].slice(0, 120) : "";
			if (message[2] === true || reason.startsWith("duplicate:")) ack.ok();
			else ack.fail(new NotDelivered(`The relay refused the request${reason ? ` (${reason})` : ""}`));
		}
	}
};
var NwcLightning = class NwcLightning {
	connection;
	relay;
	encryption;
	options;
	/** From the info event, then narrowed to what this connection may do (`get_info`). */
	capabilities;
	clientPubkey;
	subscription = `nwc${hex(crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(6)))}`;
	pending = /* @__PURE__ */ new Map();
	conversationKey;
	network = "bitcoin";
	alias;
	closed = false;
	constructor(connection, relay, encryption, methods, options) {
		this.connection = connection;
		this.relay = relay;
		this.encryption = encryption;
		this.options = options;
		this.clientPubkey = getPublicKey(connection.secret);
		if (encryption === "nip44_v2") this.conversationKey = nip44.v2.utils.getConversationKey(connection.secret, connection.walletPubkey);
		this.capabilities = this.capabilitiesOf(methods);
	}
	/**
	* Reaches the wallet through the first relay that answers, reads its info event (the methods and the
	* encryption it offers), listens for its answers, and asks `get_info` for its network.
	*/
	static async connect(uri, options = {}) {
		const connection = parseNwcUri(uri);
		options.signal?.throwIfAborted();
		let relay, lastError;
		for (const url of connection.relays) {
			const candidate = new RelayConnection(url, options.WebSocket);
			try {
				await candidate.open();
				relay = candidate;
				break;
			} catch (error) {
				candidate.close();
				lastError = error;
			}
		}
		if (!relay) throw lastError instanceof Error ? lastError : /* @__PURE__ */ new Error("Could not reach the wallet's relay");
		let wallet;
		try {
			const info = NwcLightning.newestInfo(await relay.fetch({
				kinds: [KIND.info],
				authors: [connection.walletPubkey],
				limit: 5
			}, {
				waitForOne: true,
				ms: options.infoMs
			}), connection.walletPubkey);
			if (!info) throw new Error(`The wallet has not published its NWC info on ${new URL(relay.url).host}: check the URI, or that the wallet is running`);
			const offered = (info.tags.find((t) => t[0] === "encryption")?.slice(1).join(" ") ?? "").split(/\s+/).filter(Boolean);
			const encryption = offered.includes("nip44_v2") ? "nip44_v2" : !offered.length || offered.includes("nip04") ? "nip04" : void 0;
			if (!encryption) throw new Error("The wallet offers no encryption Ghostly speaks (NIP-44 or NIP-04)");
			const methods = new Set(info.content.split(/\s+/).filter(Boolean));
			wallet = new NwcLightning(connection, relay, encryption, methods, options);
			wallet.listen();
			if (options.signal) {
				const opened = wallet;
				if (options.signal.aborted) throw options.signal.reason;
				options.signal.addEventListener("abort", () => void opened.close(), { once: true });
			}
			await wallet.readInfo(methods);
			return wallet;
		} catch (error) {
			if (wallet) await wallet.close();
			else relay.close();
			throw error;
		}
	}
	static newestInfo(events, walletPubkey) {
		return events.filter((e) => e && e.kind === KIND.info && e.pubkey === walletPubkey && typeof e.content === "string" && e.content.length <= MAX_INFO && Array.isArray(e.tags) && verifyEvent(e)).sort((a, b) => b.created_at - a.created_at)[0];
	}
	capabilitiesOf(methods) {
		const lookup = methods.has("lookup_invoice");
		return {
			receive: methods.has("make_invoice"),
			send: methods.has("pay_invoice") && lookup,
			balance: methods.has("get_balance"),
			lookup
		};
	}
	/**
	* `get_info` says the network and the methods this connection may use (the info event lists the
	* service's). Without it the wallet is taken to be on Bitcoin: a test wallet is then refused in the
	* Testnet mode and its invoices in the Mainnet one, while a real-money wallet never passes for a test one.
	*/
	async readInfo(offered) {
		if (!offered.has("get_info")) return;
		let info;
		try {
			info = await this.request("get_info", {});
		} catch (error) {
			if (error instanceof NwcError && [
				"RESTRICTED",
				"UNAUTHORIZED",
				"NOT_IMPLEMENTED"
			].includes(error.code)) return;
			throw error;
		}
		if (info.network !== void 0) {
			const network = typeof info.network === "string" ? NETWORKS[info.network.toLowerCase()] : void 0;
			if (!network) throw new Error("The wallet is on a network Ghostly does not know");
			this.network = network;
		}
		if (typeof info.alias === "string" && info.alias.trim()) this.alias = info.alias.trim().slice(0, 40);
		if (Array.isArray(info.methods) && info.methods.every((m) => typeof m === "string")) this.capabilities = this.capabilitiesOf(new Set(info.methods));
	}
	listen() {
		this.relay.subscribe(this.subscription, {
			kinds: [KIND.response],
			authors: [this.connection.walletPubkey],
			"#p": [this.clientPubkey],
			since: now() - 60
		}, { event: (e) => this.answer(e) });
	}
	encrypt(text) {
		return this.conversationKey ? nip44.v2.encrypt(text, this.conversationKey) : nip04.encrypt(this.connection.secret, this.connection.walletPubkey, text);
	}
	decrypt(content) {
		if (this.conversationKey && !content.includes("?iv=")) return nip44.v2.decrypt(content, this.conversationKey);
		return nip04.decrypt(this.connection.secret, this.connection.walletPubkey, content);
	}
	/**
	* Sends one request and waits for its answer. `NotDelivered` when it never reached the relay; `NwcError`
	* for an error the wallet answered; `NoAnswer` (or a relay error) when the outcome is unknown.
	*/
	async request(method, params, { ms = this.options.requestMs ?? REQUEST_MS, expiresIn } = {}) {
		if (this.closed) throw new NotDelivered("The wallet connection is closed");
		const tags = [["p", this.connection.walletPubkey]];
		if (this.conversationKey) tags.push(["encryption", "nip44_v2"]);
		if (expiresIn) tags.push(["expiration", String(now() + expiresIn)]);
		const event = finalizeEvent({
			kind: KIND.request,
			created_at: now(),
			tags,
			content: this.encrypt(JSON.stringify({
				method,
				params
			}))
		}, this.connection.secret);
		const answer = new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(event.id);
				reject(new NoAnswer(method));
			}, ms);
			this.pending.set(event.id, {
				method,
				resolve,
				reject,
				timer
			});
		});
		const delivered = this.relay.publish(event).then(() => void 0, (error) => {
			const waiting = this.pending.get(event.id);
			if (!(error instanceof NotDelivered) || !waiting) return void 0;
			clearTimeout(waiting.timer);
			this.pending.delete(event.id);
			return error;
		});
		return Promise.race([answer, delivered.then((error) => error ? Promise.reject(error) : answer)]);
	}
	/** Reads an answer: from the wallet, signed, about a request of ours, of the method asked. Anything else is dropped. */
	answer(raw) {
		const event = raw;
		if (!event || typeof event !== "object" || event.kind !== KIND.response || event.pubkey !== this.connection.walletPubkey) return;
		if (typeof event.content !== "string" || event.content.length > MAX_CONTENT || !Array.isArray(event.tags)) return;
		const ref = event.tags.find((t) => Array.isArray(t) && t[0] === "e")?.[1];
		const pending = typeof ref === "string" ? this.pending.get(ref) : void 0;
		if (!pending || !event.tags.some((t) => Array.isArray(t) && t[0] === "p" && t[1] === this.clientPubkey)) return;
		if (!verifyEvent(event)) return;
		let body;
		try {
			body = JSON.parse(this.decrypt(event.content));
		} catch {
			return;
		}
		if (!body || typeof body !== "object" || body.result_type !== pending.method) return;
		clearTimeout(pending.timer);
		this.pending.delete(ref);
		if (body.error) {
			const code = typeof body.error.code === "string" ? body.error.code.slice(0, 40) : "OTHER";
			const message = typeof body.error.message === "string" && body.error.message.trim() ? body.error.message.trim().slice(0, 200) : code;
			pending.reject(new NwcError(code, message));
		} else if (body.result && typeof body.result === "object" && !Array.isArray(body.result)) pending.resolve(body.result);
		else pending.reject(new NwcError("OTHER", "The wallet sent an empty answer"));
	}
	async lookup(paymentHash) {
		const tx = await this.request("lookup_invoice", { payment_hash: paymentHash });
		if (tx.payment_hash !== void 0 && String(tx.payment_hash).toLowerCase() !== paymentHash) throw new Error("The wallet answered about another invoice");
		return tx;
	}
	async info() {
		let balance;
		if (this.capabilities.balance) {
			const result = await this.request("get_balance", {});
			if (!isMsat(result.balance)) throw new Error("The wallet returned an invalid balance");
			balance = Math.floor(result.balance / 1e3);
		}
		return {
			network: this.network,
			alias: `${this.alias ?? "NWC wallet"} via ${new URL(this.relay.url).host}`,
			balance
		};
	}
	async createInvoice(amount, memo) {
		if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(amount * 1e3)) throw new Error("Invalid amount");
		const result = await this.request("make_invoice", {
			amount: amount * 1e3,
			...memo ? { description: memo.slice(0, 200) } : {},
			expiry: INVOICE_EXPIRY_S
		});
		const text = typeof result.invoice === "string" && result.invoice.length <= MAX_INVOICE ? result.invoice : "";
		const decoded = decodeBolt11(text);
		if (!decoded?.paymentHash || decoded.amountMsat !== BigInt(amount) * 1000n) throw new Error("The wallet returned an invoice that does not match the request");
		if (result.payment_hash !== void 0 && String(result.payment_hash).toLowerCase() !== decoded.paymentHash) throw new Error("The wallet returned an invoice that does not match its payment hash");
		return {
			invoice: decoded.invoice,
			paymentHash: decoded.paymentHash,
			amount,
			expiresAt: decoded.expiresAt * 1e3
		};
	}
	async invoiceStatus(invoice) {
		let tx;
		try {
			tx = await this.lookup(invoice.paymentHash);
		} catch (error) {
			if (error instanceof NwcError && error.code === "NOT_FOUND" && invoice.expiresAt < Date.now()) return { state: "expired" };
			throw error;
		}
		const expired = invoice.expiresAt < Date.now();
		if (tx.type === "outgoing") return { state: expired ? "expired" : "open" };
		const state = tx.state ?? (tx.settled_at ? "settled" : "pending");
		if (state === "settled") return {
			state: "paid",
			amount: isMsat(tx.amount) ? Math.floor(tx.amount / 1e3) : invoice.amount
		};
		if (state === "expired" || state === "failed") return { state: "expired" };
		return { state: expired ? "expired" : "open" };
	}
	/**
	* Pays through the wallet. NIP-47 carries no fee limit: the wallet applies its own, and the fee it
	* reports is passed on as it is.
	*/
	async payInvoice(invoice, _maxFee) {
		const decoded = decodeBolt11(invoice);
		if (!decoded?.paymentHash || decoded.amountSat === null) throw new NothingSpentError("That invoice cannot be paid through NWC");
		if (!this.capabilities.send) throw new NothingSpentError("This wallet connection may not pay and look up invoices");
		let result;
		try {
			result = await this.request("pay_invoice", { invoice: decoded.invoice }, {
				ms: this.options.payMs ?? PAY_MS,
				expiresIn: PAY_EXPIRY_S
			});
		} catch (error) {
			if (error instanceof NotDelivered) throw new NothingSpentError(`The payment did not reach the wallet: ${error.message}`);
			if (error instanceof NwcError && REFUSED_BEFORE_PAYING.has(error.code)) throw new NothingSpentError(`The wallet refused the payment: ${error.message}`);
			if (error instanceof NwcError) return this.confirmFailure(decoded.invoice, decoded.paymentHash, error);
			throw error;
		}
		const preimage = typeof result.preimage === "string" ? result.preimage.toLowerCase() : "";
		if (!HEX64.test(preimage) || hex(sha256(bytes(preimage))) !== decoded.paymentHash) throw new Error("The wallet said it paid, without a proof that matches the invoice");
		return {
			state: "paid",
			preimage,
			fee: isMsat(result.fees_paid) ? Math.ceil(result.fees_paid / 1e3) : void 0
		};
	}
	/**
	* An error after the wallet may have tried (`PAYMENT_FAILED` "may be due to a timeout", `INTERNAL`,
	* `OTHER`…): its own record decides. Only a payment it records as failed is `NothingSpentError`; one it
	* records as paid is paid; anything else is pending, or unknown when it cannot be asked.
	*/
	async confirmFailure(invoice, paymentHash, failure) {
		let status;
		try {
			status = await this.paymentStatus({
				invoice,
				paymentHash
			});
		} catch {
			throw new Error(`The wallet said the payment failed (${failure.message}), and cannot confirm it yet`);
		}
		if (status.state === "failed") throw new NothingSpentError(`The payment failed: ${failure.message}`);
		return status.state === "paid" ? {
			state: "paid",
			fee: status.fee,
			preimage: status.preimage
		} : { state: "pending" };
	}
	async paymentStatus(payment) {
		let tx;
		try {
			tx = await this.lookup(payment.paymentHash);
		} catch (error) {
			if (!(error instanceof NwcError && error.code === "NOT_FOUND")) throw error;
			return { state: (decodeBolt11(payment.invoice)?.expiresAt ?? Infinity) * 1e3 + EXPIRED_MARGIN_MS < Date.now() ? "failed" : "pending" };
		}
		if (tx.type === "incoming") return { state: "pending" };
		const preimage = typeof tx.preimage === "string" && HEX64.test(tx.preimage.toLowerCase()) ? tx.preimage.toLowerCase() : void 0;
		const proven = !!preimage && hex(sha256(bytes(preimage))) === payment.paymentHash;
		const state = tx.state ?? (tx.settled_at || proven ? "settled" : "pending");
		const fee = isMsat(tx.fees_paid) ? Math.ceil(tx.fees_paid / 1e3) : void 0;
		if (state === "settled") {
			if (preimage && !proven) throw new Error("The wallet's proof of payment does not match the invoice");
			return {
				state: "paid",
				fee,
				preimage
			};
		}
		if (state === "failed" || state === "expired") return { state: "failed" };
		return { state: "pending" };
	}
	async close() {
		if (this.closed) return;
		this.closed = true;
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			this.pending.delete(id);
			pending.reject(/* @__PURE__ */ new Error("The wallet connection is closed"));
		}
		this.relay.close();
	}
};
//#endregion
export { NwcLightning };

//# sourceMappingURL=nwc-X2w-e7f-.js.map