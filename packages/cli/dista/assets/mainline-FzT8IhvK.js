import { bl as publicKeyFromZ32, gl as parseRelayPayload, ll as isDiscoveryBudgetError, ml as newerPacket, rl as RelayTransport } from "./src-dfGE33hw.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createHash } from "node:crypto";
import DHT from "bittorrent-dht";
//#region src/runtime/mainline.ts
var SIGNATURE = 64;
var TIMESTAMP = 8;
var verify = (sig, message, key) => {
	try {
		return ed25519.verify(sig, message, key);
	} catch {
		return false;
	}
};
/** A DHT node of this process: puts and gets Pkarr packets. */
var Mainline = class {
	dht;
	/** Its UDP socket is bound. */
	listening;
	timeoutMs;
	constructor(options = {}) {
		this.timeoutMs = options.timeoutMs ?? 2e4;
		const bootstrap = options.bootstrap === false ? false : options.bootstrap?.length ? options.bootstrap : void 0;
		this.dht = new DHT({
			verify,
			...bootstrap !== void 0 ? { bootstrap } : {},
			...options.host ? { host: options.host } : {}
		});
		this.listening = new Promise((resolve) => this.dht.listen(0, options.host, () => resolve()));
		this.dht.on("error", () => {});
	}
	/** Adds a node (a testnet's peers). */
	addNode(host, port) {
		this.dht.addNode({
			host,
			port
		});
	}
	address() {
		return this.dht.address();
	}
	/** Puts a relay payload (`<signature><timestamp><DNS packet>`) as the mutable item of `pubKeyZ32`; resolves with the nodes that took it. */
	put(pubKeyZ32, payload) {
		const k = Buffer.from(publicKeyFromZ32(pubKeyZ32));
		const sig = Buffer.from(payload.subarray(0, SIGNATURE));
		const seq = Number(new DataView(payload.buffer, payload.byteOffset + SIGNATURE, TIMESTAMP).getBigUint64(0));
		const v = Buffer.from(payload.subarray(72));
		return this.bounded(new Promise((resolve, reject) => {
			this.dht.put({
				k,
				v,
				seq,
				sig
			}, (error, _hash, nodes) => {
				if (error) reject(error);
				else if (!nodes) reject(/* @__PURE__ */ new Error("No DHT node took the packet"));
				else resolve(nodes);
			});
		}));
	}
	/** The newest packet of `pubKeyZ32` the DHT holds, checked; null when nobody has one. */
	get(pubKeyZ32) {
		const k = Buffer.from(publicKeyFromZ32(pubKeyZ32));
		const target = createHash("sha1").update(k).digest();
		return this.bounded(new Promise((resolve, reject) => {
			this.dht.get(target, { cache: false }, (error, found) => {
				if (error) return reject(error);
				if (!found?.v || !found.sig) return resolve(null);
				const timestamp = new Uint8Array(TIMESTAMP);
				new DataView(timestamp.buffer).setBigUint64(0, BigInt(found.seq));
				const payload = new Uint8Array(72 + found.v.length);
				payload.set(found.sig, 0);
				payload.set(timestamp, SIGNATURE);
				payload.set(found.v, 72);
				try {
					resolve(parseRelayPayload(pubKeyZ32, payload));
				} catch {
					resolve(null);
				}
			});
		}));
	}
	bounded(work) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(/* @__PURE__ */ new Error("DHT lookup timed out")), this.timeoutMs);
			work.then((value) => {
				clearTimeout(timer);
				resolve(value);
			}, (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
	}
	destroy() {
		return new Promise((resolve) => this.dht.destroy(() => resolve()));
	}
};
/**
* The relays first, as the web app reaches Pkarr (its contacts read only the relays), and the DHT beside them: every
* packet also goes to the DHT, and a read goes there when every relay is failing or the read failed for anything but
* this app's own request budget (that is a wait, not an outage).
*
* `pinned`: the relays given are the only ones (`GHOSTLY_PKARR_RELAYS`, a private network): the profile's `relays`
* setting does not replace them. With no DHT (`dht` null), the relays alone carry every packet.
*/
var RelaysAndDht = class {
	dht;
	pinned;
	relays;
	lastVia = "relay";
	constructor(dht, relays = {}, pinned = false) {
		this.dht = dht;
		this.pinned = pinned;
		this.relays = new RelayTransport(relays);
	}
	async publish(identity, records, options = {}) {
		await this.relays.publishDated(identity, records, (key, payload, timestamp, conflict) => this.putBoth(key, payload, options, conflict, timestamp), options, false, this.dht !== null);
	}
	publishPayload(pubKeyZ32, payload, options = {}) {
		return this.putBoth(pubKeyZ32, payload, options);
	}
	/**
	* `timestamp`: the payload was just signed here (`publish`), dated so; its signature is not checked again on the way
	* to the relays. Without it (`publishPayload`, signed elsewhere) the relays' side checks it to read its date.
	*/
	async putBoth(pubKeyZ32, payload, options, conflict, timestamp) {
		const toRelays = () => timestamp === void 0 ? this.relays.publishPayload(pubKeyZ32, payload, options, conflict) : this.relays.putSigned(pubKeyZ32, payload, timestamp, options, conflict);
		if (!this.dht) return toRelays();
		const onDht = this.dht.put(pubKeyZ32, payload);
		onDht.catch(() => {});
		try {
			await toRelays();
		} catch (error) {
			if (isDiscoveryBudgetError(error)) throw error;
			await onDht.catch(() => {
				throw error;
			});
		}
	}
	async resolve(pubKeyZ32, options = {}) {
		if (!this.dht) return this.relays.resolve(pubKeyZ32, options);
		let fromRelays = null, failed = null;
		const down = () => this.relays.discovery().relays.every((relay) => relay.state === "failing");
		if (!down()) {
			try {
				fromRelays = await this.relays.resolve(pubKeyZ32, options);
				this.lastVia = "relay";
			} catch (error) {
				if (isDiscoveryBudgetError(error)) throw error;
				failed = error;
			}
			if (!failed && !down()) return fromRelays;
		}
		try {
			const fromDht = await this.dht.get(pubKeyZ32);
			this.lastVia = "dht";
			if (fromDht) this.relays.sawTimestamp(pubKeyZ32, fromDht.timestampMicros);
			return newerPacket(fromRelays, fromDht);
		} catch (error) {
			if (fromRelays) return fromRelays;
			throw failed ?? error;
		}
	}
	describe() {
		return {
			protocol: this.dht ? "Pkarr relays (HTTP), and the Mainline DHT (BEP44) directly" : "Pkarr relays (HTTP)",
			relays: this.relays.describe().relays
		};
	}
	discovery() {
		const status = this.relays.discovery();
		return this.lastVia === "dht" ? {
			...status,
			path: { via: "dht" }
		} : status;
	}
	subscribe(listener) {
		return this.relays.subscribe(listener);
	}
	/** A relay's answer only: a packet the DHT hands back when the relays are down may be older than one already read. */
	readAnsweredAt(pubKeyZ32) {
		return this.relays.readAnsweredAt(pubKeyZ32);
	}
	readHeldBackFor(pubKeyZ32) {
		return this.relays.readHeldBackFor(pubKeyZ32);
	}
	onServerTime(listener) {
		return this.relays.onServerTime(listener);
	}
	configure({ relays }) {
		if (!this.pinned) this.relays.setRelays(relays);
	}
};
//#endregion
export { Mainline, RelaysAndDht };

//# sourceMappingURL=mainline-FzT8IhvK.js.map