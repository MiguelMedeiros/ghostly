import { $n as engineError, Aa as RateWindow, Br as ChatFiles, Dl as toBase64Url, El as randomBytes, Hr as transferEnded, Ja as replySnippet, Ln as requestLnurlInvoice, Rn as resolveLightningDestination, Sa as fileMessageText, ar as GROUP_WANT_NO_FRAME, cr as isGroupMessageId, dr as readGroupWant, er as engineText, fr as readGroupWantNo, hn as WALLET_NETWORKS, nr as GROUP_FILE_LIMITS, or as fetchesByItself, rr as GROUP_HAVE_FRAME, sr as groupFileFallback, ur as readGroupHave, xn as walletNetworkOf, zn as decodeBolt11 } from "./src-dfGE33hw.js";
import { a as describeProvider, c as offeredIn, d as sourceProblem, n as PROVIDER_PLATFORMS, o as isNothingSpentError, s as networkMode, t as NothingSpentError, u as redact } from "./types-C4_KafL_.js";
import { h as wrap, i as STORES, l as fileStore, m as transact, o as databaseName, p as store } from "./idb-BuyRKmBx.js";
import { a as sealSeed, i as newDeviceKey, o as unsealSeed, t as networkReason } from "./networkReason-CY6aipPw.js";
import { t as BITCOIN_INVOICE_ON_TESTNET, u as mintNetwork } from "./mints-BrlY773j.js";
import { f as FILE_BYTES_STEP, o as fileBytes, s as fileBytesOf } from "./fileBytes-BLAQx_nv.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
//#region ../browser/src/engine/paymentAdapters/away.ts
var away = /* @__PURE__ */ new Map();
/** The wallets away from this device, by wallet id, with the name of their home device ("" when it has none here). */
function setAwayWallets(next) {
	away = new Map(next);
}
/** The home device's name of a wallet away from this device, or undefined when it is here. */
function awayFrom(id) {
	return away.get(id);
}
/** A wallet that cannot be used here: it is at home on another device. */
var WalletAwayError = class extends Error {
	constructor(wallet, device) {
		super(device ? engineText("walletAway", {
			wallet,
			device
		}) : engineText("walletAwayUnnamed", { wallet }));
		this.name = "WalletAwayError";
	}
};
/**
* Whether a single-writer wallet (Ark, Bark, Spark and the Breez source, Fedimint) may open its SDK now: the engine
* says, from a good turn read under 60 seconds old (WISP 06 § Wallets). Every open asks, the retries of each wallet
* included, so a device replaced while it was offline does not reopen one on a retry.
*/
var turnGate = async () => true;
function setSingleWriterGate(gate) {
	turnGate = gate ?? (async () => true);
}
/** Throws (the wallet tries again later, as it does when its server does not answer) without a fresh good turn read. */
async function requireTurn() {
	if (!await turnGate().catch(() => false)) throw new Error("Checking which device is active");
}
/** Throws when the wallet `id` is at home on another device. */
function refuseAway(id, wallet) {
	const device = awayFrom(id);
	if (device !== void 0) throw new WalletAwayError(wallet, device);
}
//#endregion
//#region ../browser/src/engine/paymentAdapters/modeGate.ts
/** A wallet of the mode being left stopped opening: the switch goes ahead without waiting for its network. */
var ModeChanged = class extends Error {
	constructor() {
		super("The wallets switched mode");
		this.name = "ModeChanged";
	}
};
var networkLabel = (network) => network === "mainnet" ? "Mainnet" : "Testnet";
/**
* What was asked of one network's wallet belongs to the other network's (a backup, a chain): nothing was changed.
* `network` is where it belongs, so the engine can hand it to that wallet instead.
*/
var WrongNetworkError = class extends Error {
	network;
	constructor(network, message) {
		super(message);
		this.network = network;
		this.name = "WrongNetworkError";
	}
};
/**
* Opening a wallet waits on its network (an Ark server, an RPC), which can take minutes or never answer.
* A mode switch must not wait behind that: `within` gives up on the wait as soon as the mode changes, and
* whatever still arrives afterwards is handed to `dispose`. Nothing is saved before that wait ends, so
* giving up leaves the profile as it was. Every wait on the network inside a wallet's queue goes through it,
* reading a balance too, or the switch, queued behind it, waits anyway.
*/
var ModeGate = class {
	target;
	constructor(target = "mainnet") {
		this.target = target;
	}
	controller = new AbortController();
	/** The mode its owner works in, once it says so: a wait that starts while a switch away from it is queued ends at once. */
	current;
	/** A switch to `mode` was asked for: waits for a wallet of another mode end now. */
	switching(mode) {
		if (this.target === mode) return;
		this.target = mode;
		this.controller.abort();
		this.controller = new AbortController();
	}
	/** The owner's switch to `mode` is applied (its queue reached it): waits are for this mode again. */
	entered(mode) {
		this.current = mode;
	}
	/**
	* A creation took too long: the waits under way end now, and so does every wait that starts until `resume`
	* (a creation still sealing its seed has not reached its server yet, and must not wait there either).
	*/
	interrupt() {
		this.cut = true;
		this.controller.abort();
		this.controller = new AbortController();
	}
	resume() {
		this.cut = false;
	}
	cut = false;
	/** The wallet stopped: every wait ends now, and any later one at once. */
	close() {
		this.closed = true;
		this.controller.abort();
	}
	closed = false;
	within(work, dispose) {
		const signal = this.controller.signal;
		return new Promise((resolve, reject) => {
			const give = () => {
				reject(new ModeChanged());
				work.then((value) => dispose?.(value), () => {});
			};
			if (this.closed || this.cut || this.current && this.current !== this.target) return give();
			signal.addEventListener("abort", give, { once: true });
			work.then((value) => {
				signal.removeEventListener("abort", give);
				if (!signal.aborted) resolve(value);
			}, (error) => {
				signal.removeEventListener("abort", give);
				if (!signal.aborted) reject(error);
			});
		});
	}
};
//#endregion
//#region ../browser/src/shared/ice.ts
/**
* What is wrong with a TURN/STUN server, or null. Browsers refuse to create any WebRTC connection when
* one server in the list is malformed, so a bad entry here would silently cut off calls and files.
*/
function iceServerProblem(server) {
	if (typeof server?.urls !== "string") return "Each ICE server needs urls: one address, or several comma-separated (turn:host:port)";
	const urls = server.urls.split(/[\s,]+/).filter(Boolean);
	if (!urls.length) return "Enter the TURN server address";
	for (const url of urls) {
		if (!/^(stun|turns?):[^\s/?#]+(\?transport=(udp|tcp))?$/i.test(url)) return `“${url}” is not a TURN or STUN address (turn:host:port)`;
		if (/^turns?:/i.test(url) && (!server.username?.trim() || !server.credential?.trim())) return "A TURN server needs its username and credential";
	}
	return null;
}
/**
* A server as WebRTC writes it (`urls` a list, as every TURN guide does) in this setting's own form: the addresses
* comma-separated. Anything else is left as it is, for `iceServerProblem` to say what is wrong.
*/
function iceServerSetting(server) {
	const urls = server?.urls;
	if (!Array.isArray(urls) || !urls.every((url) => typeof url === "string")) return server;
	return {
		...server,
		urls: urls.join(", ")
	};
}
//#endregion
//#region ../browser/src/engine/paymentAdapters/providers/breezDatabases.ts
var netOf = (network) => network === "bitcoin" || network === "mainnet" ? "mainnet" : "regtest";
var hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
var digest = (text) => hex(sha256(new TextEncoder().encode(text))).slice(0, 16);
/** What a Breez database name looks like, old or new: nothing about the seed or the profile shows in it. */
var BREEZ_DATABASE = /^ghostly-breez-(mainnet|regtest)-[0-9a-f]{16}$/;
/** The name every profile of the origin used for this phrase before databases were per profile. */
var breezLegacyName = (network, mnemonic) => `ghostly-breez-${netOf(network)}-${digest(`ghostly-breez:${netOf(network)}:${mnemonic}`)}`;
/** The name of this phrase's Breez database in one profile (`space`: the profile's peer database, WISP 04). */
var breezDatabaseName = (network, mnemonic, space = databaseName()) => `ghostly-breez-${netOf(network)}-${digest(`ghostly-breez:${space}:${netOf(network)}:${mnemonic}`)}`;
/**
* The databases the SDK keeps under one storage name. SDK 0.26 roots them there: `<name>/<network>/<identity>` and
* `<name>/<network>/<identity>-tree`, the identity read from the seed inside the SDK. Older builds kept `<name>`
* itself. A browser without `indexedDB.databases()` cannot list them: only the bare names are known there.
*/
async function breezDatabaseFiles(name) {
	const files = [name, `${name}-tree`];
	if (typeof indexedDB.databases !== "function") return files;
	const under = (await indexedDB.databases()).map((d) => d.name ?? "").filter((file) => file.startsWith(`${name}/`));
	return [.../* @__PURE__ */ new Set([...files, ...under])];
}
var REGISTER = "ghostly-breez";
var STORE = "databases";
var request = (r) => new Promise((resolve, reject) => {
	r.onsuccess = () => resolve(r.result);
	r.onerror = () => reject(r.error);
});
function openRegister() {
	return new Promise((resolve, reject) => {
		const open = indexedDB.open(REGISTER, 1);
		open.onupgradeneeded = () => {
			if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
		};
		open.onsuccess = () => resolve(open.result);
		open.onerror = () => reject(open.error);
		open.onblocked = () => reject(/* @__PURE__ */ new Error("The Breez register is blocked"));
	});
}
async function withRegister(mode, run) {
	const db = await openRegister();
	try {
		const tx = db.transaction(STORE, mode);
		const done = new Promise((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = tx.onabort = () => reject(tx.error);
		});
		const result = await run(tx.objectStore(STORE));
		await done;
		return result;
	} finally {
		db.close();
	}
}
/**
* Whether the SDK keeps a wallet under this storage name on this device (`breezDatabaseFiles`). A browser that cannot
* list databases is answered yes: the first profile then takes the old name whether or not it is there, which is
* safe, since only one profile ever has it.
*/
async function exists(name) {
	if (typeof indexedDB.databases !== "function") return true;
	return (await indexedDB.databases()).some((d) => d.name === name || !!d.name?.startsWith(`${name}/`));
}
/**
* The Breez database this profile opens for this phrase: the old shared one when this profile owns it (or is the
* first to claim it), else the profile's own. Noted in the register either way. A device whose IndexedDB cannot be
* read gets the profile's own name: never a database another profile may use.
*/
async function breezDatabase(network, mnemonic, space = databaseName()) {
	const fresh = breezDatabaseName(network, mnemonic, space);
	if (typeof indexedDB === "undefined") return fresh;
	const legacy = breezLegacyName(network, mnemonic);
	try {
		const legacyHere = await exists(legacy);
		return await withRegister("readwrite", async (store) => {
			const [owner, own] = await Promise.all([request(store.get(legacy)), request(store.get(fresh))]);
			if (owner?.space === space) return legacy;
			if (!own && !owner && legacyHere) {
				store.put({
					name: legacy,
					space,
					network: netOf(network),
					legacy: true
				}, legacy);
				return legacy;
			}
			if (!own) store.put({
				name: fresh,
				space,
				network: netOf(network)
			}, fresh);
			return fresh;
		});
	} catch {
		return fresh;
	}
}
/** The names this profile has noted for this phrase (nothing is claimed): what removing the wallet deletes. */
async function breezDatabasesFor(network, mnemonic, space = databaseName()) {
	const names = [breezLegacyName(network, mnemonic), breezDatabaseName(network, mnemonic, space)];
	return (await breezDatabasesOf(space)).filter((name) => names.includes(name));
}
/**
* The name this profile uses for this phrase, read without claiming anything: the one it noted (`breezDatabase`), else
* the profile's own name. What a handoff deletes and compares (WISP 06 § Wallets): never the old shared database of
* another profile that has not opened the phrase since the change.
*/
async function breezDatabaseInUse(network, mnemonic, space = databaseName()) {
	return (await breezDatabasesFor(network, mnemonic, space))[0] ?? breezDatabaseName(network, mnemonic, space);
}
/** Every Breez database name noted for a profile of this device. */
async function breezDatabasesOf(space) {
	if (typeof indexedDB === "undefined") return [];
	try {
		return (await withRegister("readonly", (store) => request(store.getAll()))).filter((e) => e?.space === space && BREEZ_DATABASE.test(e.name)).map((e) => e.name);
	} catch {
		return [];
	}
}
var deleteDatabase = (name) => new Promise((resolve) => {
	try {
		const r = indexedDB.deleteDatabase(name);
		r.onsuccess = r.onerror = r.onblocked = () => resolve();
	} catch {
		resolve();
	}
});
var deleteStrictly = (name) => new Promise((resolve, reject) => {
	const r = indexedDB.deleteDatabase(name);
	r.onsuccess = () => resolve();
	r.onerror = () => reject(r.error ?? /* @__PURE__ */ new Error(`${name} was not deleted`));
	r.onblocked = () => reject(/* @__PURE__ */ new Error(`${name} is still open`));
});
/**
* Deletes one Breez wallet's databases (all the SDK keeps under the name) and its note in the register. Anything else
* is refused. `strict` (a handoff, WISP 06 § Wallets): a delete that is blocked or fails rejects and the note stays,
* so the caller tries again.
*/
async function dropBreezDatabase(name, options = {}) {
	if (!BREEZ_DATABASE.test(name) || typeof indexedDB === "undefined") return;
	for (const file of await breezDatabaseFiles(name).catch(() => [name, `${name}-tree`])) await (options.strict ? deleteStrictly(file) : deleteDatabase(file));
	await withRegister("readwrite", (store) => {
		store.delete(name);
	}).catch(() => {});
}
//#endregion
//#region ../browser/src/engine/paymentAdapters/providers/cashuMint.ts
var CASHU_MINT_SOURCE = "cashu-mint";
var parseRef = (ref) => {
	const parsed = JSON.parse(ref ?? "null");
	if (!parsed?.mint || !parsed.quote) throw new Error("Unknown Cashu quote");
	return parsed;
};
/**
* Lightning through the Cashu mints: invoices are mint quotes that turn into ecash once paid, and
* invoices are paid by melting ecash. The default source, and what Lightning was before sources.
*
* The Cashu wallet already polls its quotes and pending melts, mints and books them and says so
* (`onQuotePaid`, `onMeltResolved`): the engine forwards those, and never polls this source itself.
*/
var CashuMintLightning = class {
	wallet;
	mode;
	capabilities = {
		receive: true,
		send: true,
		balance: true,
		lookup: true
	};
	settlesItself = true;
	/** The melt quote shown to the person is the one paid: quoting again could change the fee. */
	quotes = /* @__PURE__ */ new Map();
	constructor(wallet, mode) {
		this.wallet = wallet;
		this.mode = mode;
	}
	async info() {
		return {
			network: this.mode === "mainnet" ? "bitcoin" : "testnet",
			balance: (await this.wallet.view(this.mode)).balance
		};
	}
	async createInvoice(amount) {
		const quote = await this.wallet.receiveLightning(amount, void 0, this.mode);
		const decoded = decodeBolt11(quote.invoice);
		if (!decoded?.paymentHash) throw new Error("The mint returned an invoice that cannot be read");
		return {
			invoice: quote.invoice,
			paymentHash: decoded.paymentHash,
			amount,
			expiresAt: quote.expiresAt ?? decoded.expiresAt * 1e3,
			ref: JSON.stringify({
				mint: quote.mint,
				quote: quote.quote
			})
		};
	}
	async invoiceStatus(invoice) {
		const { mint, quote } = parseRef(invoice.ref);
		const state = await this.wallet.isHeld(quote) ? "UNPAID" : await this.wallet.mintQuoteState(mint, quote);
		if (state === "PAID" || state === "ISSUED") return {
			state: "paid",
			amount: invoice.amount
		};
		return { state: invoice.expiresAt < Date.now() ? "expired" : "open" };
	}
	/** A real melt quote: its fee reserve is what paying may cost at most. It is kept for `payInvoice`. */
	async estimateFee(invoice) {
		const quote = await this.wallet.quoteInvoice(invoice, this.mode);
		this.quotes.set(invoice.trim().toLowerCase(), quote);
		return quote.feeReserve;
	}
	/** The quote behind a fee just shown, when there is one: `payQuote` pays exactly that. */
	quoteFor(invoice) {
		return this.quotes.get(invoice.trim().toLowerCase());
	}
	/** The melt quote `payInvoice` pays, when its fee was shown first: what the mint is asked about later. */
	paymentRef(invoice) {
		const quote = this.quotes.get(invoice.trim().toLowerCase());
		return quote ? JSON.stringify({
			mint: quote.mint,
			quote: quote.quote
		}) : void 0;
	}
	/**
	* A payment the app was cut off from (the tab closed while it was being paid). A melt written down is the wallet's
	* to settle and report. With none, the mint's word on the quote decides: paid, or never melted (the melt is written
	* down before the mint is handed anything, so an unpaid quote with no melt spent nothing).
	*/
	async interruptedPayment(payment) {
		if (await this.wallet.meltInFlight(payment.invoice)) return "pending";
		if (!payment.ref) return "unknown";
		const { mint, quote } = parseRef(payment.ref);
		const state = await this.wallet.meltQuoteState(mint, quote);
		if (await this.wallet.meltInFlight(payment.invoice)) return "pending";
		return state === "PAID" ? "paid" : state === "PENDING" ? "pending" : "failed";
	}
	async payInvoice(invoice, maxFee, note) {
		const key = invoice.trim().toLowerCase();
		let quote = this.quotes.get(key);
		try {
			quote ??= await this.wallet.quoteInvoice(invoice, this.mode);
			if (quote.feeReserve > maxFee) throw engineError("lightningFeeTooHigh", { fee: quote.feeReserve });
		} catch (error) {
			throw new NothingSpentError(error instanceof Error ? error.message : String(error));
		}
		this.quotes.delete(key);
		const ref = JSON.stringify({
			mint: quote.mint,
			quote: quote.quote
		});
		let paid;
		try {
			paid = await this.wallet.payQuote(quote.quote, quote.mint, note);
		} catch (error) {
			throw new NothingSpentError(error instanceof Error ? error.message : String(error));
		}
		return paid ? {
			state: "paid",
			ref
		} : {
			state: "pending",
			ref
		};
	}
	async paymentStatus(payment) {
		const { mint, quote } = parseRef(payment.ref);
		const state = await this.wallet.meltQuoteState(mint, quote);
		return { state: state === "PAID" ? "paid" : state === "PENDING" ? "pending" : "failed" };
	}
	async close() {
		this.quotes.clear();
	}
};
var cashuMint = {
	id: CASHU_MINT_SOURCE,
	label: "Cashu mints",
	kind: "lightning",
	description: "Invoices are paid into, and paid from, your Cashu balance. The mints hold the sats.",
	networks: ["bitcoin", "testnet"],
	platforms: PROVIDER_PLATFORMS,
	fields: [],
	custodial: true,
	async create(_settings, host) {
		return new CashuMintLightning(host.cashu, host.mode);
	}
};
//#endregion
//#region ../browser/src/engine/paymentAdapters/providers/sources.ts
/** Where a source is stored: the mode's one, or one of several (`key`). */
var sourceKey = (kind, mode, key) => `${kind}Source-${mode}${key ? `-${key}` : ""}`;
var seenKey = (kind, mode, key) => `${kind}SourceSeen-${mode}${key ? `-${key}` : ""}`;
/**
* A source that does not answer is tried again by itself: 2 s, 4 s, 8 s… up to 5 minutes, ±20 % so
* that many apps coming back online do not knock at once.
*/
var RETRY_MAX_MS = 3e5;
function retryDelay(failures, random = Math.random) {
	const base = Math.min(RETRY_MAX_MS, 2e3 * 2 ** Math.max(0, failures - 1));
	return Math.round(base * (.8 + .4 * random()));
}
/**
* Gives up on a connection when its signal aborts (a change of settings interrupts an attempt), even if the
* provider does not listen to it; what still arrives afterwards is closed.
*/
function abortable(work, signal) {
	return new Promise((resolve, reject) => {
		const give = () => {
			reject(/* @__PURE__ */ new Error("The connection attempt was interrupted"));
			work.then((p) => p.close().catch(() => {}), () => {});
		};
		if (signal.aborted) return give();
		signal.addEventListener("abort", give, { once: true });
		work.then((value) => {
			signal.removeEventListener("abort", give);
			if (!signal.aborted) resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", give);
			if (!signal.aborted) reject(error);
		});
	});
}
/**
* The active source of one kind (Lightning, on-chain) of one network: Mainnet and Testnet each have their
* own, both connected at once. Every change is serialized.
*/
var ProviderSources = class {
	options;
	mode;
	stored;
	descriptor;
	provider;
	/** The connected source's secrets, only to blank them out of error messages. */
	secrets = {};
	controller = new AbortController();
	gate = new ModeGate();
	queue = Promise.resolve();
	connecting;
	timer;
	retry;
	/** Failed attempts in a row, and since when: what makes a failure sustained. */
	failures = 0;
	failingSince;
	seen;
	stopped = false;
	view = {
		mode: "mainnet",
		status: "none",
		offered: []
	};
	constructor(options) {
		this.options = options;
		this.mode = options.network;
		this.view = {
			mode: options.network,
			status: "none",
			offered: []
		};
	}
	serial(run) {
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => {});
		return next;
	}
	find(id) {
		return this.options.descriptors().find((d) => d.id === id);
	}
	offered() {
		return this.options.descriptors().filter((d) => offeredIn(d, this.options.host().platform, this.mode)).map((d) => describeProvider(d));
	}
	async load(mode) {
		const settings = await store(STORES.settings, "readonly");
		const [stored, seen] = await Promise.all([wrap(settings.get(sourceKey(this.options.kind, mode, this.options.key))), wrap(settings.get(seenKey(this.options.kind, mode, this.options.key)))]);
		this.stored = stored;
		this.seen = seen;
		this.failures = 0;
		this.failingSince = void 0;
	}
	/** The source of the mode (stored, else the default), not connected yet: with the last balance it read. */
	idle() {
		const id = this.stored?.providerId ?? this.options.defaultId;
		const descriptor = id ? this.find(id) : void 0;
		const seen = id && this.seen?.providerId === id ? this.seen : void 0;
		return {
			mode: this.mode,
			offered: this.offered(),
			providerId: id,
			label: descriptor?.label ?? id,
			custodial: descriptor?.custodial,
			isDefault: !!id && id === this.options.defaultId,
			config: this.stored?.config,
			secrets: descriptor?.fields.filter((f) => f.kind === "secret" && this.stored?.secrets).map((f) => f.name),
			status: !id ? "none" : descriptor ? "connecting" : "error",
			error: id && !descriptor ? `${id} is not available in this version of Ghostly` : void 0,
			...seen ? {
				balance: seen.balance,
				unconfirmed: seen.unconfirmed,
				balanceAt: seen.at
			} : {}
		};
	}
	async start() {
		await this.load(this.mode);
		this.view = this.idle();
	}
	/** One saved secret of the source (a handoff asks whether an LND card pins its certificate, and a Breez phrase), or undefined. */
	async secret(name) {
		const stored = this.stored;
		if (!stored?.secrets) return void 0;
		const value = JSON.parse(await unsealSeed(stored.secrets, stored.deviceKey ?? ""))[name];
		return typeof value === "string" && value ? value : void 0;
	}
	/** The list of providers changed (a plugin registered): the picker is told, nothing reconnects. */
	refreshOffered() {
		this.view = {
			...this.view,
			offered: this.offered()
		};
		this.options.changed();
	}
	/**
	* Connects the mode's source in the background, and keeps trying while it cannot be reached: "Connecting…"
	* (with the last balance it read) until the failure is sustained, then "Unavailable", still retrying with
	* backoff. `eager` (Retry, waking up): shows "Connecting…" again while it tries.
	*/
	ensureReady(eager = false) {
		return this.connecting ??= this.serial(() => this.connect(eager)).finally(() => {
			this.connecting = void 0;
		});
	}
	/** Retry, now: the wait before the next attempt is skipped. Resolves when the attempt ends. */
	retryNow() {
		if (this.provider || this.stopped) return Promise.resolve();
		clearTimeout(this.retry);
		return this.ensureReady(true);
	}
	/**
	* The app is back (in front, online, the computer woke): a source that is not connected is tried now, and
	* a connected one reads its balance now.
	*/
	wake() {
		if (this.stopped) return;
		if (this.provider) {
			this.refresh();
			return;
		}
		if (this.failures && !this.connecting) this.retryNow();
	}
	async connect(eager = false) {
		clearTimeout(this.retry);
		if (this.stopped || this.provider) return;
		const id = this.stored?.providerId ?? this.options.defaultId;
		const descriptor = id ? this.find(id) : void 0;
		if (!id || !descriptor) {
			this.view = this.idle();
			this.options.changed();
			return;
		}
		if (eager && this.view.status === "error") {
			this.view = {
				...this.view,
				status: "connecting",
				retryAt: void 0
			};
			this.options.changed();
		}
		const signal = this.controller.signal;
		let secrets = {};
		try {
			if (this.stored?.secrets) secrets = JSON.parse(await unsealSeed(this.stored.secrets, this.stored.deviceKey ?? ""));
			const { provider, network, alias } = await this.open(descriptor, {
				config: this.stored?.config ?? {},
				secrets
			});
			this.descriptor = descriptor;
			this.provider = provider;
			this.secrets = secrets;
			this.failures = 0;
			this.failingSince = void 0;
			this.view = {
				...this.idle(),
				status: "ready",
				network,
				alias
			};
			this.options.changed();
			this.refresh();
		} catch (error) {
			if (this.stopped || error instanceof ModeChanged || signal.aborted) return;
			const now = Date.now();
			this.failures++;
			this.failingSince ??= now;
			const problem = sourceProblem(error);
			const sustained = problem === "config" || this.failures >= 3 && now - this.failingSince >= 3e4;
			const delay = (this.options.backoff ?? retryDelay)(this.failures);
			this.view = {
				...this.idle(),
				status: sustained ? "error" : "connecting",
				error: `Could not connect to ${descriptor.label}: ${redact(error, secrets)}`,
				problem,
				failures: this.failures,
				retryAt: now + delay
			};
			this.options.changed();
			this.retry = setTimeout(() => void this.ensureReady(), delay);
		}
	}
	/** Creates a provider and checks it is on a network of this mode before anything uses it. */
	async open(descriptor, settings, controller = this.controller) {
		if (descriptor.id === "breez") await requireTurn();
		const signal = controller.signal;
		const provider = await this.gate.within(abortable(descriptor.create(settings, {
			...this.options.host(),
			mode: this.mode,
			signal
		}), signal), (p) => p.close());
		try {
			const { network, alias } = await this.gate.within(provider.info());
			if (!descriptor.networks.includes(network)) throw new Error(`it runs on ${network}, which ${descriptor.label} does not support here`);
			if (networkMode(network) !== this.mode) throw new Error(this.mode === "mainnet" ? `it runs on ${network}, a test network: set it up as a Testnet wallet instead` : "it runs on Bitcoin, real money: set it up as a Mainnet wallet instead");
			return {
				provider,
				network,
				alias
			};
		} catch (error) {
			await provider.close().catch(() => {});
			throw error;
		}
	}
	/**
	* Makes `providerId` this mode's source, with the values typed in its form. It is connected and its
	* network checked first; only then are its settings saved (secrets sealed) and the old source closed.
	*/
	set(providerId, values) {
		const interrupted = this.interrupt();
		return this.afterChange(interrupted, this.serial(async () => {
			const { descriptor, settings } = this.settingsOf(providerId, values);
			await this.guard();
			await this.apply(descriptor, settings, false);
		}));
	}
	/** The form's values as a source's settings, checked: its secrets apart. Throws what to fix. */
	settingsOf(providerId, values) {
		const descriptor = this.find(providerId);
		if (!descriptor || !offeredIn(descriptor, this.options.host().platform, this.mode)) throw new Error("That source is not available here");
		const settings = {
			config: {},
			secrets: {}
		};
		for (const field of descriptor.fields) {
			const value = (values[field.name] ?? "").trim();
			if (!value && !field.optional) throw new Error(`Enter ${field.label.toLowerCase()}`);
			if (field.kind === "select" && value && !field.options?.some((o) => o.value === value)) throw new Error(`Choose ${field.label.toLowerCase()}`);
			if (value) (field.kind === "secret" ? settings.secrets : settings.config)[field.name] = value;
		}
		descriptor.validate?.(settings, this.mode);
		return {
			descriptor,
			settings
		};
	}
	/**
	* Whether the saved source is this provider with these very settings (the same wallet added twice). Its secrets are
	* unsealed here to compare, and never leave.
	*/
	async holds(providerId, settings) {
		const stored = this.stored;
		if (!stored || stored.providerId !== providerId) return false;
		const same = (a, b) => {
			const keys = Object.keys(a).sort();
			return JSON.stringify(keys) === JSON.stringify(Object.keys(b).sort()) && keys.every((k) => a[k] === b[k]);
		};
		if (!same(stored.config, settings.config)) return false;
		return same(stored.secrets ? JSON.parse(await unsealSeed(stored.secrets, stored.deviceKey ?? "")) : {}, settings.secrets);
	}
	/**
	* Changes the `changeable` fields (a server address) of this mode's saved source, keeping its sealed
	* secrets and whose money it is: the wallet stays, only where it reads the chain changes. Connected and
	* checked first, like `set`; a refusal leaves the saved source as it was.
	*/
	reconfigure(values) {
		const interrupted = this.interrupt();
		return this.afterChange(interrupted, this.serial(async () => {
			const stored = this.stored;
			const descriptor = stored ? this.find(stored.providerId) : void 0;
			if (!stored || !descriptor) throw new Error("There is no saved source to change");
			const changeable = descriptor.fields.filter((f) => f.changeable);
			if (!changeable.length) throw new Error(`${descriptor.label} has no server to change`);
			const config = { ...stored.config };
			for (const field of changeable) {
				if (!(field.name in values)) continue;
				const value = (values[field.name] ?? "").trim();
				if (!value && !field.optional) throw new Error(`Enter ${field.label.toLowerCase()}`);
				if (value) config[field.name] = value;
				else delete config[field.name];
			}
			const settings = {
				config,
				secrets: stored.secrets ? JSON.parse(await unsealSeed(stored.secrets, stored.deviceKey ?? "")) : {}
			};
			descriptor.validate?.(settings, this.mode);
			await this.apply(descriptor, settings, true);
		}));
	}
	/** A change refused after interrupting an attempt: the saved source goes on connecting as before. */
	afterChange(interrupted, change) {
		return change.finally(() => {
			if (interrupted && !this.provider && !this.stopped) this.ensureReady();
		});
	}
	/**
	* A connection attempt under way (or waiting to try again) gives way to a change of settings, instead of
	* holding it for its time-out. Says whether there was one.
	*/
	interrupt() {
		if (this.provider || !this.connecting && !this.failures) return false;
		clearTimeout(this.retry);
		this.controller.abort();
		this.controller = new AbortController();
		return true;
	}
	/** Connects `settings`, then saves them and replaces the current source. `same`: the same wallet, reconfigured. */
	async apply(descriptor, settings, same) {
		const providerId = descriptor.id;
		let opened;
		const controller = new AbortController();
		try {
			opened = await this.open(descriptor, settings, controller);
		} catch (error) {
			throw error instanceof ModeChanged ? error : /* @__PURE__ */ new Error(`Could not connect to ${descriptor.label}: ${redact(error, settings.secrets)}`);
		}
		const deviceKey = newDeviceKey();
		const stored = {
			providerId,
			config: settings.config,
			savedAt: Date.now(),
			...Object.keys(settings.secrets).length ? {
				secrets: await sealSeed(JSON.stringify(settings.secrets), deviceKey),
				deviceKey
			} : {}
		};
		const plain = providerId === this.options.defaultId && !Object.keys(settings.config).length && !stored.secrets;
		if (!same) this.seen = void 0;
		try {
			await transact([STORES.settings], (s) => {
				if (plain) s[STORES.settings].delete(sourceKey(this.options.kind, this.mode, this.options.key));
				else s[STORES.settings].put(stored, sourceKey(this.options.kind, this.mode, this.options.key));
				if (!same) s[STORES.settings].delete(seenKey(this.options.kind, this.mode, this.options.key));
			});
		} catch (error) {
			await opened.provider.close().catch(() => {});
			throw error;
		}
		await this.disconnect();
		this.controller = controller;
		this.failures = 0;
		this.failingSince = void 0;
		this.stored = plain ? void 0 : stored;
		this.descriptor = descriptor;
		this.provider = opened.provider;
		this.secrets = settings.secrets;
		this.view = {
			...this.idle(),
			status: "ready",
			network: opened.network,
			alias: opened.alias
		};
		this.options.changed();
		this.refresh();
	}
	/** Forgets this mode's source (and its sealed secrets): the default, if there is one, takes over. */
	clear() {
		this.interrupt();
		return this.serial(async () => {
			await this.guard();
			await transact([STORES.settings], (s) => {
				s[STORES.settings].delete(sourceKey(this.options.kind, this.mode, this.options.key));
				s[STORES.settings].delete(seenKey(this.options.kind, this.mode, this.options.key));
			});
			await this.disconnect(true);
			this.stored = void 0;
			this.seen = void 0;
			this.failures = 0;
			this.failingSince = void 0;
			this.view = this.idle();
			this.options.changed();
		}).then(() => this.ensureReady());
	}
	/**
	* Forgets this source for good (its card is removed): its settings, sealed secrets and last balance go, it is
	* closed, and nothing takes over. Refused while a payment through it has not ended.
	*/
	forget() {
		this.interrupt();
		return this.serial(async () => {
			await this.guard();
			await transact([STORES.settings], (s) => {
				s[STORES.settings].delete(sourceKey(this.options.kind, this.mode, this.options.key));
				s[STORES.settings].delete(seenKey(this.options.kind, this.mode, this.options.key));
			});
			this.stopped = true;
			this.gate.close();
			await this.disconnect(true);
			this.stored = void 0;
			this.seen = void 0;
			this.view = {
				mode: this.mode,
				status: "none",
				offered: []
			};
		});
	}
	async guard() {
		const current = this.stored?.providerId ?? this.options.defaultId;
		const refusal = current ? await this.options.refuseReplacing?.(current, this.mode) : void 0;
		if (refusal) throw new Error(refusal);
	}
	/** The connected source, waiting for a connection under way. Throws when there is none. */
	async use() {
		if (!this.provider) await this.ensureReady();
		if (!this.provider || !this.descriptor) throw new Error(this.view.status === "none" ? `No ${this.options.kind === "onchain" ? "Bitcoin" : "Lightning"} source is set up` : this.view.error ?? "The source is still connecting");
		return {
			provider: this.provider,
			descriptor: this.descriptor
		};
	}
	/** A change waiting on its connection gives up now (a creation that took too long); nothing is saved. */
	cutShort() {
		this.gate.interrupt();
	}
	resume() {
		this.gate.resume();
	}
	/** The connected source's id, when one is connected right now. */
	get activeId() {
		return this.provider ? this.descriptor?.id : void 0;
	}
	get active() {
		return this.provider;
	}
	async refresh() {
		clearTimeout(this.timer);
		const provider = this.provider;
		if (!provider) return;
		if (!this.options.refresh) {
			if (!this.view.read) {
				this.view = {
					...this.view,
					read: true
				};
				this.options.changed();
			}
			return;
		}
		const before = this.view;
		try {
			const details = await this.options.refresh(provider);
			if (provider !== this.provider) return;
			this.view = {
				...this.view,
				...details,
				read: true,
				balanceAt: void 0,
				error: void 0
			};
			this.remember(details);
		} catch (error) {
			if (provider !== this.provider) return;
			this.view = {
				...this.view,
				error: `Could not read the balance: ${redact(error, this.secrets)}`
			};
		}
		const after = this.view, was = before;
		if (Object.keys({
			...was,
			...after
		}).some((key) => was[key] !== after[key])) this.options.changed();
		if (this.provider) this.timer = setTimeout(() => void this.refresh(), this.options.refreshMs ?? 15e3);
	}
	/** Keeps the balance read, for the next start: written only when it changed. */
	remember({ balance, unconfirmed }) {
		const providerId = this.descriptor?.id;
		if (!providerId || providerId === this.options.defaultId || balance === void 0 && unconfirmed === void 0) return;
		const was = this.seen;
		if (was?.providerId === providerId && was.balance === balance && was.unconfirmed === unconfirmed) return;
		const seen = {
			providerId,
			balance,
			unconfirmed,
			at: Date.now()
		}, key = seenKey(this.options.kind, this.mode, this.options.key);
		this.seen = seen;
		transact([STORES.settings], (s) => {
			s[STORES.settings].put(seen, key);
		}).catch(() => {});
	}
	/** `forget`: the source is removed, so what it keeps on this device goes too (a provider's own `forget`). */
	async disconnect(forget = false) {
		clearTimeout(this.timer);
		clearTimeout(this.retry);
		this.controller.abort();
		this.controller = new AbortController();
		const provider = this.provider;
		this.provider = void 0;
		this.descriptor = void 0;
		this.secrets = {};
		await (forget && provider?.forget ? provider.forget() : provider?.close())?.catch(() => {});
	}
	/** Shutting down: nothing reconnects afterwards. */
	async stop() {
		this.stopped = true;
		this.gate.close();
		await this.serial(() => this.disconnect());
	}
};
//#endregion
//#region ../browser/src/engine/paymentAdapters/providers/lightningService.ts
var PREFIX = "lightningOp-";
var opKey = (direction, hash) => `${PREFIX}${direction}-${hash}`;
var RANGE = () => IDBKeyRange.bound(PREFIX, `${PREFIX}\uffff`);
/** Every Lightning operation journaled, of every network and card. */
/** Lightning payments whose call to the source has not returned, on any card of this page (WISP 06 § Payments in flight). */
var paying = 0;
var lightningPaying = () => paying;
async function readLightningJournal() {
	return wrap((await store(STORES.settings, "readonly")).getAll(RANGE()));
}
var IN_POLL_MS = 4e3;
var OUT_POLL_MS = 15e3;
var RECENT = 20;
/** Resolved Lightning addresses are kept this long for the amount to be chosen; this many at most. */
var LNURL_TTL_MS = 6e5;
var LNURL_KEPT = 20;
/** A source that cannot tell its fee beforehand gets this ceiling, the same one chat requests are paid under. */
var defaultFeeCap = (amount) => Math.max(10, Math.ceil(amount * .03));
/**
* Lightning of one network: its Lightning card, the invoice a chat request on that network carries and paying a
* contact's invoice on it all come here, and go to this network's active source. The engine has one per network.
*/
var LightningService = class {
	network;
	events;
	options;
	sources;
	quotes = /* @__PURE__ */ new Map();
	mode;
	timer;
	passes = Promise.resolve();
	stopped = false;
	recent = [];
	/** Operations written in this run (`put`): a reconcile pass that wrote one is news, recent or not. */
	writes = 0;
	/** Lightning addresses and LNURLs resolved, until an amount is chosen for them. */
	lnurls = /* @__PURE__ */ new Map();
	constructor(network, descriptors, host, events, defaultId, options = {}) {
		this.network = network;
		this.events = events;
		this.options = options;
		this.mode = network;
		this.sources = new ProviderSources({
			kind: "lightning",
			network,
			descriptors,
			host,
			defaultId,
			key: options.key,
			changed: () => {
				this.schedule(0);
				events.changed();
			},
			refuseReplacing: (providerId, mode) => this.refusal(providerId, mode),
			refresh: async (provider) => provider.capabilities.balance ? { balance: (await provider.info()).balance } : {}
		});
	}
	/** The card this service is, when the network has several. */
	get card() {
		return this.options.card;
	}
	/** Whether a journaled operation went through this card (and this network). */
	owns(op) {
		if (op.mode !== this.mode) return false;
		return this.options.owns ? this.options.owns(op) : op.card === void 0 || op.card === this.options.card;
	}
	get view() {
		return {
			...this.sources.view,
			capabilities: this.sources.active?.capabilities,
			recent: this.recent
		};
	}
	async start() {
		await this.sources.start();
		await this.loadRecent();
	}
	ensureReady() {
		return this.sources.ensureReady();
	}
	async stop() {
		this.stopped = true;
		clearTimeout(this.timer);
		await this.sources.stop();
	}
	refreshOffered() {
		this.sources.refreshOffered();
	}
	async createInvoice(amount, context = {}) {
		const { provider, descriptor } = await this.sources.use();
		if (!provider.capabilities.receive) throw new Error(`${descriptor.label} cannot create invoices`);
		const created = await provider.createInvoice(amount, context.memo ?? "Ghostly");
		const decoded = decodeBolt11(created.invoice);
		if (!decoded || decoded.amountSat !== amount || decoded.paymentHash && decoded.paymentHash !== created.paymentHash || created.amount !== amount) throw new Error(`${descriptor.label} returned an invoice that does not match the request`);
		this.checkNetwork(decoded.network);
		await this.put({
			direction: "in",
			providerId: descriptor.id,
			mode: this.mode,
			...this.cardField(),
			paymentHash: created.paymentHash,
			invoice: created.invoice,
			amount,
			paymentId: context.paymentId,
			ref: created.ref,
			expiresAt: created.expiresAt,
			createdAt: Date.now(),
			selfSettled: !!provider.settlesItself,
			state: "open"
		});
		this.schedule(IN_POLL_MS);
		return {
			...created,
			source: descriptor.id
		};
	}
	/** The Cashu wallet minted the ecash of one of its invoices (it polls its own quotes). */
	async reportInvoicePaid(invoice, context = {}) {
		const hash = decodeBolt11(invoice)?.paymentHash;
		const op = hash ? await this.get("in", hash) : void 0;
		if (op && op.state !== "paid") await this.put({
			...op,
			state: "paid",
			settledAt: Date.now()
		});
		this.events.received({
			paymentId: op?.paymentId ?? context.paymentId,
			providerId: op?.providerId ?? "cashu-mint",
			mint: context.mint
		});
		await this.loadRecent();
		this.events.changed();
	}
	/**
	* Fetches what a Lightning address or LNURL asks for, and keeps it until an amount is chosen. The
	* service's domain learns of the request: the caller says so before asking.
	*/
	async resolveDestination(text) {
		const params = await resolveLightningDestination(text, { fetch: this.options.fetch });
		const now = Date.now();
		for (const [id, entry] of this.lnurls) if (entry.at + LNURL_TTL_MS < now) this.lnurls.delete(id);
		while (this.lnurls.size >= LNURL_KEPT) this.lnurls.delete(this.lnurls.keys().next().value);
		const id = crypto.randomUUID();
		this.lnurls.set(id, {
			params,
			at: now
		});
		const { destination, callbackDomain, minSat, maxSat, description, commentAllowed } = params;
		return {
			id,
			kind: destination.kind,
			text: destination.text,
			domain: destination.domain,
			callbackDomain,
			minSat,
			maxSat,
			description,
			commentAllowed
		};
	}
	/**
	* The invoice for `amountSat` from a resolved destination: checked (the amount, a commitment to what
	* was shown, not expired, a network of this mode) before it is quoted and paid like any other invoice.
	*/
	async destinationInvoice(id, amountSat, comment) {
		const entry = this.lnurls.get(id);
		if (!entry || entry.at + LNURL_TTL_MS < Date.now()) {
			this.lnurls.delete(id);
			throw new Error("That address was resolved too long ago: check it again");
		}
		const { invoice, successAction } = await requestLnurlInvoice(entry.params, amountSat, comment, { fetch: this.options.fetch });
		this.checkNetwork(invoice.network);
		return {
			invoice: invoice.invoice,
			successAction,
			note: entry.params.destination.text
		};
	}
	/** Whether this card resolved that address (the invoice is asked where it was resolved). */
	hasDestination(id) {
		return this.lnurls.has(id);
	}
	/** What paying this invoice costs at most, from the active source. Nothing is spent. */
	async quote(text) {
		const decoded = decodeBolt11(text);
		if (!decoded) throw new Error("That is not a Lightning invoice");
		if (decoded.amountSat === null) throw new Error("Invoices without an amount are not supported");
		if (!decoded.paymentHash) throw new Error("That invoice has no payment hash");
		if (decoded.expiresAt * 1e3 < Date.now()) throw engineError("invoiceExpired");
		this.checkNetwork(decoded.network);
		const { provider, descriptor } = await this.sources.use();
		if (this.mode === "testnet" && decoded.network === "bitcoin" && !(provider instanceof CashuMintLightning)) throw new Error(BITCOIN_INVOICE_ON_TESTNET);
		if (!provider.capabilities.send) throw new Error(`${descriptor.label} cannot pay invoices`);
		const maxFee = provider.estimateFee ? await provider.estimateFee(decoded.invoice, decoded.amountSat) : defaultFeeCap(decoded.amountSat);
		if (!Number.isSafeInteger(maxFee) || maxFee < 0) throw new Error(`${descriptor.label} returned an invalid fee`);
		const id = crypto.randomUUID();
		this.quotes.set(id, {
			providerId: descriptor.id,
			provider,
			invoice: decoded.invoice,
			amount: decoded.amountSat,
			maxFee,
			paymentHash: decoded.paymentHash
		});
		return {
			quote: id,
			mint: (provider instanceof CashuMintLightning ? provider.quoteFor(decoded.invoice)?.mint : void 0) ?? descriptor.id,
			amount: decoded.amountSat,
			feeReserve: maxFee,
			source: descriptor.id
		};
	}
	hasQuote(id) {
		return this.quotes.has(id);
	}
	/**
	* Pays a quote. True once paid; false while in flight or unknown (reconciled in the background, never
	* paid again). Throws only when nothing left the wallet.
	*/
	async pay(quoteId, context = {}) {
		const quote = this.quotes.get(quoteId);
		if (!quote) throw new Error("This quote is no longer valid: check the invoice again");
		if (this.sources.active !== quote.provider) {
			this.quotes.delete(quoteId);
			throw new Error("The Lightning source changed: check the invoice again");
		}
		this.quotes.delete(quoteId);
		const existing = await this.get("out", quote.paymentHash);
		if (existing && existing.state !== "failed") throw new Error(existing.state === "paid" ? "This invoice is already paid" : "This invoice is already being paid");
		let op = {
			direction: "out",
			providerId: quote.providerId,
			mode: this.mode,
			...this.cardField(),
			paymentHash: quote.paymentHash,
			invoice: quote.invoice,
			amount: quote.amount,
			paymentId: context.paymentId,
			note: context.note?.slice(0, 140),
			expiresAt: 0,
			createdAt: Date.now(),
			selfSettled: !!quote.provider.settlesItself,
			state: "sending",
			maxFee: quote.maxFee,
			ref: quote.provider.paymentRef?.(quote.invoice)
		};
		await this.put(op);
		paying += 1;
		try {
			const result = await quote.provider.payInvoice(quote.invoice, quote.maxFee, context.note);
			op = result.state === "paid" ? {
				...op,
				state: "paid",
				fee: result.fee,
				ref: result.ref ?? op.ref,
				settledAt: Date.now()
			} : {
				...op,
				state: "pending",
				ref: result.ref ?? op.ref
			};
		} catch (error) {
			if (isNothingSpentError(error)) {
				await this.put({
					...op,
					state: "failed",
					error: redact(error)
				});
				throw error;
			}
			op = {
				...op,
				state: "unknown",
				error: quote.provider.capabilities.lookup ? "No answer from the source. It is being checked; nothing is paid again." : "No answer from the source, and it cannot be asked: check this payment in the wallet itself. It is never paid again."
			};
		} finally {
			paying -= 1;
		}
		await this.put(op);
		if (op.state !== "paid") this.schedule(OUT_POLL_MS);
		return op.state === "paid";
	}
	/** The Cashu wallet settled a melt it had left pending. */
	async reportPaymentResolved(invoice, paid, context = {}) {
		const hash = decodeBolt11(invoice)?.paymentHash;
		const op = hash ? await this.get("out", hash) : void 0;
		if (op) await this.put({
			...op,
			state: paid ? "paid" : "failed",
			settledAt: Date.now()
		});
		this.events.resolved({
			paymentId: op?.paymentId ?? context.paymentId,
			providerId: op?.providerId ?? "cashu-mint",
			mint: context.mint
		}, paid);
		await this.loadRecent();
		this.events.changed();
	}
	/** Asks the active source about everything of its that is open, pending or unknown. One pass at a time. */
	reconcile() {
		const pass = this.passes.then(() => this.reconcileOnce());
		this.passes = pass.catch(() => {});
		return pass;
	}
	async reconcileOnce() {
		if (this.stopped) return;
		let again = 0;
		const writes = this.writes;
		try {
			const provider = this.sources.active, providerId = this.sources.activeId;
			for (const op of await this.list()) {
				if (!this.owns(op)) continue;
				if (op.selfSettled) {
					if (op.direction !== "out" || op.state !== "unknown") continue;
					if (!provider) {
						again = again || OUT_POLL_MS;
						continue;
					}
					if (op.providerId !== providerId || !provider.interruptedPayment) continue;
					try {
						const outcome = await provider.interruptedPayment({
							invoice: op.invoice,
							paymentHash: op.paymentHash,
							ref: op.ref
						});
						if (outcome === "pending") again = again || OUT_POLL_MS;
						if (outcome !== "paid" && outcome !== "failed") continue;
						if ((await this.get("out", op.paymentHash))?.state !== "unknown") continue;
						await this.put({
							...op,
							state: outcome,
							error: outcome === "failed" ? "The payment did not go through" : void 0,
							settledAt: Date.now()
						});
						this.events.resolved(op, outcome === "paid");
					} catch {
						again = again || OUT_POLL_MS;
					}
					continue;
				}
				if (!(op.direction === "in" ? op.state === "open" : ["pending", "unknown"].includes(op.state))) continue;
				if (!provider || op.providerId !== providerId || !provider.capabilities.lookup) continue;
				try {
					const unchanged = async () => (await this.get(op.direction, op.paymentHash))?.state === op.state;
					if (op.direction === "in") {
						const status = await provider.invoiceStatus({
							invoice: op.invoice,
							paymentHash: op.paymentHash,
							amount: op.amount,
							expiresAt: op.expiresAt,
							ref: op.ref
						});
						if (!await unchanged()) continue;
						if (status.state === "paid") {
							await this.put({
								...op,
								state: "paid",
								settledAt: Date.now()
							});
							this.events.received(op);
						} else if (status.state === "expired" || op.expiresAt + 6e4 < Date.now()) await this.put({
							...op,
							state: "expired"
						});
						else again = again ? Math.min(again, IN_POLL_MS) : IN_POLL_MS;
					} else {
						const status = await provider.paymentStatus({
							invoice: op.invoice,
							paymentHash: op.paymentHash,
							ref: op.ref
						});
						if (status.state === "pending") {
							again = again || OUT_POLL_MS;
							continue;
						}
						if (!await unchanged()) continue;
						await this.put({
							...op,
							state: status.state,
							fee: status.fee ?? op.fee,
							error: status.state === "failed" ? "The payment did not go through" : void 0,
							settledAt: Date.now()
						});
						this.events.resolved(op, status.state === "paid");
					}
				} catch {
					again = again ? Math.min(again, op.direction === "in" ? IN_POLL_MS : OUT_POLL_MS) : op.direction === "in" ? IN_POLL_MS : OUT_POLL_MS;
				}
			}
		} finally {
			if (await this.loadRecent() || this.writes !== writes) this.events.changed();
			if (again) this.schedule(again);
		}
	}
	schedule(ms) {
		if (this.stopped) return;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.reconcile(), ms);
	}
	/** Changing the source is refused while a payment through it has not ended: only it can say how. */
	async refusal(providerId, mode) {
		const open = (await this.list()).filter((op) => op.direction === "out" && !op.selfSettled && op.providerId === providerId && op.mode === mode && this.owns(op) && [
			"sending",
			"pending",
			"unknown"
		].includes(op.state));
		return open.length ? `A Lightning payment through this source has not ended yet (${open.length}). Wait for it before changing the source.` : void 0;
	}
	cardField() {
		return this.options.card === void 0 ? {} : { card: this.options.card };
	}
	/** A Mainnet source refuses an invoice on a test chain. The reverse (test mints use lnbc) is `quote`'s to refuse. */
	checkNetwork(network) {
		if (this.mode === "mainnet" && network !== "bitcoin") throw new Error(`That invoice is for ${network}, a test network: pay it from a Testnet wallet`);
	}
	async get(direction, hash) {
		return wrap((await store(STORES.settings, "readonly")).get(opKey(direction, hash)));
	}
	async put(op) {
		this.writes++;
		await transact([STORES.settings], (s) => {
			s[STORES.settings].put(op, opKey(op.direction, op.paymentHash));
		});
	}
	list() {
		return readLightningJournal();
	}
	/** Crash recovery: a spend journaled as `sending` never got its answer written, so its outcome is unknown. */
	async recover() {
		for (const op of await this.list()) if (op.direction === "out" && op.state === "sending" && this.owns(op)) await this.put({
			...op,
			state: "unknown",
			error: "Interrupted. It is being checked; nothing is paid again."
		});
		this.schedule(0);
	}
	/** True when the recent list reads otherwise than before. */
	async loadRecent() {
		const was = this.recent;
		this.recent = (await this.list()).filter((op) => this.owns(op)).sort((a, b) => b.createdAt - a.createdAt).slice(0, RECENT).map(({ ref: _ref, note: _note, selfSettled: _self, ...view }) => view);
		return JSON.stringify(was) !== JSON.stringify(this.recent);
	}
};
//#endregion
//#region ../browser/src/engine/paymentAdapters/providers/recoveryPhrase.ts
/** A phrase as BIP 39 wants it, however it was typed or pasted. */
var normalizePhrase = (text = "") => text.trim().toLowerCase().split(/\s+/).join(" ");
var isRecoveryPhrase = (text) => validateMnemonic(normalizePhrase(text), wordlist);
//#endregion
//#region ../browser/src/engine/paymentAdapters/providers/lightningCards.ts
/** The card of Lightning through the Cashu mints: at most one per network, shown while the network has mints. */
var CASHU_CARD = "cashu";
/** The card made from the one source a network had before it could have several. */
var LEGACY_CARD = "main";
var cardsKey = (network) => `lightningCards-${network}`;
var NAME_MAX = 32;
/** Short source names for a card's default name ("Alby Hub (NWC)"): the form's label otherwise. */
var SHORT = {
	nwc: "NWC",
	lnd: "LND",
	"core-lightning": "Core Lightning",
	breez: "Breez",
	[CASHU_MINT_SOURCE]: "Cashu",
	fedimint: "Fedimint",
	webln: "WebLN"
};
/**
* The cards of a network, made the first time this version opens it from what an older one kept: the network's one
* source (`lightningSource-<network>`) becomes a card reading that same key, so no secret moves and nothing asks
* again; with no source saved, the network used the Cashu mints, and that is its card. Either becomes the default for
* receiving. Read and written in one transaction; a second run finds the cards and changes nothing. Never reads a
* secret: the source's record names its provider next to its sealed secrets.
*/
async function loadLightningCards(network, label, now = Date.now()) {
	let result;
	await transact([STORES.settings], (stores) => {
		const settings = stores[STORES.settings];
		const saved = settings.get(cardsKey(network));
		saved.onsuccess = () => {
			const found = saved.result;
			if (found?.cards?.length) {
				result = found;
				return;
			}
			const legacy = settings.get(sourceKey("lightning", network));
			legacy.onsuccess = () => {
				const providerId = legacy.result?.providerId;
				const card = typeof providerId === "string" && providerId && providerId !== "cashu-mint" ? {
					id: LEGACY_CARD,
					name: shortName(providerId, label),
					providerId,
					createdAt: now
				} : cashuCard(now);
				result = {
					cards: [card],
					receive: card.id
				};
				settings.put(result, cardsKey(network));
			};
		};
	});
	return result;
}
var cashuCard = (now) => ({
	id: CASHU_CARD,
	name: SHORT[CASHU_MINT_SOURCE],
	providerId: CASHU_MINT_SOURCE,
	key: CASHU_CARD,
	createdAt: now
});
var shortName = (providerId, label) => SHORT[providerId] ?? label(providerId);
/**
* The Lightning cards of one network, each with its own source, balance and journal: "Alby Hub (NWC)", "Home LND",
* the Cashu mints. A payment goes through the card picked for it; a chat request's invoice and Receive come from the
* default for receiving unless another is picked. Adding, removing and renaming are serialized.
*/
var LightningCards = class {
	network;
	options;
	stored = {
		cards: [],
		receive: CASHU_CARD
	};
	services = /* @__PURE__ */ new Map();
	queue = Promise.resolve();
	/** A card being added: a creation that takes too long cuts its connection short. */
	adding;
	stopped = false;
	constructor(network, options) {
		this.network = network;
		this.options = options;
	}
	serial(run) {
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => {});
		return next;
	}
	label = (providerId) => this.options.descriptors().find((d) => d.id === providerId)?.label ?? providerId;
	make(card) {
		return new LightningService(this.network, this.options.descriptors, this.options.host, this.options.events, card.providerId === "cashu-mint" ? CASHU_MINT_SOURCE : void 0, {
			fetch: this.options.fetch,
			card: card.id,
			key: card.key,
			owns: (op) => this.owner(op) === card.id
		});
	}
	starting;
	/** Opens the cards (once: a use before the engine started opens them too). */
	start() {
		return this.starting ??= this.open();
	}
	async open() {
		this.stored = await loadLightningCards(this.network, this.label);
		for (const card of this.stored.cards) {
			const service = this.make(card);
			this.services.set(card.id, service);
			await service.start();
		}
	}
	/**
	* The card an operation went through. One journaled before cards: the Cashu card's when the mints made it, else the
	* card made from the network's one source (none, when that source was replaced before cards: nobody shows it).
	*/
	owner(op) {
		if (op.card !== void 0) return op.card;
		return op.providerId === "cashu-mint" ? CASHU_CARD : LEGACY_CARD;
	}
	/** The cards a person sees: the Cashu card only while the network has mints. In the order they were added. */
	shown() {
		return this.stored.cards.filter((c) => c.id !== "cashu" || this.options.hasMints());
	}
	/** The default for receiving, or the first card shown when that one is not (the Cashu card of a network with no mints). */
	get receivingId() {
		const shown = this.shown();
		return shown.find((c) => c.id === this.stored.receive)?.id ?? shown[0]?.id ?? this.stored.receive;
	}
	get receiving() {
		return this.services.get(this.receivingId) ?? [...this.services.values()][0];
	}
	/** A card by its id; without one, the default for receiving. Throws when it is gone. */
	card(id) {
		if (id === void 0) {
			if (!this.services.size) throw new Error("Lightning is not open yet");
			return this.receiving;
		}
		const service = this.services.get(id);
		if (!service) throw new Error("That Lightning card is gone: pick another");
		return service;
	}
	has(id) {
		return this.services.has(id);
	}
	all() {
		return [...this.services.values()];
	}
	views() {
		const receive = this.receivingId;
		return this.shown().filter((card) => this.services.has(card.id)).map((card) => ({
			...this.services.get(card.id).view,
			card: card.id,
			name: card.name,
			receive: card.id === receive
		}));
	}
	/** The default for receiving's view: what a caller from before cards reads as the network's Lightning. None before start. */
	get view() {
		const card = this.stored.cards.find((c) => c.id === this.receivingId) ?? this.stored.cards[0];
		return card && this.services.has(card.id) ? {
			...this.services.get(card.id).view,
			card: card.id,
			name: card.name,
			receive: true
		} : void 0;
	}
	/** The card holding this quote (each card quotes through its own source). */
	withQuote(quote) {
		return this.all().find((s) => s.hasQuote(quote));
	}
	/**
	* Adds a card with `providerId` and the values of its form: connected and checked first, like any source; only then
	* saved. Nothing is saved when it fails. The same wallet twice (same source, same settings) is refused. A card of the
	* person's own takes receiving over from the mints' card (what a source chosen before cards did); next to another
	* card of their own, the default stays.
	*/
	add(providerId, values) {
		return this.serial(async () => {
			if (providerId === "cashu-mint") {
				if (this.services.has("cashu")) throw new Error("Lightning through your Cashu mints is already a card");
				if (!this.options.hasMints()) throw new Error("Create a Cashu wallet first: this card pays and receives through its mints");
				const card = cashuCard(Date.now());
				const service = this.make(card);
				await service.start();
				await this.save({
					...this.stored,
					cards: [...this.stored.cards, card]
				}, card.id);
				this.services.set(card.id, service);
				service.ensureReady();
				return card.id;
			}
			const id = `ln-${[...crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
			const card = {
				id,
				name: "",
				providerId,
				key: id,
				createdAt: Date.now()
			};
			const service = this.make(card);
			const same = await this.findSame(providerId, values);
			if (same) throw new Error(`That wallet is already your card “${this.stored.cards.find((c) => c.id === same)?.name}”`);
			await service.start();
			this.adding = service;
			try {
				await service.sources.set(providerId, values);
			} catch (error) {
				await service.stop();
				throw error;
			} finally {
				this.adding = void 0;
			}
			card.name = this.freeName(service.view.alias ? `${service.view.alias.slice(0, 20)} (${shortName(providerId, this.label)})` : shortName(providerId, this.label));
			const receive = this.receivingId === "cashu" ? id : this.stored.receive;
			const hidden = this.services.has("cashu") && !this.options.hasMints();
			const cards = [...this.stored.cards.filter((c) => !hidden || c.id !== "cashu"), card];
			try {
				await this.save({
					cards,
					receive
				}, card.id);
			} catch (error) {
				await service.sources.forget().catch(() => {});
				await service.stop();
				throw error;
			}
			this.services.set(id, service);
			if (hidden) {
				const gone = this.services.get(CASHU_CARD);
				this.services.delete(CASHU_CARD);
				await gone.stop();
			}
			return id;
		});
	}
	/** The card that is already this wallet (the same source with the same settings), if one is. Throws what to fix in the form. */
	async findSame(providerId, values) {
		const { settings } = this.receiving.sources.settingsOf(providerId, values);
		for (const [id, service] of this.services) if (await service.sources.holds(providerId, settings)) return id;
	}
	/** A name no other card of the network has: "LND", then "LND 2". */
	freeName(name) {
		const taken = new Set(this.stored.cards.map((c) => c.name.toLowerCase()));
		if (!taken.has(name.toLowerCase())) return name;
		for (let n = 2;; n++) if (!taken.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`;
	}
	/**
	* Removes a card: its source and sealed secrets go (refused while a payment through it has not ended). The default
	* for receiving moves to the first card of the person's own left, else the mints' card. A network left with no card gets the Cashu card back, as before cards.
	*/
	remove(id) {
		return this.serial(async () => {
			const service = this.services.get(id);
			if (!service) throw new Error("That Lightning card is gone");
			await service.sources.forget();
			await service.stop();
			this.services.delete(id);
			let cards = this.stored.cards.filter((c) => c.id !== id);
			let added;
			if (!cards.length) {
				const card = cashuCard(Date.now());
				cards = [card];
				added = this.make(card);
				this.services.set(card.id, added);
				await added.start();
			}
			const shown = cards.filter((c) => c.id !== "cashu" || this.options.hasMints());
			const next = shown.find((c) => c.id !== "cashu") ?? shown[0] ?? cards[0];
			const receive = this.stored.receive === id || !cards.some((c) => c.id === this.stored.receive) ? next.id : this.stored.receive;
			await this.save({
				cards,
				receive
			});
			if (added) added.ensureReady();
		});
	}
	/** Makes a card the network's default for receiving. */
	setReceive(id) {
		return this.serial(async () => {
			if (!this.shown().some((c) => c.id === id)) throw new Error("That Lightning card is gone");
			await this.save({
				...this.stored,
				receive: id
			});
		});
	}
	/** Renames a card: 1 to 32 characters, unique on its network. */
	rename(id, name) {
		return this.serial(async () => {
			const clean = name.replace(/\s+/g, " ").trim();
			if (!clean) throw new Error("Enter a name");
			if (clean.length > NAME_MAX) throw new Error(`At most ${NAME_MAX} characters`);
			if (!this.services.has(id)) throw new Error("That Lightning card is gone");
			if (this.stored.cards.some((c) => c.id !== id && c.name.toLowerCase() === clean.toLowerCase())) throw new Error("Another card has that name");
			await this.save({
				...this.stored,
				cards: this.stored.cards.map((c) => c.id === id ? {
					...c,
					name: clean
				} : c)
			});
		});
	}
	async save(next, receiveIfNone) {
		const shown = next.cards.filter((c) => c.id !== "cashu" || this.options.hasMints());
		const receive = receiveIfNone && !shown.some((c) => c.id === next.receive) ? receiveIfNone : next.receive;
		const stored = {
			cards: next.cards,
			receive
		};
		await transact([STORES.settings], (s) => {
			s[STORES.settings].put(stored, cardsKey(this.network));
		});
		this.stored = stored;
		this.options.events.changed();
	}
	async ownerOf(direction, invoice) {
		const op = (await readLightningJournal()).find((o) => o.direction === direction && o.invoice === invoice && o.mode === this.network);
		const owner = op ? this.owner(op) : CASHU_CARD;
		return owner && this.services.get(owner) || this.services.get("cashu") || this.receiving;
	}
	async reportInvoicePaid(invoice, context = {}) {
		await (await this.ownerOf("in", invoice)).reportInvoicePaid(invoice, context);
	}
	async reportPaymentResolved(invoice, paid, context = {}) {
		await (await this.ownerOf("out", invoice)).reportPaymentResolved(invoice, paid, context);
	}
	resolveDestination(text) {
		return this.receiving.resolveDestination(text);
	}
	destinationInvoice(id, amountSat, comment) {
		return (this.all().find((s) => s.hasDestination(id)) ?? this.receiving).destinationInvoice(id, amountSat, comment);
	}
	list() {
		return readLightningJournal();
	}
	/**
	* What a handoff needs to know of the cards (WISP 06 § Wallets), from their sealed settings: the LND cards that pin a
	* certificate, and each Breez card's database on this device, by wallet id.
	*/
	async handoffFacts() {
		const pinned = [], breez = /* @__PURE__ */ new Map();
		for (const [id, service] of this.services) {
			const wallet = `lightning:${this.network}:${id}`, providerId = service.view.providerId;
			if (providerId === "lnd" && await service.sources.secret("certificate")) pinned.push(wallet);
			if (providerId === "breez") {
				const mnemonic = await service.sources.secret("mnemonic");
				if (mnemonic) breez.set(wallet, await breezDatabaseInUse(this.network === "mainnet" ? "bitcoin" : "regtest", normalizePhrase(mnemonic)));
			}
		}
		return {
			pinned,
			breez
		};
	}
	/** The cards whose source is opened on this device: not one at home on another device (WISP 06 § Wallets that stay home). */
	here() {
		return [...this.services].filter(([id]) => awayFrom(`lightning:${this.network}:${id}`) === void 0).map(([, s]) => s);
	}
	async reconcile() {
		await Promise.all(this.here().map((s) => s.reconcile()));
	}
	async recover() {
		for (const s of this.here()) await s.recover();
	}
	async ensureReady() {
		await Promise.all(this.here().map((s) => s.ensureReady()));
	}
	refreshOffered() {
		for (const s of this.all()) s.refreshOffered();
	}
	wake() {
		for (const s of this.all()) s.sources.wake();
	}
	cutShort() {
		this.adding?.sources.cutShort();
	}
	resume() {
		this.adding?.sources.resume();
	}
	async stop() {
		this.stopped = true;
		for (const s of this.all()) await s.stop();
	}
	get isStopped() {
		return this.stopped;
	}
};
//#endregion
//#region ../browser/src/shared/storedFiles.ts
/** The bytes a file holds: its metadata says, and a file stored before that says it with its Blob. */
function storedSize(file) {
	return file.metadata?.size ?? file.blob?.size ?? 0;
}
/**
* A group's file (WISP 503) that is not here, read from its record: when the engine shows no transfer for it, it waits
* for its person's Download. The engine keeps no view of such a file in the states it builds (one for every file a
* group ever had would go into each of them), so the app's bubble and the CLI read it here. Null for any other file.
*/
function waitingGroupFile(file) {
	if (!file?.group || file.direction !== "in" || file.transfer?.state !== "transferring") return null;
	return {
		state: "transferring",
		stage: "asking",
		transferred: 0,
		size: file.metadata?.size ?? file.transfer.size,
		direction: "in"
	};
}
async function backend(file) {
	return file.bytes ? fileBytesOf(file.bytes) : null;
}
/** At most `length` bytes from `offset`. */
async function readStored(file, offset, length) {
	if (file.blob) return new Uint8Array(await file.blob.slice(offset, offset + length).arrayBuffer());
	const bytes = await backend(file);
	if (!bytes) throw new Error("The file is gone");
	return bytes.read(file.id, offset, length);
}
/** The file, a step at a time, from `offset`. */
async function* streamStored(file, offset = 0) {
	const size = storedSize(file);
	while (offset < size) {
		const part = await readStored(file, offset, Math.min(FILE_BYTES_STEP, size - offset));
		if (!part.length) throw new Error("The file is shorter than it says");
		offset += part.length;
		yield part;
	}
}
/** A file's record and its bytes, wherever they are. */
async function removeStored(id) {
	const file = await fileStore.get(id);
	await fileStore.delete(id);
	if (file?.bytes) await (await backend(file))?.remove(id);
}
/** Writes are gathered to this size before they go to storage: a chunk from the wire is 16 KiB. */
var GATHER = 262144;
/**
* Writes one file in order, gathering small writes into larger ones. `written` counts what was handed over,
* gathered or not; `flush` makes all of it durable.
*/
var FileAppender = class {
	bytes;
	id;
	buffer = new Uint8Array(GATHER);
	buffered = 0;
	stored;
	constructor(bytes, id, offset = 0) {
		this.bytes = bytes;
		this.id = id;
		this.stored = offset;
	}
	get written() {
		return this.stored + this.buffered;
	}
	async append(chunk) {
		if (this.buffered + chunk.length > GATHER) await this.drain();
		if (chunk.length >= GATHER) {
			await this.bytes.append(this.id, this.stored, chunk);
			this.stored += chunk.length;
			return;
		}
		this.buffer.set(chunk, this.buffered);
		this.buffered += chunk.length;
	}
	async drain() {
		if (!this.buffered) return;
		const part = this.buffer.slice(0, this.buffered);
		await this.bytes.append(this.id, this.stored, part);
		this.stored += part.length;
		this.buffered = 0;
	}
	async flush() {
		await this.drain();
		await this.bytes.flush(this.id);
	}
	async close() {
		await this.drain();
		await this.bytes.close(this.id);
	}
};
//#endregion
//#region ../browser/src/shared/types.ts
var WALLET_TYPES = [
	"cashu",
	"lightning",
	"arkade",
	"bark",
	"spark",
	"bitcoin",
	"fedimint",
	"usdt"
];
/** A details record larger than this (as JSON) is trimmed: its oldest sends go first. */
var MESSAGE_DETAILS_MAX_BYTES = 2048;
//#endregion
//#region ../browser/src/engine/paymentAdapters/walletInstances.ts
var WALLET_NAMES = {
	cashu: "Cashu",
	lightning: "Lightning",
	arkade: "Ark",
	bark: "Bark",
	spark: "Spark",
	bitcoin: "Bitcoin",
	fedimint: "Fedimint",
	usdt: "USDT"
};
/** How long a one-click creation waits on its server before it gives up, saving nothing (tests shorten it). */
var createTiming = { timeoutMs: 6e4 };
/**
* The wallets a profile has, read from both networks' views: one per type and network, in the deck's order, and one
* per Lightning card. A wallet exists once it holds something to open (a seed, a source, a mint); Lightning through
* the Cashu mints comes with that network's Cashu wallet.
*/
function walletInstances(networks) {
	const list = [];
	for (const type of WALLET_TYPES) for (const network of WALLET_NETWORKS) {
		if (type === "lightning") {
			list.push(...lightningInstances(network, networks[network]));
			continue;
		}
		const config = instanceConfig(type, networks[network]);
		if (config) list.push({
			id: `${type}:${network}`,
			type,
			network,
			config
		});
	}
	return list;
}
/** A network's Lightning cards (a view from before cards: its one source, as one card). */
function lightningInstances(network, view) {
	return (view.lightnings ?? (view.lightning ? [{
		...view.lightning,
		card: view.lightning.providerId === "cashu-mint" || !view.lightning.providerId ? "cashu" : "main",
		name: "",
		receive: true
	}] : [])).flatMap((ln) => {
		if (!ln.providerId || ln.providerId === "cashu-mint" && !view.mints.length) return [];
		return [{
			id: `lightning:${network}:${ln.card}`,
			type: "lightning",
			network,
			config: {
				providerId: ln.providerId,
				label: ln.label ?? ""
			},
			card: ln.card,
			name: ln.name || ln.label || "Lightning",
			receive: ln.receive
		}];
	});
}
function instanceConfig(type, view) {
	const text = (value) => typeof value === "string" ? value : "";
	switch (type) {
		case "cashu": return view.mints.length ? {
			mint: view.mints[0].url,
			mints: String(view.mints.length)
		} : void 0;
		case "lightning": return;
		case "arkade": return view.ark?.configured ? {
			chain: text(view.ark.network),
			provider: text(view.ark.provider)
		} : void 0;
		case "bark": return view.bark?.configured ? {
			chain: text(view.bark.network),
			provider: text(view.bark.provider)
		} : void 0;
		case "spark": return view.spark?.configured ? { chain: text(view.spark.network) } : void 0;
		case "bitcoin": return view.bitcoin?.providerId ? {
			providerId: view.bitcoin.providerId,
			label: text(view.bitcoin.label)
		} : void 0;
		case "fedimint": return view.fedimint?.federations.length ? { federations: String(view.fedimint.federations.length) } : void 0;
		case "usdt": return view.usdt?.configured ? {
			chain: text(view.usdt.network),
			provider: text(view.usdt.provider)
		} : void 0;
	}
}
/** For each way of paying, the networks this profile has a wallet on: what every chat tells its contact. */
function paymentNetworksOf(wallets) {
	const networks = {};
	for (const wallet of wallets) {
		const method = wallet.type;
		networks[method] = [.../* @__PURE__ */ new Set([...networks[method] ?? [], wallet.network])];
	}
	return networks;
}
/**
* The network of a payment or a request: written on it since wallets have their own, else read from what it
* carries (a target's chain, a mint, an invoice's chain). A test mint's invoice looks like a Bitcoin one; its
* mints say Testnet.
*/
function paymentNetwork(payment) {
	if (payment.network) return payment.network;
	if (payment.target) return payment.target.method === "cashu" ? mintNetwork(payment.target.provider) : walletNetworkOf(payment.target.network);
	const mint = payment.mints?.[0] ?? payment.mint;
	if (mint) return mintNetwork(mint);
	const decoded = payment.invoice ? decodeBolt11(payment.invoice) : null;
	return decoded && decoded.network !== "bitcoin" ? "testnet" : "mainnet";
}
/** The refusal when a card of one network would pay for the other: test coins and real money never meet. */
var crossNetwork = (card, asked) => card === asked ? `This is a ${networkLabel(asked)} payment (${asked === "mainnet" ? "real money" : "test coins"}): a ${networkLabel(card)} wallet never pays it. Use a ${networkLabel(asked)} wallet.` : engineText(asked === "mainnet" ? "mainnetPaymentOnTestnet" : "testnetPaymentOnMainnet");
/**
* Real money goes out only once the person confirmed it as real money ("Send real money"), whatever screen asked:
* a spend RPC on Mainnet without `confirmedReal` is refused before anything is spent. Test coins need no second step.
*/
function assertConfirmedReal(network, confirmedReal) {
	if (network === "mainnet" && confirmedReal !== true) throw new Error(REAL_MONEY_UNCONFIRMED);
}
var REAL_MONEY_UNCONFIRMED = engineText("realMoneyUnconfirmed");
/** One clear message for a creation that failed: nothing was saved, and trying again is safe. */
function createFailure(label, error) {
	return `Could not create the ${label} wallet: ${(networkReason(error) ?? (error instanceof Error ? error.message : String(error))).replace(/\.$/, "")}. Nothing was saved; try again.`;
}
//#endregion
//#region ../browser/src/shared/paymentIds.ts
/**
* Payment ids are chosen by whoever sends them, and every member of a group sees the requests the others make to the
* group. So a contact's request is kept under the id it came with, unless a record of another chat already holds that
* id: then under `<id>.<chat>`. A `.` is never in a payment id on the wire (8 to 64 of `A-Z a-z 0-9 _ -`), so no
* contact can name another's record, and two contacts' requests never share one.
*/
var paymentAlias = (wireId, linkId) => `${wireId}.${linkId}`;
/** The id a payment record goes by on the wire, which is also the one its chat and its group's notes know it by. */
var paymentWireId = (key) => key.split(".", 1)[0];
//#endregion
//#region ../browser/src/shared/replies.ts
/** A paired chat's text (`me_`/`peer_` + its 22-character wire id), or a held file (`peer_` + its 16-character one). */
var PAIRED_ROW = /^(?:me|peer)_([A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{16})$/;
var WIRE_ID = /^[A-Za-z0-9_-]{8,64}$/;
var GROUP_LINK = "group:";
/**
* The id a message of a chat goes by on both sides, which a reply names; none for what only this side has (a notice,
* a group payment line, a refused payment). A paired chat: the text's wire id, a payment's id, a file's wire id. A
* group: the message id, which is the same for every member.
*/
function replyRef(message, group = message.linkId?.startsWith(GROUP_LINK) ?? false) {
	if (message.ref) return message.ref;
	if (group) return message.paymentId || message.event || message.groupPay || !message.id.includes(":") ? void 0 : message.id;
	if (message.paymentId) return paymentWireId(message.paymentId);
	if (message.wireId && WIRE_ID.test(message.wireId)) return message.wireId;
	const out = message.file?.id.match(/-out-([A-Za-z0-9_-]{8,64})$/);
	if (out) return out[1];
	const row = message.id.match(PAIRED_ROW);
	return row && !/^\d+$/.test(row[1]) ? row[1] : void 0;
}
/** A reply to `original` as this side keeps it: always found, since it is here. The engine's row, or the UI's copy. */
function replyTo(original, ref) {
	return {
		id: ref,
		snippet: replySnippet(original.text),
		from: original.sender === "me" ? "me" : "peer",
		...original.member && { member: original.member },
		messageId: original.id
	};
}
/**
* A reply as it goes on a paired chat's wire, from the side that sends it (`f`: who wrote the original, from the
* sender's side). For a group, `f` is the author's member key, which the reply keeps.
*/
function pairedWireReply(reply, sender = "me") {
	return {
		i: reply.id,
		s: reply.snippet,
		f: reply.from === sender ? "sender" : "recipient",
		...reply.button && { b: reply.button }
	};
}
/** A paired chat's reply as it arrived (`f` from the sender's side), as this side keeps it. */
function receivedPairedReply(reply) {
	if (!("f" in reply)) return {
		id: reply.i,
		snippet: ""
	};
	return {
		id: reply.i,
		snippet: reply.s,
		from: reply.f === "sender" ? "peer" : "me",
		...reply.b && { button: reply.b }
	};
}
/** A group's reply as it arrived or was sent (`f` the author's member key), as this member keeps it. */
function groupReply(reply, myKey) {
	return {
		id: reply.i,
		snippet: reply.s,
		from: reply.f === myKey ? "me" : "peer",
		member: reply.f,
		...reply.b && { button: reply.b }
	};
}
//#endregion
//#region ../browser/src/engine/groupFiles.ts
/** A group file's local id: its group's and a random part, never anything a member sends. */
var groupFileId = (groupId, direction, random = toBase64Url(randomBytes(12))) => `group-${groupId}-${direction}-${random}`;
/** The group a local file id names, among `groupIds`. */
var groupOfFile = (fileId, groupIds) => [...groupIds].find((g) => fileId.startsWith(`group-${g}-in-`) || fileId.startsWith(`group-${g}-out-`));
/** What a file's message says: its caption, or (when the author wrote none) the file itself, not the line older apps show. */
var groupFileText = (text, meta) => text === groupFileFallback(meta) ? fileMessageText(meta) : text;
/** The profile's files store and file storage, as a 1:1 chat's files use them. */
var storedGroupFiles = {
	list: (groupId) => fileStore.listForLink(`group:${groupId}`),
	groups: () => fileStore.groupIds(),
	get: (id) => fileStore.get(id),
	put: (file) => fileStore.put(file),
	patch: (id, fields) => fileStore.patch(id, fields),
	remove: (id) => removeStored(id),
	async write(id, resume = false) {
		const stored = await fileStore.get(id);
		const bytes = stored?.bytes && await fileBytesOf(stored.bytes) || await fileBytes();
		const size = await bytes.size(id);
		const offset = resume && size !== null ? size : 0;
		if (size !== null && size !== offset) await bytes.truncate(id, offset);
		if (stored && stored.bytes !== bytes.kind) await fileStore.patch(id, { bytes: bytes.kind });
		const appender = new FileAppender(bytes, id, offset);
		return {
			offset,
			append: (chunk) => appender.append(chunk),
			flush: () => appender.flush(),
			digest: async () => {
				await appender.close();
				return bytes.digest(id);
			},
			close: () => appender.close(),
			discard: async () => {
				await appender.close().catch(() => {});
				await bytes.remove(id);
			}
		};
	},
	read: (file, offset, length) => readStored(file, offset, length),
	room: async () => (await fileBytes()).room()
};
/**
* Ended transfers an edge keeps the record of. A late frame for one of them is still answered as files/3 says (an abort
* to an asker going on with a transfer cancelled here); older ones are forgotten, so an edge's records stay few
* however many transfers it has seen.
*/
var ENDED_KEPT = 8;
/** Why a want waits, as the person reads it (the app shows its own words for each `wait`). */
var WAITING_NOTES = {
	nobody: "Nobody you are connected to has this file yet",
	busy: "Its holders are busy; asking again soon",
	damaged: "It arrived damaged; ask again"
};
/** Why a want stopped: every holder served bytes that are not the author's file. */
var DAMAGED = "Every copy of this file arrived damaged and was deleted. Ask for it again later.";
var GroupFileDesk = class {
	deps;
	kept = /* @__PURE__ */ new Map();
	/** `<group>\n<message id>` → local id. */
	byMessage = /* @__PURE__ */ new Map();
	wants = /* @__PURE__ */ new Map();
	/**
	* The want last asked on each edge (by link id), and its file: whether a file is asked of an edge's member is read here,
	* not by going through every want each time (`askedOf`). An entry the want has moved on from is dropped when read.
	*/
	askedOn = /* @__PURE__ */ new Map();
	edgesById = /* @__PURE__ */ new Map();
	/** My file about to be announced, by `<group>\n<digest>`: the message that announces it takes this local id. */
	own = /* @__PURE__ */ new Map();
	/** Announcements sent per group, and taken per member of a group (WISP 503 § Rules for both, Pace). */
	sentPace = /* @__PURE__ */ new Map();
	sentTaken = /* @__PURE__ */ new Map();
	takenPace = /* @__PURE__ */ new Map();
	/** `<group>\n<message id>` a `group-have` named before its message came → its holders, newest first. */
	ahead = /* @__PURE__ */ new Map();
	/** A community's ids for its next `group-have`, and when one last went. */
	communityHave = /* @__PURE__ */ new Map();
	/** Bytes served today, and the day (UTC days since the epoch). */
	served = {
		day: 0,
		bytes: 0
	};
	constructor(deps) {
		this.deps = deps;
	}
	/**
	* At start: each group's files as they were kept. One fetched by itself, or asked for, and not here yet is asked for
	* again; with automatic downloads off, one chosen by itself before waits for a Download instead.
	*/
	async load(groupIds) {
		for (const groupId of groupIds) for (const file of await this.deps.store.list(groupId).catch(() => [])) {
			if (!file.group || !file.metadata || !file.digest || this.kept.has(file.id)) continue;
			const { name, size, mime, voice, video, image } = file.metadata;
			const kept = {
				id: file.id,
				groupId,
				message: file.group.message,
				author: file.group.author,
				meta: {
					name,
					size,
					mime,
					d: file.digest,
					...voice && { voice },
					...video && { video },
					...image && { image }
				},
				mine: file.direction === "out",
				auto: !!file.group.auto,
				asked: !!file.group.asked,
				held: file.transfer?.state === "done",
				holders: [],
				damaged: /* @__PURE__ */ new Set()
			};
			this.add(kept);
			if (kept.held) continue;
			if (file.transfer?.state === "failed") this.show(kept, {
				state: "failed",
				transferred: 0,
				size,
				direction: "in",
				retry: true,
				error: file.transfer.error ?? DAMAGED
			});
			else if (file.group.paused) {
				kept.paused = true;
				kept.stored = await this.keptBytes(kept.id);
				this.show(kept, {
					state: "transferring",
					stage: "paused",
					pausedBy: "me",
					transferred: kept.stored,
					size,
					direction: "in"
				});
			} else if (kept.asked || kept.auto && this.deps.settings().autoDownloads) this.wants.set(kept.id, this.newWant());
			else if (kept.auto) await this.stop(kept, false);
		}
		for (const [id] of this.wants) this.ask(this.kept.get(id));
		this.deps.changed();
	}
	/**
	* At start, once every group was read: the files of a group this device no longer has (`groupIds` are the groups it
	* has, a tombstone or a join under way among them) go, with their bytes. A group left before Leave took its files
	* left them behind, where nothing lists them.
	*/
	async sweep(groupIds) {
		const here = new Set(groupIds);
		for (const groupId of await this.deps.store.groups().catch(() => [])) {
			if (here.has(groupId)) continue;
			for (const file of await this.deps.store.list(groupId).catch(() => [])) await this.deps.store.remove(file.id).catch(() => {});
		}
	}
	/**
	* The person stops a file that is coming, or that this device would fetch (Cancel, Decline): nobody is asked for it
	* any more, the transfer under way ends, what came of it is deleted, and it waits for a Download. Paused (`keep`),
	* what came stays, and Resume (`download`) goes on from there.
	*/
	async halt(fileId, keep = false) {
		const kept = this.kept.get(fileId);
		if (!kept) throw new Error("No such file");
		if (keep && !this.wants.has(fileId)) return;
		await this.stop(kept, keep);
	}
	/** Automatic downloads were turned off: files chosen by themselves and not here yet stop coming, and wait for a Download. */
	async autoDownloadsOff() {
		for (const kept of [...this.kept.values()]) if (kept.auto && !kept.asked && this.wants.has(kept.id)) await this.stop(kept, false);
	}
	async stop(kept, keep) {
		if (kept.held || kept.mine) return;
		const want = this.wants.get(kept.id);
		this.wants.delete(kept.id);
		const edge = want?.wire && want.linkId ? this.edgesById.get(want.linkId) : void 0;
		const record = edge?.files.get("in", want.wire);
		const { size } = kept.meta;
		const failed = !keep && this.deps.transfers.get(kept.id)?.state === "failed";
		if (!keep) {
			kept.stored = 0;
			kept.fresh = true;
		}
		if (edge && record && !transferEnded(record)) {
			if (!keep) kept.dropped = record.id;
			edge.files.cancel("in", record.id);
			edge.taking.delete(record.id);
		} else if (!keep) kept.idle = (kept.idle ?? Promise.resolve()).then(() => this.deps.store.write(kept.id)).then((writer) => writer.discard()).catch(() => {});
		if (keep) this.show(kept, {
			state: "transferring",
			stage: "paused",
			pausedBy: "me",
			transferred: kept.stored ?? 0,
			size,
			direction: "in"
		});
		else this.waiting(kept);
		const wasPaused = !!kept.paused;
		kept.paused = keep;
		if (kept.auto || kept.asked || wasPaused !== keep || failed) {
			kept.auto = kept.asked = false;
			await this.deps.store.patch(kept.id, {
				group: this.groupField(kept),
				...failed && { transfer: {
					state: "transferring",
					transferred: 0,
					size
				} }
			}).catch(() => {});
		}
	}
	/**
	* An error when this group took as many announcements of mine as it takes in a minute, or as its members take from
	* one member in `announceWindowMs` (past that they would not fetch the file by themselves); null when one may go now.
	*/
	mayAnnounce(groupId) {
		const wait = Math.max(...this.sentPaces(groupId).map((pace) => pace.wait()));
		if (!wait) return null;
		const minutes = Math.ceil(wait / 6e4);
		return `You sent many files to this group just now. Wait ${minutes > 1 ? `${minutes} minutes` : "a minute"}.`;
	}
	/** My file, stored under `fileId` with the author's digest, is about to be announced in the group: its message takes it. */
	outgoing(groupId, fileId, meta) {
		this.own.set(`${groupId}\n${meta.d}`, fileId);
	}
	/** The announcement did not go: the file is not this group's after all. */
	notSent(groupId, meta) {
		this.own.delete(`${groupId}\n${meta.d}`);
	}
	/**
	* A message of the group announces a file (mine, or a member's): the file its row shows. A member's is kept here
	* unfetched, and fetched now when it is one this device takes by itself and the member announced no more than the
	* group fetches that way. The same message again (a catch-up, a whole copy) is the same file.
	*/
	async announced(groupId, m, me) {
		const known = this.byMessage.get(`${groupId}\n${m.id}`);
		if (known) return messageFile(this.kept.get(known));
		const ownId = m.sender === me ? this.own.get(`${groupId}\n${m.file.d}`) : void 0;
		if (ownId) {
			this.own.delete(`${groupId}\n${m.file.d}`);
			for (const pace of this.sentPaces(groupId)) pace.take();
			const kept = {
				id: ownId,
				groupId,
				message: m.id,
				author: me,
				meta: m.file,
				mine: true,
				auto: false,
				asked: false,
				held: true,
				holders: [],
				damaged: /* @__PURE__ */ new Set()
			};
			this.add(kept);
			const transfer = {
				state: "done",
				transferred: m.file.size,
				size: m.file.size
			};
			await this.deps.store.patch(ownId, {
				group: {
					message: m.id,
					author: me
				},
				transfer
			}).catch(() => {});
			this.finished(kept, "out");
			this.queueHave(kept);
			return messageFile(kept);
		}
		const paced = this.pace(this.takenPace, `${groupId}\n${m.sender}`, GROUP_FILE_LIMITS.announceTaken, GROUP_FILE_LIMITS.announceWindowMs).take();
		const id = groupFileId(groupId, "in");
		const auto = paced && this.deps.settings().autoDownloads && fetchesByItself(m.file, this.keptAutomatically(groupId));
		const holders = this.ahead.get(`${groupId}\n${m.id}`) ?? [];
		this.ahead.delete(`${groupId}\n${m.id}`);
		const kept = {
			id,
			groupId,
			message: m.id,
			author: m.sender,
			meta: m.file,
			mine: false,
			auto,
			asked: false,
			held: false,
			holders,
			damaged: /* @__PURE__ */ new Set()
		};
		const { name, size, mime, voice, video, image } = m.file;
		this.add(kept);
		await this.deps.store.put({
			id,
			linkId: `group:${groupId}`,
			direction: "in",
			digest: m.file.d,
			createdAt: this.deps.now(),
			metadata: {
				name,
				size,
				mime,
				timestamp: this.deps.now(),
				voice,
				video,
				image
			},
			transfer: {
				state: "transferring",
				transferred: 0,
				size
			},
			group: {
				message: m.id,
				author: m.sender,
				...auto && { auto: true }
			}
		});
		if (auto) {
			this.wants.set(id, this.newWant());
			this.ask(kept);
		} else this.waiting(kept);
		return messageFile(kept);
	}
	/** The person asks for a file this device did not fetch by itself (Download), or for one that stopped coming. */
	async download(fileId) {
		const kept = this.kept.get(fileId);
		if (!kept) throw new Error("No such file");
		if (kept.held) return;
		const room = await this.deps.store.room().catch(() => null);
		if (room !== null && kept.meta.size > room) throw new Error("Not enough space on this device for this file");
		if (!kept.asked || kept.paused) {
			kept.asked = true;
			kept.paused = false;
			await this.deps.store.patch(kept.id, { group: this.groupField(kept) }).catch(() => {});
		}
		kept.damaged.clear();
		if (this.deps.transfers.get(kept.id)?.state === "failed") await this.deps.store.patch(kept.id, { transfer: {
			state: "transferring",
			transferred: 0,
			size: kept.meta.size
		} }).catch(() => {});
		const want = this.wants.get(kept.id);
		if (!want) this.wants.set(kept.id, this.newWant());
		else if (!want.wire) {
			want.tried.clear();
			want.why = want.busy = void 0;
		}
		this.ask(kept);
	}
	/** The group is gone from this device: its files go too. */
	async drop(groupId) {
		for (const kept of [...this.kept.values()].filter((k) => k.groupId === groupId)) {
			this.kept.delete(kept.id);
			this.byMessage.delete(`${groupId}\n${kept.message}`);
			this.wants.delete(kept.id);
			this.deps.transfers.delete(kept.id);
			await kept.writing?.catch(() => {});
			await this.deps.store.remove(kept.id).catch(() => {});
		}
		for (const [linkId, edge] of this.edgesById) if (edge.groupId === groupId) {
			edge.files.detach();
			this.edgesById.delete(linkId);
		}
		for (const key of [...this.ahead.keys()]) if (key.startsWith(`${groupId}\n`)) this.ahead.delete(key);
		this.communityHave.delete(groupId);
		this.deps.changed();
	}
	/** An edge's files/3 session opened (both sides agreed it) or closed. */
	session(groupId, peer, linkId, open) {
		const edge = this.edge(groupId, peer, linkId);
		if (open) edge.files.attach();
		else edge.files.detach();
		edge.gone.clear();
		if (open) this.retry(groupId);
	}
	/** An edge came up and both sides said where they are: what this device holds goes to it, and wants waiting for a holder go. */
	edgeReady(groupId, peer, linkId) {
		if (!this.deps.ready(linkId)) return;
		const edge = this.edge(groupId, peer, linkId);
		if (this.deps.settings().serveFiles) {
			const held = [...this.kept.values()].filter((k) => k.groupId === groupId && k.held).map((k) => k.message).slice(-GROUP_FILE_LIMITS.haveIds);
			if (held.length) this.sendHave(edge, held);
		}
		this.retry(groupId);
	}
	/** A `group-want`, `group-want-no` or `group-have` on an edge, from the member it is pinned to. */
	async frame(groupId, peer, linkId, frame) {
		if (frame.t === "group-want") {
			const want = readGroupWant(frame, groupId);
			if (want) await this.serve(this.edge(groupId, peer, linkId), want.id);
		} else if (frame.t === "group-want-no") {
			const no = readGroupWantNo(frame, groupId);
			if (no) this.refused(groupId, peer, linkId, no.id, no.why);
		} else if (frame.t === "group-have") {
			const ids = readGroupHave(frame, groupId);
			if (ids && this.edge(groupId, peer, linkId).haveTaken.take()) this.heard(groupId, peer, ids);
		}
	}
	/** A community's `group-have`, an application frame its signer sent the group. */
	communityApp(groupId, sender, frame) {
		const ids = readGroupHave(frame);
		if (ids) this.heard(groupId, sender, ids);
	}
	/**
	* A files/3 frame on an edge. An offer is taken only for a file this device asked that member for (`gm` naming the
	* message): nobody can push a file into another's storage. What it brings belongs to the group's message, not to the
	* edge as a chat.
	*/
	filesFrame(groupId, peer, linkId, frame) {
		const edge = this.edge(groupId, peer, linkId);
		if (frame.t === "pf-offer" && typeof frame.id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(frame.id) && !edge.taking.has(frame.id)) {
			const kept = isGroupMessageId(frame.gm) ? this.kept.get(this.byMessage.get(`${groupId}\n${frame.gm}`) ?? "") : void 0;
			const want = kept && this.wants.get(kept.id);
			if (!kept || kept.held || !want || want.linkId !== linkId || want.wire) {
				this.deps.sendFiles(linkId, {
					t: "pf-refuse",
					id: frame.id,
					why: "invalid"
				});
				return Promise.resolve();
			}
			edge.taking.set(frame.id, kept.id);
			kept.holders = newestHolder(peer, kept.holders);
			want.wire = frame.id;
			want.why = void 0;
			want.movedAt = this.deps.now();
		}
		return edge.files.handle(frame);
	}
	/** Wants that waited too long for an offer, or for bytes, go to the next holder; `group-have`s gathered go. */
	tick() {
		const now = this.deps.now();
		for (const [id, want] of this.wants) {
			const kept = this.kept.get(id);
			if (!kept) {
				this.wants.delete(id);
				continue;
			}
			if (now - (want.wire ? want.movedAt : want.at) < GROUP_FILE_LIMITS.wantWaitMs) continue;
			if (want.wire) {
				const edge = want.linkId ? this.edgesById.get(want.linkId) : void 0;
				if (edge?.files.get("in", want.wire) && !transferEnded(edge.files.get("in", want.wire))) {
					edge.files.cancel("in", want.wire);
					continue;
				}
				want.wire = void 0;
			}
			if (want.holder) want.tried.add(want.holder);
			else {
				want.tried.clear();
				want.why = want.busy = void 0;
			}
			this.ask(kept);
		}
		this.letGo();
		for (const edge of this.edgesById.values()) if (edge.have.size && this.deps.ready(edge.linkId)) this.sendHave(edge, [...edge.have]);
		for (const [groupId, have] of this.communityHave) {
			if (!have.ids.size || now - have.at < GROUP_FILE_LIMITS.communityHaveEveryMs) continue;
			const ids = [...have.ids].slice(-GROUP_FILE_LIMITS.haveIds);
			have.ids.clear();
			have.at = now;
			this.deps.sendApp(groupId, {
				t: GROUP_HAVE_FRAME,
				ids
			}).catch(() => {});
		}
	}
	newWant() {
		return {
			at: this.deps.now(),
			tried: /* @__PURE__ */ new Set(),
			moved: 0,
			movedAt: 0
		};
	}
	/**
	* Wants of this group that wait for a holder: asked now (an edge came up or freed, or a member said it holds
	* something). One queued behind an edge's file is asked only while an edge of the group is free to take it, and free
	* for it (`freeFor`): once every edge has a file asked of it, or the free ones are of members it already asked, it would
	* only queue again. So a file that ends asks the few wants it frees an edge for, not every want waiting (a member back
	* from away with hundreds of files to fetch asked each of them once per file, more so with a member in the group that
	* holds none of them, or serves none).
	*/
	retry(groupId) {
		let free;
		for (const [id, want] of this.wants) {
			const kept = this.kept.get(id);
			if (kept?.groupId !== groupId || want.holder) continue;
			if (this.deps.transfers.get(id)?.stage === "queued" && !this.freeFor(kept, want, free ??= this.freeEdges(groupId))) continue;
			this.ask(kept);
			free = void 0;
		}
	}
	/** The group's edges that are up, with files/3 live and no file asked of their member: a want could be asked on them. */
	freeEdges(groupId) {
		return [...this.deps.edges(groupId)].filter(([, linkId]) => this.deps.ready(linkId) && this.edgesById.get(linkId)?.files.live && !this.askedOf(linkId));
	}
	/** One of these free edges (member key, link id) is one `ask` would ask this want on: asked now, it would not only queue again. */
	freeFor(kept, want, free) {
		const membership = this.deps.membership(kept.groupId);
		if (!membership) return false;
		const known = this.knownHolders(kept, membership);
		const others = !this.waitForKnown(kept, want, known, this.deps.edges(kept.groupId));
		return free.some(([key, linkId]) => this.mayAsk(kept, want, key, linkId) && (known.includes(key) || others && key !== membership.me && membership.couldRead(key, kept.message)));
	}
	/** The members known to hold the file (its author first), in the group's roster, but this device. */
	knownHolders(kept, membership) {
		return [kept.author, ...kept.holders.filter((key) => key !== kept.author)].filter((key) => membership && key !== membership.me && membership.inRoster(key));
	}
	/**
	* A known holder that answered busy, or the author whose edge another file of this device's is asked of, its edge up,
	* serves when its place frees: the others are asked only when no known holder is worth waiting for (none in reach, or
	* every one gone), as after a restart here. Only the author's edge holds them back while it is asked of: any member
	* can say it holds files, and one that serves the file asked of it slowly would keep every other file it named here.
	*/
	waitForKnown(kept, want, known, edges) {
		return known.some((key) => {
			const linkId = edges.get(key) ?? "";
			return this.deps.ready(linkId) && (want.busy?.has(key) || key === kept.author && this.askedOf(linkId, want));
		});
	}
	/** The want may ask this member in this round: not asked yet, it did not serve it damaged, and did not say it is gone. */
	mayAsk(kept, want, key, linkId) {
		return !want.tried.has(key) && !kept.damaged.has(key) && !this.edgesById.get(linkId ?? "")?.gone.has(kept.message);
	}
	/**
	* Asks the next holder for a file: the author first while its edge is up, then the holders whose edge is up, then every
	* other member whose edge is up and that could read its message. Who holds what is heard, not kept: a holder names few
	* of its files to an edge that opens, and none it was told of is known after a restart here, so a member in reach is
	* asked whether or not it said so (one that does not hold it answers `gone`, and is not asked again). Only over an
	* edge this device has. (A private group past 16 members, or a community, reaches a holder it has no edge with
	* over a file session of the two members, WISP 503 § The file session; that session is not built yet, so such a
	* holder is not asked, and the file waits for one that is reachable.)
	*/
	ask(kept) {
		const want = this.wants.get(kept.id);
		if (!want || kept.held || want.wire) return;
		const membership = this.deps.membership(kept.groupId);
		const edges = this.deps.edges(kept.groupId);
		const known = this.knownHolders(kept, membership);
		if (known.length && known.every((key) => kept.damaged.has(key))) {
			this.stopDamaged(kept);
			return;
		}
		const others = this.waitForKnown(kept, want, known, edges) ? [] : [...edges.keys()].filter((key) => !known.includes(key) && membership && key !== membership.me && membership.couldRead(key, kept.message));
		const order = [...known, ...others].filter((key) => this.mayAsk(kept, want, key, edges.get(key)));
		let behind = false;
		for (const key of order) {
			const linkId = edges.get(key);
			if (!linkId || !this.deps.ready(linkId) || !this.edgesById.get(linkId)?.files.live) continue;
			if (this.askedOf(linkId, want)) {
				behind = true;
				continue;
			}
			Object.assign(want, {
				holder: key,
				linkId,
				at: this.deps.now()
			});
			this.askedOn.set(linkId, {
				id: kept.id,
				want
			});
			if (!this.deps.send(linkId, {
				t: "group-want",
				g: kept.groupId,
				id: kept.message
			})) {
				want.tried.add(key);
				continue;
			}
			if (want.holder === key) this.show(kept, {
				state: "transferring",
				stage: "queued",
				transferred: kept.stored ?? 0,
				size: kept.meta.size,
				direction: "in"
			});
			return;
		}
		Object.assign(want, {
			holder: void 0,
			linkId: void 0,
			at: this.deps.now()
		});
		if (behind) {
			this.show(kept, {
				state: "transferring",
				stage: "queued",
				transferred: kept.stored ?? 0,
				size: kept.meta.size,
				direction: "in"
			});
			return;
		}
		const wait = want.why ?? "nobody";
		this.show(kept, {
			state: "transferring",
			stage: "waiting",
			transferred: kept.stored ?? 0,
			size: kept.meta.size,
			direction: "in",
			wait,
			note: WAITING_NOTES[wait],
			...wait === "damaged" && { stalled: true }
		});
	}
	/**
	* Another file is asked of, or coming from, the member at the other end of this edge. A want gets its edge only in
	* `ask`, which notes it in `askedOn`, and one edge has one want at a time: the want noted there is it, while it still
	* waits and is still on that edge.
	*/
	askedOf(linkId, except) {
		const on = this.askedOn.get(linkId);
		if (!on || on.want === except) return false;
		if (on.want.linkId === linkId && this.wants.get(on.id) === on.want) return true;
		this.askedOn.delete(linkId);
		return false;
	}
	/** No holder serves the author's bytes: the want stops, and stays stopped after a restart, until Download. */
	stopDamaged(kept) {
		this.wants.delete(kept.id);
		const { size } = kept.meta;
		this.deps.store.patch(kept.id, { transfer: {
			state: "failed",
			transferred: 0,
			size,
			error: DAMAGED
		} }).catch(() => {});
		this.show(kept, {
			state: "failed",
			transferred: 0,
			size,
			direction: "in",
			retry: true,
			error: DAMAGED
		});
	}
	/** A holder's no: the next one is asked. One that deleted the file is no holder any more. */
	refused(groupId, peer, linkId, messageId, why) {
		const kept = this.kept.get(this.byMessage.get(`${groupId}\n${messageId}`) ?? "");
		const want = kept && this.wants.get(kept.id);
		if (!kept || !want || want.linkId !== linkId || want.wire) return;
		if (why === "gone") {
			kept.holders = kept.holders.filter((key) => key !== peer);
			this.edgesById.get(linkId)?.gone.add(messageId);
		}
		if (why === "busy") {
			want.why = "busy";
			(want.busy ??= /* @__PURE__ */ new Set()).add(peer);
		}
		want.tried.add(peer);
		want.holder = want.linkId = void 0;
		this.ask(kept);
		this.retry(groupId);
	}
	/** A member says it holds these files: remembered as a holder of each (newest first), and asked when a want waits. */
	heard(groupId, from, ids) {
		const membership = this.deps.membership(groupId);
		if (!membership || from === membership.me || !membership.inRoster(from)) return;
		const newest = (holders) => newestHolder(from, holders);
		const edge = this.edgesById.get(this.deps.edges(groupId).get(from) ?? "");
		let free;
		for (const message of ids) {
			const key = `${groupId}\n${message}`, kept = this.kept.get(this.byMessage.get(key) ?? "");
			if (!kept) {
				this.ahead.set(key, newest(this.ahead.get(key) ?? []));
				if (this.ahead.size > GROUP_FILE_LIMITS.heardAhead) this.ahead.delete(this.ahead.keys().next().value);
				continue;
			}
			if (kept.mine) continue;
			kept.holders = newest(kept.holders);
			edge?.gone.delete(message);
			const want = this.wants.get(kept.id);
			if (!want) continue;
			want.tried.delete(from);
			want.busy?.delete(from);
			if (want.holder) continue;
			if (this.deps.transfers.get(kept.id)?.stage === "queued" && !this.freeFor(kept, want, free ??= this.freeEdges(groupId).filter(([key]) => key === from))) continue;
			this.ask(kept);
			free = void 0;
		}
	}
	/** A member asks for a file: offered over files/3 on its edge, or a `group-want-no` saying why not. */
	async serve(edge, messageId) {
		const kept = this.kept.get(this.byMessage.get(`${edge.groupId}\n${messageId}`) ?? "");
		const here = !!kept?.held && !!await this.deps.store.get(kept.id).catch(() => void 0);
		const why = this.mayServe(edge, messageId, here ? kept : void 0);
		if (why || !kept) {
			this.deps.send(edge.linkId, {
				t: GROUP_WANT_NO_FRAME,
				g: edge.groupId,
				id: messageId,
				why: why ?? "gone"
			});
			return;
		}
		const wire = toBase64Url(randomBytes(12));
		edge.serving.set(wire, kept.id);
		edge.servedMoved.set(wire, {
			confirmed: 0,
			at: this.deps.now()
		});
		const { name, mime, size, voice, video, image } = kept.meta;
		const file = {
			id: wire,
			name,
			mime,
			size,
			timestamp: this.deps.now(),
			...voice && { voice },
			...video && { video },
			...image && { image }
		};
		edge.files.offer(file, kept.meta.d);
	}
	/**
	* Why this device does not serve a file now, or null when it does (WISP 503 § Asking, Serving limits): `refused` to
	* someone who could not read the announcement, `gone` when it is not here (`kept` undefined), `busy` when serving is
	* off or full.
	*/
	mayServe(edge, messageId, kept) {
		const membership = this.deps.membership(edge.groupId);
		if (!membership || !membership.couldRead(edge.peer, messageId)) return "refused";
		if (!kept) return "gone";
		if (!this.deps.settings().serveFiles || !edge.files.live) return "busy";
		this.letGo();
		const active = this.servingNow();
		if (active.length >= GROUP_FILE_LIMITS.serveAtOnce) {
			edge.busy.add(messageId);
			return "busy";
		}
		const theirs = active.filter((a) => a.peer === edge.peer);
		if (theirs.length > 1 || theirs.some((a) => a.sending || this.deps.now() - a.since >= GROUP_FILE_LIMITS.doneWaitMs)) return "busy";
		const today = Math.floor(this.deps.now() / 864e5);
		if (this.served.day !== today) this.served = {
			day: today,
			bytes: 0
		};
		const reserved = active.reduce((sum, a) => sum + a.size, 0);
		return this.served.bytes + reserved + kept.meta.size > GROUP_FILE_LIMITS.serveBytesPerDay ? "busy" : null;
	}
	/**
	* Transfers served now, all groups together: to whom, what each takes of the day (its size, or what it sent when that
	* is more), whether bytes are still to go, and since when it has not gone further.
	*/
	servingNow() {
		const active = [];
		for (const edge of this.edgesById.values()) for (const wire of edge.serving.keys()) {
			const record = edge.files.get("out", wire);
			if (record && !transferEnded(record)) active.push({
				peer: edge.peer,
				size: Math.max(record.file.size, edge.files.sent(wire)),
				sending: record.confirmed < record.file.size,
				since: edge.servedMoved.get(wire)?.at ?? this.deps.now()
			});
		}
		return active;
	}
	/**
	* An asker has a served transfer send parts again (WISP 503 § Serving limits): every byte sent counts toward the day,
	* so it goes on only while the day has room for it.
	*/
	mayResend() {
		const today = Math.floor(this.deps.now() / 864e5);
		if (this.served.day !== today) this.served = {
			day: today,
			bytes: 0
		};
		return this.served.bytes + this.servingNow().reduce((sum, a) => sum + a.size, 0) < GROUP_FILE_LIMITS.serveBytesPerDay;
	}
	/**
	* Served transfers that no longer count end, their places free for others (WISP 503 § Serving limits): the asker's
	* session closed, it is not in the roster any more, its bytes have not gone further for `wantWaitMs` (the asker has
	* moved on by then), or it has all its bytes and the member's next want has overtaken its word for `doneWaitMs`.
	*/
	letGo() {
		const now = this.deps.now();
		const theirs = /* @__PURE__ */ new Map();
		for (const a of this.servingNow()) theirs.set(a.peer, (theirs.get(a.peer) ?? 0) + 1);
		for (const edge of this.edgesById.values()) for (const wire of [...edge.serving.keys()]) {
			const record = edge.files.get("out", wire);
			if (!record || transferEnded(record)) continue;
			let moved = edge.servedMoved.get(wire);
			if (!moved) edge.servedMoved.set(wire, moved = {
				confirmed: record.confirmed,
				at: now
			});
			const gone = !edge.files.live || !this.deps.membership(edge.groupId)?.inRoster(edge.peer);
			const overtaken = record.confirmed === record.file.size && theirs.get(edge.peer) > 1 && now - moved.at >= GROUP_FILE_LIMITS.doneWaitMs;
			if (gone || overtaken || now - moved.at >= GROUP_FILE_LIMITS.wantWaitMs) {
				edge.files.cancel("out", wire);
				theirs.set(edge.peer, theirs.get(edge.peer) - 1);
			}
		}
	}
	/**
	* Says on an edge which files this device holds, as many frames as the edge takes now (`haveFrames` in
	* `haveWindowMs`); the ids past that, and those of a frame that could not go, wait for the next tick with room.
	*/
	sendHave(edge, ids) {
		for (const id of ids) edge.have.add(id);
		for (let i = 0; i < ids.length; i += GROUP_FILE_LIMITS.haveIds) {
			const frame = ids.slice(i, i + GROUP_FILE_LIMITS.haveIds);
			if (edge.haveSent.wait() || !this.deps.send(edge.linkId, {
				t: "group-have",
				g: edge.groupId,
				ids: frame
			})) return;
			edge.haveSent.take();
			for (const id of frame) edge.have.delete(id);
		}
	}
	/**
	* This device holds a new file: the group hears it with the next `group-have`, which gathers what there is to say
	* until the next tick.
	*/
	queueHave(kept) {
		if (!this.deps.settings().serveFiles) return;
		if (this.deps.membership(kept.groupId)?.community) {
			let have = this.communityHave.get(kept.groupId);
			if (!have) this.communityHave.set(kept.groupId, have = {
				ids: /* @__PURE__ */ new Set(),
				at: 0
			});
			have.ids.add(kept.message);
			return;
		}
		for (const [key, linkId] of this.deps.edges(kept.groupId)) this.edge(kept.groupId, key, linkId).have.add(kept.message);
	}
	edge(groupId, peer, linkId) {
		const known = this.edgesById.get(linkId);
		if (known) return known;
		const edge = {
			linkId,
			groupId,
			peer,
			files: void 0,
			serving: /* @__PURE__ */ new Map(),
			servedMoved: /* @__PURE__ */ new Map(),
			taking: /* @__PURE__ */ new Map(),
			ended: [],
			have: /* @__PURE__ */ new Set(),
			haveSent: new RateWindow(GROUP_FILE_LIMITS.haveFrames, GROUP_FILE_LIMITS.haveWindowMs, () => this.deps.now()),
			haveTaken: new RateWindow(GROUP_FILE_LIMITS.haveFrames, GROUP_FILE_LIMITS.haveWindowMs, () => this.deps.now()),
			busy: /* @__PURE__ */ new Set(),
			gone: /* @__PURE__ */ new Set()
		};
		edge.files = new ChatFiles({
			send: (frame) => {
				const kept = frame.t === "pf-offer" ? this.kept.get(edge.serving.get(frame.id) ?? "") : void 0;
				return this.deps.sendFiles(linkId, kept ? {
					...frame,
					gm: kept.message
				} : frame);
			},
			decide: (file) => this.decide(edge, file),
			openTarget: (record) => this.openTarget(edge, record),
			openSource: (record) => this.openSource(edge, record),
			changed: (record, transferred) => this.transferChanged(edge, record, transferred),
			room: () => this.deps.store.room(),
			...this.deps.sendData && { sendData: (id, offset, data) => this.deps.sendData(linkId, id, offset, data) },
			writable: () => this.deps.writable?.(linkId),
			resend: (record) => !edge.serving.has(record.id) || this.mayResend()
		});
		this.edgesById.set(linkId, edge);
		return edge;
	}
	/** An offer that answers my want (`filesFrame` checked that): taken, unless it is not the file announced or there is no room. */
	async decide(edge, file) {
		const kept = this.kept.get(edge.taking.get(file.id) ?? ""), want = kept && this.wants.get(kept.id);
		if (!kept || kept.held || want?.linkId !== edge.linkId || want.wire !== file.id || file.size !== kept.meta.size) return { refuse: "invalid" };
		const room = await this.deps.store.room().catch(() => null);
		return room !== null && file.size > room ? {
			refuse: "no-room",
			room
		} : "accept";
	}
	async openTarget(edge, record) {
		const kept = this.kept.get(edge.taking.get(record.id) ?? "");
		if (!kept) throw new Error("No such file");
		await kept.idle;
		const writer = await this.deps.store.write(kept.id, !kept.fresh);
		kept.fresh = false;
		const resumed = writer.offset > 0;
		if (!resumed) kept.storedBy = edge.peer;
		else if (kept.storedBy !== edge.peer) kept.storedBy = void 0;
		let damaged = false;
		const gone = () => this.kept.get(kept.id) !== kept;
		const write = async (op) => {
			if (gone()) {
				await writer.discard();
				throw new Error("No such file");
			}
			return await (kept.writing = op());
		};
		return {
			offset: writer.offset,
			append: (bytes) => write(() => writer.append(bytes)),
			flush: () => write(() => writer.flush()),
			verify: async () => {
				damaged = await write(() => writer.digest()) !== kept.meta.d;
				const want = this.wants.get(kept.id);
				if (damaged && want) want.why = "damaged";
				return !damaged;
			},
			discard: () => {
				if (damaged) {
					kept.stored = 0;
					if (resumed && kept.storedBy !== edge.peer) kept.fresh = kept.unclear = true;
					else kept.damaged.add(edge.peer);
					kept.storedBy = void 0;
				}
				return kept.idle = (damaged || kept.dropped === record.id || gone() ? writer.discard() : writer.close()).catch(() => {});
			}
		};
	}
	async openSource(edge, record) {
		const kept = this.kept.get(edge.serving.get(record.id) ?? "");
		const stored = kept && await this.deps.store.get(kept.id);
		if (!kept || !stored) throw new Error("The file is gone");
		return {
			read: (offset, length) => this.deps.store.read(stored, offset, length),
			digest: async () => kept.meta.d
		};
	}
	/** A transfer on the edge ended: its record stays among the last `ENDED_KEPT`, and the oldest past that is forgotten. */
	transferOver(edge, record) {
		if (edge.ended.some(([direction, id]) => direction === record.direction && id === record.id)) return;
		edge.ended.push([record.direction, record.id]);
		while (edge.ended.length > ENDED_KEPT) edge.files.forget(...edge.ended.shift());
	}
	transferChanged(edge, record, transferred) {
		if (transferEnded(record)) this.transferOver(edge, record);
		if (record.direction === "out") {
			const moved = edge.servedMoved.get(record.id);
			if (moved && record.confirmed > moved.confirmed) edge.servedMoved.set(record.id, {
				confirmed: record.confirmed,
				at: this.deps.now()
			});
			if (transferEnded(record) && edge.serving.has(record.id)) {
				const today = Math.floor(this.deps.now() / 864e5);
				if (this.served.day !== today) this.served = {
					day: today,
					bytes: 0
				};
				this.served.bytes += edge.files.sent(record.id);
				edge.serving.delete(record.id);
				edge.servedMoved.delete(record.id);
				const serving = this.deps.settings().serveFiles;
				for (const other of this.edgesById.values()) {
					if (serving) for (const id of other.busy) other.have.add(id);
					other.busy.clear();
				}
			}
			return;
		}
		const kept = this.kept.get(edge.taking.get(record.id) ?? ""), want = kept && this.wants.get(kept.id);
		if (!kept || !want || want.wire !== record.id || want.linkId !== edge.linkId) return;
		if (transferred !== want.moved) {
			want.moved = transferred;
			want.movedAt = this.deps.now();
		}
		if (record.state !== "failed" && record.state !== "declined" && record.state !== "cancelled") kept.stored = transferred;
		const { size } = kept.meta;
		switch (record.state) {
			case "done":
				kept.held = true;
				this.wants.delete(kept.id);
				edge.taking.delete(record.id);
				this.deps.store.patch(kept.id, { transfer: {
					state: "done",
					transferred: size,
					size
				} }).catch(() => {});
				this.finished(kept, "in");
				this.queueHave(kept);
				this.retry(kept.groupId);
				return;
			case "failed":
			case "declined":
			case "cancelled":
				edge.taking.delete(record.id);
				if (want.holder && !kept.unclear) want.tried.add(want.holder);
				kept.unclear = false;
				Object.assign(want, {
					wire: void 0,
					holder: void 0,
					linkId: void 0,
					moved: 0
				});
				this.ask(kept);
				this.retry(kept.groupId);
				return;
			case "verifying":
				this.show(kept, {
					state: "transferring",
					stage: "verifying",
					transferred,
					size,
					direction: "in"
				});
				return;
			default: this.show(kept, {
				state: "transferring",
				transferred,
				size,
				direction: "in"
			});
		}
	}
	add(kept) {
		this.kept.set(kept.id, kept);
		this.byMessage.set(`${kept.groupId}\n${kept.message}`, kept.id);
	}
	/** Bytes this device fetched by itself from the group and keeps (or is fetching): what `autoBytesPerGroup` bounds. */
	keptAutomatically(groupId) {
		let sum = 0;
		for (const kept of this.kept.values()) if (kept.groupId === groupId && kept.auto && !kept.mine) sum += kept.meta.size;
		return sum;
	}
	groupField(kept) {
		return {
			message: kept.message,
			author: kept.author,
			...kept.auto && { auto: true },
			...kept.asked && { asked: true },
			...kept.paused && { paused: true }
		};
	}
	/** The bytes of a file kept here from transfers that did not finish. */
	async keptBytes(id) {
		const writer = await this.deps.store.write(id, true).catch(() => void 0);
		if (!writer) return 0;
		await writer.close().catch(() => {});
		return writer.offset;
	}
	pace(windows, key, limit, ms) {
		let window = windows.get(key);
		if (!window) windows.set(key, window = new RateWindow(limit, ms, () => this.deps.now()));
		return window;
	}
	/** My announcements in a group, in a minute and in the window the members count them over. */
	sentPaces(groupId) {
		return [this.pace(this.sentPace, groupId, GROUP_FILE_LIMITS.announcePerMinute, 6e4), this.pace(this.sentTaken, groupId, GROUP_FILE_LIMITS.announceTaken, GROUP_FILE_LIMITS.announceWindowMs)];
	}
	/**
	* The file waits for its person's Download: said in one state (the CLI's `file.offered`), then left to its record,
	* which says it is not here (`waitingGroupFile`). A view kept for each such file would go into every state the engine
	* builds, so each would cost more with every file the groups ever had.
	*/
	waiting(kept) {
		this.show(kept, {
			state: "transferring",
			stage: "asking",
			transferred: 0,
			size: kept.meta.size,
			direction: "in"
		});
		this.deps.brief(kept.id);
	}
	/**
	* All here: said in one state (the CLI's `file.done`), then left to its record, which says it is done. A view kept for
	* each file fetched or sent would go into every state the engine builds until the next start.
	*/
	finished(kept, direction) {
		this.show(kept, {
			state: "done",
			transferred: kept.meta.size,
			size: kept.meta.size,
			direction
		});
		this.deps.brief(kept.id);
	}
	/** A file's row shows `view`; the engine hears of it only when that is not what the row shows already. */
	show(kept, view) {
		if (sameView(this.deps.transfers.get(kept.id), view)) return;
		this.deps.transfers.set(kept.id, view);
		this.deps.changed();
	}
};
/** Two views of a transfer that say the same: their fields are all plain values. */
function sameView(a, b) {
	if (!a) return false;
	const keys = /* @__PURE__ */ new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const key of keys) if (a[key] !== b[key]) return false;
	return true;
}
/** A file's holders with `key` the newest of them, the `holders` newest kept. */
var newestHolder = (key, holders) => [key, ...holders.filter((other) => other !== key)].slice(0, GROUP_FILE_LIMITS.holders);
function messageFile(kept) {
	const { name, size, mime, voice, video, image } = kept.meta;
	return {
		id: kept.id,
		name,
		size,
		mime,
		...voice && { voice },
		...video && { video },
		...image && { image }
	};
}
//#endregion
export { setSingleWriterGate as $, LightningCards as A, breezDatabaseInUse as B, FileAppender as C, streamStored as D, storedSize as E, ProviderSources as F, ModeChanged as G, dropBreezDatabase as H, sourceKey as I, networkLabel as J, ModeGate as K, CASHU_MINT_SOURCE as L, isRecoveryPhrase as M, normalizePhrase as N, waitingGroupFile as O, lightningPaying as P, setAwayWallets as Q, cashuMint as R, WALLET_TYPES as S, removeStored as T, iceServerProblem as U, breezDatabasesFor as V, iceServerSetting as W, refuseAway as X, awayFrom as Y, requireTurn as Z, crossNetwork as _, storedGroupFiles as a, walletInstances as b, receivedPairedReply as c, paymentAlias as d, paymentWireId as f, createTiming as g, createFailure as h, groupOfFile as i, cardsKey as j, CASHU_CARD as k, replyRef as l, assertConfirmedReal as m, groupFileId as n, groupReply as o, WALLET_NAMES as p, WrongNetworkError as q, groupFileText as r, pairedWireReply as s, GroupFileDesk as t, replyTo as u, paymentNetwork as v, readStored as w, MESSAGE_DETAILS_MAX_BYTES as x, paymentNetworksOf as y, breezDatabase as z };

//# sourceMappingURL=groupFiles-Mii-eKSf.js.map