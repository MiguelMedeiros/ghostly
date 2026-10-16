import { Tl as fromBase64Url, la as irohDescriptor, ua as irohRelayUrl } from "./src-dfGE33hw.js";
//#region ../browser/src/engine/paymentAdapters/fedimintSdk.ts
var fedimintDatabase = (id) => `ghostly-fedimint-${id}.db`;
var MODULE_WASM = () => import("./fedimint_client_wasm_bg-BtHHlFpp.js");
/** The SDK checks it with an assert: any other length kills the worker. One client per database, always this name. */
var CLIENT_NAME = "dd5135b2-c228-41b7-a4f9-3b6e7afe3088";
var NETWORKS = {
	bitcoin: "bitcoin",
	signet: "signet",
	testnet: "testnet",
	testnet4: "testnet",
	regtest: "regtest",
	mutinynet: "mutinynet"
};
/**
* A v1 wallet (or Lightning) module's client config comes consensus-encoded as hex (`config` from a joined client,
* `unknown_module_hex` in a preview); its network is the chain's magic, a u32 as a compact-size integer (`fe` +
* four bytes, little-endian). Exactly one network must be found, or it stays unknown.
*/
var MAGIC = [
	["fed9b4bef9", "bitcoin"],
	["fe0709110b", "testnet"],
	["fe283f161c", "testnet"],
	["fe40cf030a", "signet"],
	["fecb2ddfa5", "mutinynet"],
	["fedab5bffa", "regtest"]
];
function moduleNetwork(module) {
	if (typeof module.network === "string") return NETWORKS[module.network];
	const encoded = typeof module.config === "string" ? module.config : module.unknown_module_hex;
	if (typeof encoded !== "string" || !/^[0-9a-f]*$/i.test(encoded)) return void 0;
	const hex = encoded.toLowerCase();
	const found = [...new Set(MAGIC.filter(([magic]) => hex.includes(magic)).map(([, network]) => network))];
	return found.length === 1 ? found[0] : void 0;
}
var hex = (value) => typeof value === "string" ? value : Array.isArray(value) ? value.map((b) => Number(b).toString(16).padStart(2, "0")).join("") : void 0;
var compiling;
/** Compiled once per page (11 MB): each worker is handed the module, not the bytes. */
function compiled() {
	return compiling ??= (async () => {
		const url = (await MODULE_WASM()).default;
		const response = await fetch(url);
		try {
			return await WebAssembly.compileStreaming(response.clone());
		} catch {
			return WebAssembly.compile(await response.arrayBuffer());
		}
	})().catch((error) => {
		compiling = void 0;
		throw error;
	});
}
/** A transport of `@fedimint/core` onto our own worker (fedimintWorker.ts). */
async function browserTransport() {
	const [{ Transport }, module] = await Promise.all([import("@fedimint/types"), compiled()]);
	class WorkerTransport extends Transport {
		logger = {
			debug() {},
			info() {},
			warn() {},
			error() {}
		};
		worker = new Worker(new URL("./fedimintWorker.ts", import.meta.url), { type: "module" });
		constructor() {
			super();
			this.worker.onmessage = (event) => this.messageHandler(event.data);
			this.worker.onerror = (event) => {
				event.preventDefault();
				this.messageHandler({
					type: "error",
					error: `The Fedimint client stopped: ${event.message || "unknown error"}`
				});
			};
		}
		postMessage(message) {
			this.worker.postMessage(message.type === "init" ? {
				...message,
				payload: {
					...message.payload,
					module
				}
			} : message);
		}
		terminate() {
			this.worker.terminate();
		}
	}
	return new WorkerTransport();
}
var text = (value, max = 200) => typeof value === "string" ? value.slice(0, max) : void 0;
var errorText = (error) => error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
function federationInfo(federationId, config) {
	const c = config;
	const endpoints = Object.entries(c?.global?.api_endpoints ?? {}).sort(([a], [b]) => Number(a) - Number(b));
	const modules = Object.values(c?.modules ?? {});
	const network = modules.filter((m) => m?.kind === "wallet").map(moduleNetwork).find(Boolean) ?? modules.filter((m) => m?.kind === "ln").map(moduleNetwork).find(Boolean);
	const version = c?.global?.consensus_version;
	return {
		federationId,
		name: text(c?.global?.meta?.federation_name, 80),
		guardians: endpoints.slice(0, 64).map(([peer, e]) => ({
			name: text(e?.name, 80) || `Guardian ${peer}`,
			url: text(e?.url, 300) ?? ""
		})),
		consensusVersion: `${Number(version?.major ?? 0)}.${Number(version?.minor ?? 0)}`,
		network,
		modules: [...new Set(modules.map((m) => typeof m?.kind === "string" ? m.kind.slice(0, 32) : "").filter(Boolean))],
		welcome: text(c?.global?.meta?.welcome_message, 280)
	};
}
/** The first value a subscription gives that is final, or the last one within `waitMs`. */
function watch(subscribe, final, waitMs) {
	return new Promise((resolve) => {
		let last, done = false, cancel = () => {};
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			cancel();
			resolve(last);
		};
		const timer = setTimeout(finish, waitMs);
		cancel = subscribe((state) => {
			last = state;
			if (final(state)) finish();
		}, () => finish());
	});
}
var SPEND = {
	Created: "created",
	UserCanceledProcessing: "canceling",
	UserCanceledSuccess: "canceled",
	UserCanceledFailure: "taken",
	Success: "taken",
	Refunded: "refunded"
};
var spendFinal = (s) => s === "canceled" || s === "taken" || s === "refunded";
var REDEEM = {
	Created: "created",
	Issuing: "issuing",
	Done: "done"
};
var receiveOf = (s) => s === "claimed" ? "claimed" : s === "funded" || s === "awaiting_funds" ? "funded" : typeof s === "object" && s && "canceled" in s ? "canceled" : "open";
var RealClient = class {
	federationId;
	wallet;
	director;
	end;
	constructor(federationId, wallet, director, end) {
		this.federationId = federationId;
		this.wallet = wallet;
		this.director = director;
		this.end = end;
	}
	async info() {
		return federationInfo(this.federationId, await this.wallet.federation.getConfig());
	}
	balance() {
		return this.wallet.balance.getBalance();
	}
	onBalance(listener) {
		return this.wallet.balance.subscribeBalance(listener, () => {});
	}
	async parseNotes(notes) {
		const parsed = await this.director.parseOobNotes(notes);
		return {
			amountMsats: Number(parsed.total_amount),
			federationIdPrefix: String(parsed.federation_id_prefix),
			federationId: parsed.federation_id ?? void 0
		};
	}
	async spend(amountMsats, { cancelAfterSecs, ghostly }) {
		const { notes, operation_id } = await this.wallet.mint.spendNotes(amountMsats, cancelAfterSecs, false, { ghostly });
		return {
			notes: String(notes),
			operationId: String(operation_id)
		};
	}
	cancelSpend(operationId) {
		return this.wallet.mint.tryCancelSpendNotes(operationId);
	}
	spendState(operationId, waitMs) {
		return watch((ok, fail) => this.wallet.mint.subscribeSpendNotes(operationId, (s) => ok(SPEND[s] ?? "created"), fail), spendFinal, waitMs);
	}
	redeem(notes, ghostly) {
		return this.wallet.mint.reissueExternalNotes(notes, { ghostly });
	}
	redeemState(operationId, waitMs) {
		return watch((ok, fail) => this.wallet.mint.subscribeReissueExternalNotes(operationId, (s) => ok(typeof s === "string" ? REDEEM[s] ?? "created" : s && typeof s === "object" && "Failed" in s ? "failed" : "created"), (error) => {
			ok("failed");
			fail(error);
		}), (s) => s === "done" || s === "failed", waitMs);
	}
	async createInvoice(amountMsats, description, expirySecs, ghostly) {
		const { operation_id, invoice } = await this.wallet.lightning.createInvoice(amountMsats, description, expirySecs, void 0, { ghostly });
		return {
			operationId: String(operation_id),
			invoice: String(invoice)
		};
	}
	receiveState(operationId, waitMs) {
		return watch((ok, fail) => this.wallet.lightning.subscribeLnReceive(operationId, (s) => ok(receiveOf(s)), fail), (s) => s === "claimed" || s === "canceled", waitMs);
	}
	async gatewayFee(amountMsats) {
		await this.wallet.lightning.updateGatewayCache().catch(() => {});
		const fees = (await this.wallet.lightning.getAvailableGateway().catch(() => null))?.fees;
		if (!fees) return void 0;
		return Number(fees.base_msat ?? 0) + Math.ceil(amountMsats * Number(fees.proportional_millionths ?? 0) / 1e6);
	}
	async payInvoice(invoice, ghostly) {
		const paid = await this.wallet.lightning.payInvoice(invoice, void 0, { ghostly });
		const internal = "internal" in paid.payment_type;
		return {
			operationId: String(internal ? paid.payment_type.internal : paid.payment_type.lightning),
			feeMsats: Number(paid.fee ?? 0),
			internal
		};
	}
	async payState(operationId, internal, waitMs) {
		const state = await watch((ok, fail) => internal ? this.wallet.lightning.subscribeInternalPayment(operationId, ok, fail) : this.wallet.lightning.subscribeLnPay(operationId, ok, fail), (s) => typeof s === "object" && !!s && ("success" in s || "preimage" in s || "refunded" in s || "refund_success" in s || "unexpected_error" in s || "funding_failed" in s) || s === "canceled", waitMs);
		if (state && typeof state === "object") {
			const s = state;
			if (s.success?.preimage || s.preimage) return {
				state: "paid",
				preimage: hex(s.success?.preimage ?? s.preimage)
			};
			if ("refunded" in s || "refund_success" in s || "funding_failed" in s) return {
				state: "failed",
				error: errorText(s.refunded?.gateway_error ?? s.funding_failed?.error ?? "The gateway gave the payment back")
			};
			if ("unexpected_error" in s) return {
				state: "pending",
				error: errorText(s.unexpected_error)
			};
		}
		if (state === "canceled") return {
			state: "failed",
			error: "Canceled before it was funded"
		};
		return { state: "pending" };
	}
	async operations(limit) {
		return (await this.wallet.federation.listOperations(limit)).map(([key, log]) => {
			const variant = log.meta?.variant && typeof log.meta.variant === "object" ? Object.keys(log.meta.variant)[0] : void 0;
			const detail = variant ? log.meta.variant[variant] : void 0;
			return {
				id: String(key.operation_id ?? ""),
				kind: String(log.operation_module_kind ?? ""),
				variant,
				createdAt: Number(key.creation_time?.secs_since_epoch ?? 0) * 1e3,
				amountMsats: typeof log.meta?.amount === "number" ? log.meta.amount : typeof detail?.requested_amount === "number" ? detail.requested_amount : void 0,
				outcome: log.outcome?.outcome,
				ghostly: typeof log.meta?.extra_meta?.ghostly === "string" ? log.meta.extra_meta.ghostly : void 0,
				invoice: typeof detail?.invoice === "string" ? detail.invoice : void 0,
				feeMsats: typeof detail?.fee === "number" ? detail.fee : void 0
			};
		});
	}
	async close() {
		try {
			await this.wallet.cleanup();
		} catch {}
		this.end();
	}
};
var BROWSER = {
	transport: browserTransport,
	async exists(database) {
		const root = await navigator.storage.getDirectory();
		try {
			return (await (await root.getFileHandle(database)).getFile()).size > 0;
		} catch {
			return false;
		}
	},
	async remove(database) {
		await (await navigator.storage.getDirectory()).removeEntry(database).catch((error) => {
			if (error?.name !== "NotFoundError") throw error;
		});
	}
};
var loading;
/** Loads the SDK on first use: profiles that never join a federation never fetch its 11 MB. */
function loadFedimintSdk() {
	return loading ??= fedimintSdkOn(BROWSER).catch((error) => {
		loading = void 0;
		throw error;
	});
}
/** The SDK on a platform's workers and files. */
async function fedimintSdkOn(platform) {
	const { WalletDirector } = await import("@fedimint/core");
	/** A director on its own worker and database, with the mnemonic in place. */
	const director = async (database, mnemonic) => {
		const t = await platform.transport();
		const d = new WalletDirector(t, database, true);
		try {
			await d.initialize(database);
			if (mnemonic && !await d.hasMnemonicSet()) await d.setMnemonic(mnemonic.trim().split(/\s+/));
			return {
				director: d,
				end: () => t.terminate()
			};
		} catch (error) {
			t.terminate();
			throw error;
		}
	};
	const client = async (database, mnemonic, start) => {
		const { director: d, end } = await director(database, mnemonic);
		try {
			const wallet = await d.createWallet();
			await start(wallet);
			return new RealClient(await wallet.federation.getFederationId(), wallet, d, end);
		} catch (error) {
			end();
			throw error;
		}
	};
	const sdk = {
		async preview(invite) {
			const database = fedimintDatabase(`preview-${crypto.randomUUID()}`);
			const { director: d, end } = await director(database);
			try {
				const preview = await d.previewFederation(invite.trim());
				return federationInfo(preview.federation_id, preview.config);
			} finally {
				end();
				await sdk.remove(database).catch(() => {});
			}
		},
		join: ({ database, mnemonic, invite, recover }) => client(database, mnemonic, async (wallet) => {
			if (!await wallet.joinFederation(invite.trim(), {
				clientName: CLIENT_NAME,
				forceRecover: recover
			})) throw new Error("Could not join the federation: its guardians did not answer, or the invite code is not valid");
		}),
		open: ({ database, mnemonic }) => client(database, mnemonic, (wallet) => wallet.open(CLIENT_NAME)),
		exists: (database) => platform.exists(database),
		remove: (database) => platform.remove(database)
	};
	return sdk;
}
//#endregion
//#region ../browser/src/platform/irohWeb.ts
/**
* Iroh (WISP 102) in a browser: the same QUIC/TLS session and binding as the
* Desktop's native Iroh, but relay only. A page cannot send UDP, so every
* packet goes through an Iroh relay over a WebSocket; the relay sees who talks
* to whom and when, never the frames.
*
* The wasm (about 1 MB gzip) loads on the first chat that starts an endpoint,
* never on the app's first load.
*/
/**
* n0's public relays, the same ones the Desktop's Iroh homes on by default. Iroh itself names them with the trailing
* dot of a full domain name (`use1-1.relay.n0.iroh.link.`), and compares relay URLs as text; here they have none,
* because WebKit opens no host name that ends in a dot. `BROWSER_SPELLING` is what keeps the two one relay.
*/
var DEFAULT_IROH_RELAYS = [
	"https://use1-1.relay.n0.iroh.link/",
	"https://euc1-1.relay.n0.iroh.link/",
	"https://aps1-1.relay.n0.iroh.link/",
	"https://usw1-1.relay.n0.iroh.link/"
];
/**
* The spelling of every relay URL handed to the wasm Iroh (`irohRelayUrl`): the relays it homes on and a contact's
* relay before a dial. One spelling, so a contact on this endpoint's relay is reached over the connection already
* open to it; without the dot, so Safari can open it (a Desktop's record names its relay with the dot).
*/
var BROWSER_SPELLING = "plain";
/**
* Why a relay URL cannot be used, or null. TLS, except on this machine (a local `iroh-relay --dev`): a page
* may not open plain WebSockets elsewhere, and the relay's operator would see traffic metadata in the clear.
*/
function irohRelayProblem(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		return `Not a relay address: ${value}`;
	}
	const local = [
		"localhost",
		"127.0.0.1",
		"[::1]"
	].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return `Use an https:// relay address: ${value}`;
	if (url.username || url.password || url.search || url.hash || value.length > 256) return `Not a relay address: ${value}`;
	return null;
}
var loaded = null;
/** Loads the wasm once per page. Tests pass their own `load` (Node reads the file). */
function loadIrohWasm() {
	loaded ??= import("./ghostly_iroh_web-BsAEFIjl.js").then(async (module) => {
		await module.default();
		return module;
	}).catch((error) => {
		loaded = null;
		throw error;
	});
	return loaded;
}
var SEND_BUDGET = 122880;
var MAX_FRAME = 61440;
/** One paired channel over one QUIC stream. Sends are queued in order. */
var IrohWebChannel = class {
	conn;
	forget;
	reader = null;
	buffered = [];
	queue = Promise.resolve();
	closed = false;
	bufferedAmount = 0;
	sendBudget = SEND_BUDGET;
	onClose = null;
	constructor(conn, forget) {
		this.conn = conn;
		this.forget = forget;
		this.read();
	}
	get onMessage() {
		return this.reader;
	}
	set onMessage(reader) {
		this.reader = reader;
		if (reader) for (const text of this.buffered.splice(0)) reader(text);
	}
	async read() {
		try {
			for (;;) {
				const text = await this.conn.recv();
				if (text === void 0 || this.closed) break;
				if (this.reader) this.reader(text);
				else if (this.buffered.length < 64) this.buffered.push(text);
				else break;
			}
		} catch {}
		this.close();
	}
	send(data) {
		if (typeof data !== "string" || this.closed || !data.length || data.length > MAX_FRAME || this.bufferedAmount + data.length > SEND_BUDGET) throw new Error("Iroh channel is closed or its send budget is full");
		this.bufferedAmount += data.length;
		this.queue = this.queue.then(() => this.closed ? void 0 : this.conn.send(data)).catch(() => this.close()).finally(() => {
			this.bufferedAmount -= data.length;
		});
	}
	drained() {
		return this.queue;
	}
	get rttMs() {
		const rtt = this.conn.rtt();
		return rtt >= 0 ? rtt : void 0;
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		this.buffered = [];
		try {
			this.conn.close();
		} catch {}
		this.forget();
		this.onClose?.();
	}
};
/** A NativeEndpoint for `iroh/1`, as the Desktop's is, for one chat's transport seed. */
async function createIrohWebEndpoint(seedB64, options = {}) {
	const seed = fromBase64Url(seedB64);
	if (seed.length !== 32) throw new Error("Invalid transport seed");
	const relays = [...new Set((options.relays?.length ? options.relays : DEFAULT_IROH_RELAYS).map((relay) => irohRelayUrl(relay, BROWSER_SPELLING)))];
	const node = await (await (options.load ?? loadIrohWasm)()).IrohNode.start(seed, relays, options.onlineMs ?? 1e4);
	const channels = /* @__PURE__ */ new Set();
	let stopped = false;
	let handler = null;
	const early = [];
	const bind = (conn) => {
		const channel = new IrohWebChannel(conn, () => channels.delete(channel));
		channels.add(channel);
		return {
			channel,
			binding: conn.binding()
		};
	};
	const endpoint = {
		transport: "iroh/1",
		descriptor: {
			...node.address(),
			relayed: true
		},
		onDescriptor: null,
		get onConnection() {
			return handler;
		},
		set onConnection(value) {
			handler = value;
			if (value) for (const bound of early.splice(0)) value(bound);
		},
		async connect(descriptor) {
			if (stopped) throw new Error("Iroh endpoint is stopped");
			const conn = await node.connect(irohDescriptor(descriptor, BROWSER_SPELLING), options.connectMs ?? 2e4);
			if (stopped) {
				conn.close();
				throw new Error("Iroh endpoint is stopped");
			}
			return bind(conn);
		},
		async close() {
			if (stopped) return;
			stopped = true;
			for (const channel of [...channels]) channel.close();
			for (const bound of early.splice(0)) bound.channel.close();
			await node.close().catch(() => {});
		}
	};
	(async () => {
		while (!stopped) {
			let conn;
			try {
				conn = await node.accept();
			} catch {
				break;
			}
			if (!conn) break;
			if (stopped) {
				conn.close();
				break;
			}
			const bound = bind(conn);
			const accept = endpoint.onConnection;
			if (accept) accept(bound);
			else if (early.length < 4) early.push(bound);
			else bound.channel.close();
		}
		if (!stopped) {
			endpoint.onUnavailable?.();
			await endpoint.close();
		}
	})();
	return endpoint;
}
//#endregion
export { fedimintSdkOn as a, fedimintDatabase as i, createIrohWebEndpoint as n, loadFedimintSdk as o, irohRelayProblem as r, DEFAULT_IROH_RELAYS as t };

//# sourceMappingURL=irohWeb-B0JRxO3f.js.map