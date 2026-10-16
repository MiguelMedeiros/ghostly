import { Tl as fromBase64Url } from "./src-dfGE33hw.js";
import { t as hyperdhtRelayProblem } from "./hyperdhtRelay-BT_wRxab.js";
import { ed25519 } from "@noble/curves/ed25519.js";
//#region ../browser/src/platform/hyperdhtRelay.ts
/**
* HyperDHT (WISP 103) for a browser, through a dht-relay: a server that runs the UDP half of HyperDHT and
* talks to the browser over one WebSocket. It runs non-custodial: the browser keeps its keys, runs the
* Noise handshake and the encrypted stream itself, and the relay moves handshake messages and ciphertext.
* The binding (the handshake hash and both keys) is computed here, at the endpoint, as the Desktop does.
*
* What the relay sees: this browser's address, the HyperDHT keys it listens on and dials, and when and how
* much it sends. Not the frames, not the keys' secrets, not the handshake hash.
*
* The wire is the Desktop's (native/transports/hyperdht/endpoint.mjs): the same preface, u32 length-prefixed
* UTF-8 frames of at most 60 KiB, so a browser and a Desktop talk HyperDHT to each other.
*/
var PREFACE = "ghostly/paired-chat/1";
var MAX_FRAME = 61440;
/** The top bit of a frame's length word: the frame is a binary message, not UTF-8 text (WISP 103). */
var BINARY = 2147483648;
var SEND_BUDGET = 122880;
var HANDSHAKE_MS = 2e4;
var RELAY_OPEN_MS = 1e4;
var LISTEN_MS = 2e4;
var MAX_CHANNELS = 2;
/**
* How the relay client is always made: never custodial. dht-relay's default is custodial, which sends every
* secret key to the relay so it can run the handshake and the stream itself. Nothing here takes this from
* settings or options; test/hyperdhtRelay.test.ts fails if a secret key ever reaches the relay's wire.
*/
var NON_CUSTODIAL = Object.freeze({ custodial: false });
var hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
var fromHex = (text) => Uint8Array.from(text.match(/../g), (byte) => parseInt(byte, 16));
/** HyperDHT's key pair for a seed: libsodium's layout (the seed, then the public key). */
function hyperKeyPair(seed) {
	if (seed.length !== 32) throw new Error("Invalid HyperDHT seed");
	const publicKey = ed25519.getPublicKey(seed);
	const secretKey = /* @__PURE__ */ new Uint8Array(64);
	secretKey.set(seed);
	secretKey.set(publicKey, 32);
	return {
		publicKey,
		secretKey
	};
}
var clients = /* @__PURE__ */ new Map();
async function relayClient(url, createSocket) {
	const existing = clients.get(url);
	if (existing) {
		const client = await existing.catch(() => null);
		if (client && !client.gone) return client;
		if (clients.get(url) === existing) clients.delete(url);
	}
	const opening = (async () => {
		const [{ default: RelayedDHT }, { default: WebSocketStream }] = await Promise.all([import("@hyperswarm/dht-relay"), import("@hyperswarm/dht-relay/ws")]);
		const socket = createSocket(url);
		socket.binaryType = "arraybuffer";
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				socket.close();
				reject(/* @__PURE__ */ new Error("The HyperDHT relay did not answer"));
			}, RELAY_OPEN_MS);
			socket.addEventListener("open", () => {
				clearTimeout(timer);
				resolve();
			}, { once: true });
			socket.addEventListener("error", () => {
				clearTimeout(timer);
				reject(/* @__PURE__ */ new Error("Could not reach the HyperDHT relay"));
			}, { once: true });
			socket.addEventListener("close", () => {
				clearTimeout(timer);
				reject(/* @__PURE__ */ new Error("The HyperDHT relay closed the connection"));
			}, { once: true });
		});
		const node = new RelayedDHT(new WebSocketStream(true, socket), {
			...NON_CUSTODIAL,
			keyPair: hyperKeyPair(crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(32)))
		});
		let closed;
		const client = {
			node,
			endpoints: /* @__PURE__ */ new Set(),
			gone: false,
			closed: new Promise((resolve) => {
				closed = resolve;
			})
		};
		socket.addEventListener("close", () => {
			client.gone = true;
			closed();
			if (clients.get(url) === opening) clients.delete(url);
			for (const endpoint of [...client.endpoints]) endpoint.unavailable();
		});
		return client;
	})();
	clients.set(url, opening);
	opening.catch(() => {
		if (clients.get(url) === opening) clients.delete(url);
	});
	return opening;
}
function release(url, client, endpoint) {
	client.endpoints.delete(endpoint);
	if (client.endpoints.size || client.gone) return;
	client.gone = true;
	clients.get(url)?.then((current) => {
		if (current === client) clients.delete(url);
	}).catch(() => {});
	client.node.destroy().catch(() => {});
}
/** One authenticated stream as a frame channel, with a bounded queue before the session installs its reader. */
var RelayedChannel = class {
	socket;
	reader = null;
	buffered = [];
	closed = false;
	pendingBytes = 0;
	/** It carries binary messages (WISP 100 § Text and binary messages), as the Desktop's own HyperDHT does. */
	binary = true;
	onClose = null;
	constructor(socket) {
		this.socket = socket;
		socket.on("drain", () => {
			this.pendingBytes = 0;
		});
	}
	get bufferedAmount() {
		return this.pendingBytes;
	}
	sendBudget = SEND_BUDGET;
	get onMessage() {
		return this.reader;
	}
	set onMessage(reader) {
		this.reader = reader;
		if (reader) for (const text of this.buffered.splice(0)) reader(text);
	}
	receive(text) {
		if (this.closed) return true;
		if (this.reader) this.reader(text);
		else if (this.buffered.length < 64) this.buffered.push(text);
		else return false;
		return true;
	}
	send(data) {
		if (this.closed || !data.length) throw new Error("Native channel is closed or exceeds its frame budget");
		const binary = typeof data !== "string";
		const payload = binary ? data : new TextEncoder().encode(data);
		if (payload.length > MAX_FRAME || this.pendingBytes + payload.length > SEND_BUDGET) throw new Error("Native channel is closed or exceeds its frame budget");
		if (!writeFrame(this.socket, payload, binary) || this.pendingBytes) this.pendingBytes += payload.length + 4;
	}
	drained() {
		if (!this.pendingBytes) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const done = () => {
				this.socket.off("close", gone);
				resolve();
			};
			const gone = () => {
				this.socket.off("drain", done);
				reject(/* @__PURE__ */ new Error("Native channel closed"));
			};
			this.socket.once("drain", done);
			this.socket.once("close", gone);
		});
	}
	closedByPeer() {
		if (this.closed) return;
		this.closed = true;
		this.buffered = [];
		this.onClose?.();
	}
	close() {
		if (this.closed) return;
		this.socket.destroy();
		this.closedByPeer();
	}
};
function writeFrame(socket, payload, binary = false) {
	const frame = new Uint8Array(4 + payload.length);
	new DataView(frame.buffer).setUint32(0, (binary ? BINARY : 0) + payload.length);
	frame.set(payload, 4);
	return socket.write(frame);
}
/**
* Waits for the peer's preface on an authenticated stream (sending ours as soon as the handshake is
* done), then hands the channel over with the binding the stream itself gives. A frame of the wrong size,
* bytes that are not UTF-8 or another protocol close the stream.
*/
function attach(socket, channels) {
	if (channels.size >= MAX_CHANNELS) {
		socket.destroy();
		return Promise.reject(/* @__PURE__ */ new Error("Native connection limit reached"));
	}
	const channel = new RelayedChannel(socket);
	channels.add(channel);
	return new Promise((resolve, reject) => {
		let buffer = /* @__PURE__ */ new Uint8Array(0);
		let prefaced = false;
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const timer = setTimeout(() => socket.destroy(/* @__PURE__ */ new Error("HyperDHT handshake timed out")), HANDSHAKE_MS);
		const fail = (error) => {
			socket.destroy(error);
		};
		socket.on("error", (error) => reject(error));
		socket.on("close", () => {
			clearTimeout(timer);
			channels.delete(channel);
			reject(/* @__PURE__ */ new Error("Native channel closed"));
			channel.closedByPeer();
		});
		const opened = () => {
			if (socket.handshakeHash?.length !== 64 || socket.publicKey?.length !== 32 || socket.remotePublicKey?.length !== 32) {
				fail(/* @__PURE__ */ new Error("Noise session binding unavailable"));
				return;
			}
			writeFrame(socket, new TextEncoder().encode(PREFACE));
		};
		if (socket.opened) socket.opened.then((ok) => {
			if (ok) opened();
			else reject(/* @__PURE__ */ new Error("Noise handshake failed"));
		});
		else socket.once("open", opened);
		socket.on("data", (chunk) => {
			const joined = new Uint8Array(buffer.length + chunk.length);
			joined.set(buffer);
			joined.set(chunk, buffer.length);
			buffer = joined;
			while (buffer.length >= 4) {
				const word = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0);
				const binary = word >= BINARY, length = word % BINARY;
				if (length === 0 || length > MAX_FRAME || binary && !prefaced) {
					fail(/* @__PURE__ */ new Error("Invalid frame length"));
					return;
				}
				if (buffer.length < 4 + length) break;
				if (binary) {
					const message = buffer.slice(4, 4 + length);
					buffer = buffer.slice(4 + length);
					if (!channel.receive(message)) {
						fail(/* @__PURE__ */ new Error("Receive queue exceeded"));
						return;
					}
					continue;
				}
				let text;
				try {
					text = decoder.decode(buffer.subarray(4, 4 + length));
				} catch {
					fail(/* @__PURE__ */ new Error("Invalid UTF-8 frame"));
					return;
				}
				buffer = buffer.slice(4 + length);
				if (!prefaced) {
					if (text !== PREFACE) {
						fail(/* @__PURE__ */ new Error("Unexpected application protocol"));
						return;
					}
					prefaced = true;
					clearTimeout(timer);
					resolve({
						channel,
						binding: {
							transport: "hyperdht/1",
							context: hex(socket.handshakeHash),
							identities: [hex(socket.publicKey), hex(socket.remotePublicKey)].sort()
						}
					});
				} else if (!channel.receive(text)) {
					fail(/* @__PURE__ */ new Error("Receive queue exceeded"));
					return;
				}
			}
		});
	});
}
/**
* A chat's HyperDHT endpoint through the relay at `url`: it listens on the key of `seedB64` (the chat's
* own transport seed, as on the Desktop) and dials a contact's descriptor. Fails, and so is not offered,
* when the relay cannot be reached or does not let it listen.
*/
async function createRelayedHyperEndpoint(seedB64, url, options = {}) {
	const problem = hyperdhtRelayProblem(url);
	if (problem) throw new Error(problem);
	const keyPair = hyperKeyPair(fromBase64Url(seedB64));
	const client = await relayClient(url, options.createSocket ?? ((address) => new WebSocket(address)));
	const channels = /* @__PURE__ */ new Set();
	let stopped = false;
	let handler = null;
	const waiting = [];
	let endpoint = null;
	const member = { unavailable() {
		if (stopped) return;
		stopped = true;
		for (const channel of channels) channel.close();
		endpoint?.onUnavailable?.();
	} };
	client.endpoints.add(member);
	const server = client.node.createServer({}, (socket) => {
		attach(socket, channels).then((bound) => {
			if (stopped) bound.channel.close();
			else if (handler) handler(bound);
			else if (waiting.length < MAX_CHANNELS) waiting.push(bound);
			else bound.channel.close();
		}).catch(() => {});
	});
	try {
		await Promise.race([
			server.listen(keyPair),
			client.closed.then(() => {
				throw new Error("The HyperDHT relay closed the connection");
			}),
			new Promise((_, reject) => setTimeout(() => reject(/* @__PURE__ */ new Error("The HyperDHT relay did not let this chat listen")), LISTEN_MS))
		]);
		if (client.gone) throw new Error("The HyperDHT relay closed the connection");
	} catch (error) {
		stopped = true;
		server.close().catch(() => {});
		release(url, client, member);
		throw error;
	}
	endpoint = {
		transport: "hyperdht/1",
		descriptor: {
			publicKey: hex(keyPair.publicKey),
			relayed: true,
			relay: url
		},
		onDescriptor: null,
		onUnavailable: null,
		get onConnection() {
			return handler;
		},
		set onConnection(value) {
			handler = value;
			if (value) for (const bound of waiting.splice(0)) value(bound);
		},
		async connect(address) {
			const publicKey = address?.publicKey;
			if (stopped || typeof publicKey !== "string" || !/^[a-f0-9]{64}$/.test(publicKey)) throw new Error("Invalid HyperDHT endpoint");
			return attach(client.node.connect(fromHex(publicKey), { keyPair }), channels);
		},
		async close() {
			stopped = true;
			for (const channel of channels) channel.close();
			waiting.length = 0;
			await server.close().catch(() => {});
			release(url, client, member);
		}
	};
	return endpoint;
}
//#endregion
export { createRelayedHyperEndpoint };

//# sourceMappingURL=hyperdhtRelay-DgHXV44O.js.map