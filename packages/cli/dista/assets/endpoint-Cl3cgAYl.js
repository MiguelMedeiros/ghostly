import DHT from "hyperdht";
//#region ../../native/transports/hyperdht/redial.mjs
/**
* How long a HyperDHT dial whose stream opened may go without the contact's preface before it is dialled again.
*
* The first connection a freshly started process makes sometimes opens (the handshake went through the DHT and the
* stream is connected to the right address) and then carries nothing: the contact never sees it, and UDX gives up
* only after 13 s. A connection made again at once goes through in milliseconds. Found as a chat moved to HyperDHT
* right after the contact's app restarted taking about 28 s in CI (the move's 8 s, then its 20 s retry), 1 run in 6;
* reproduced with hyperdht alone under load (bug hunt r11h). On loopback the preface comes within milliseconds of
* the stream opening, one round trip on the internet.
*/
var PREFACE_WAIT_MS = 2e3;
/**
* The longest a stream that opened waits for the preface on a slow path: the 8 s a chat's move gives its dial. Past
* it nobody is waiting for the dial made again, and UDX gives a silent stream up at 13 s anyway.
*/
var PREFACE_MAX_WAIT_MS = 8e3;
/**
* The preface wait for a stream whose smoothed RTT is `rtt` ms and whose dial took `opening` ms to open: three round
* trips once there is a sample, the opening itself before, between `floor` and `ceiling`.
*/
function prefaceWait(rtt, opening = 0, floor = PREFACE_WAIT_MS, ceiling = PREFACE_MAX_WAIT_MS) {
	const wait = rtt > 0 ? 3 * rtt : 1 * (opening || 0);
	return Math.min(ceiling, Math.max(floor, wait));
}
/**
* Dials with `dialOnce` until one brings the contact's preface. `dialOnce()` starts a connection and returns
* `{ opened, ready, close }`: `opened` resolves true once the stream is open (the handshake is done), `ready` with the
* bound channel once the contact's preface came, and `close()` drops it; `rtt()`, if given, is the stream's smoothed
* RTT in ms so far, 0 before its first sample (UDX's `rawStream.rtt`). A dial that opened and brought no preface
* within `waitMs`, or longer on a slow path (`prefaceWait`, at most `maxWaitMs`), is closed and made again, up to
* `maxDials` in all. The RTT is read again whenever the wait would end, so a sample taken after the stream opened
* counts. A dial that fails before it opened (the contact not found, refused) fails the whole connect at once, as
* before: there is nothing to wait for.
*/
function redial(dialOnce, { waitMs = PREFACE_WAIT_MS, maxWaitMs = PREFACE_MAX_WAIT_MS, maxDials = 3 } = {}) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let dials = 0;
		const attempt = () => {
			dials++;
			const dialledAt = Date.now();
			const dial = dialOnce();
			let timer = null;
			let stalled = false;
			dial.opened.then((open) => {
				if (!open || settled) return;
				const openedAt = Date.now();
				const check = () => {
					if (settled) return;
					const left = openedAt + prefaceWait(dial.rtt?.(), openedAt - dialledAt, waitMs, maxWaitMs) - Date.now();
					if (left > 0) {
						timer = setTimeout(check, left);
						return;
					}
					if (dials >= maxDials) return;
					stalled = true;
					dial.close();
					attempt();
				};
				timer = setTimeout(check, waitMs);
			}, () => {});
			dial.ready.then((bound) => {
				clearTimeout(timer);
				if (settled || stalled) {
					bound.channel.close();
					return;
				}
				settled = true;
				resolve(bound);
			}, (error) => {
				clearTimeout(timer);
				if (settled || stalled) return;
				settled = true;
				reject(error);
			});
		};
		attempt();
	});
}
//#endregion
//#region ../../native/transports/hyperdht/endpoint.mjs
var MAX_FRAME = 61440;
/** The top bit of a frame's length word: the frame is a binary message, not UTF-8 text (WISP 103). */
var BINARY = 2147483648;
var PREFACE = "ghostly/paired-chat/1";
/** How long a closing channel waits for what it sent last to go out before the stream is destroyed anyway. */
var CLOSE_FLUSH_MS = 300;
/**
* Bytes a channel may hold before `send` throws: above what every sender here lets itself queue (the CLI's 1 MiB high
* water mark and an app's quarter above it; the Desktop page's send budget over the sidecar's `SEND_ROOM`), so it
* trips only for one that ignores its own line.
*/
var MAX_BUFFERED = 2097152;
/**
* `drained()` resolves once a channel holds no more than this: no more than the sidecar's `SEND_ROOM`, so its wait for
* room never spins on a `drained()` that resolves at once.
*/
var DRAINED_AT = 65536;
/**
* How often a wait in `drained()` looks again. Each stream says `drain` only once its own queue is empty, which on a fast
* link comes first; on a slow one this finds the queue at `DRAINED_AT` before it runs dry.
*/
var DRAIN_POLL_MS = 10;
/**
* What a connection's stream still holds: secret-stream's queue and the UDX stream's under it. Both are streamx
* streams, which count it in `_writableState.buffered` (hyperdht is pinned; hyperdhtEndpointBuffered.test.ts reads it).
* secret-stream has no `writableLength`: read from there, it was always 0.
*/
function held(socket) {
	return (socket._writableState?.buffered ?? 0) + (socket.rawStream?._writableState?.buffered ?? 0);
}
/** Native UDP + NoiseSecretStream. The binding comes from the authenticated
* stream itself, never from an application frame supplied by the other peer. */
async function createHyperEndpoint(seed, options = {}) {
	if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error("Invalid HyperDHT seed");
	const keyPair = DHT.keyPair(Buffer.from(seed));
	const node = new DHT({
		...options,
		keyPair,
		ephemeral: true
	});
	const channels = /* @__PURE__ */ new Set();
	let stopped = false;
	let incomingHandler = null;
	const waiting = [];
	const descriptor = { publicKey: keyPair.publicKey.toString("hex") };
	/** `onChannel`: hears the channel as soon as it counts against the limit (a dial that stalls is dropped from it). */
	async function attach(socket, onChannel) {
		if (stopped || channels.size >= 2) {
			socket.destroy();
			throw new Error("Native connection limit reached");
		}
		let reader = null;
		let closeHandler = null;
		let closed = false;
		let ending = null;
		let pending = [];
		let buffer = Buffer.alloc(0);
		let preface = false;
		let resolveOpen, rejectOpen;
		const ready = new Promise((resolve, reject) => {
			resolveOpen = resolve;
			rejectOpen = reject;
		});
		const timer = setTimeout(() => {
			socket.destroy(/* @__PURE__ */ new Error("HyperDHT handshake timed out"));
		}, 2e4);
		const channel = {
			binary: true,
			get bufferedAmount() {
				return held(socket);
			},
			get onMessage() {
				return reader;
			},
			set onMessage(value) {
				reader = value;
				if (value) for (const text of pending.splice(0)) value(text);
			},
			get onClose() {
				return closeHandler;
			},
			set onClose(value) {
				closeHandler = value;
				if (closed) value?.();
			},
			send(data) {
				const binary = data instanceof Uint8Array;
				if (closed || !(binary || typeof data === "string") || !data.length || (binary ? data.length : Buffer.byteLength(data)) > 61440 || this.bufferedAmount > MAX_BUFFERED) throw new Error("Native channel is closed or exceeds its frame budget");
				const payload = binary ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data);
				const header = Buffer.alloc(4);
				header.writeUInt32BE((binary ? BINARY : 0) + payload.length);
				socket.write(Buffer.concat([header, payload]));
			},
			drained() {
				if (this.bufferedAmount <= DRAINED_AT) return Promise.resolve();
				if (closed) return Promise.reject(/* @__PURE__ */ new Error("Native channel closed"));
				return new Promise((resolve, reject) => {
					const raw = socket.rawStream;
					const check = () => {
						if (this.bufferedAmount <= DRAINED_AT) finish(resolve);
					};
					const gone = () => finish(() => reject(/* @__PURE__ */ new Error("Native channel closed")));
					const poll = setInterval(check, DRAIN_POLL_MS);
					poll.unref?.();
					function finish(settle) {
						clearInterval(poll);
						socket.off("drain", check);
						raw?.off("drain", check);
						socket.off("close", gone);
						settle();
					}
					socket.on("drain", check);
					raw?.on("drain", check);
					socket.once("close", gone);
				});
			},
			close() {
				if (closed || ending) return ending ?? Promise.resolve();
				ending = new Promise((resolve) => {
					socket.once("close", resolve);
				});
				setTimeout(() => socket.destroy(), CLOSE_FLUSH_MS).unref?.();
				socket.end();
				return ending;
			}
		};
		channels.add(channel);
		onChannel?.(channel);
		socket.on("error", (error) => rejectOpen(error));
		socket.on("end", () => socket.end());
		socket.on("close", () => {
			closed = true;
			pending = [];
			clearTimeout(timer);
			channels.delete(channel);
			rejectOpen(/* @__PURE__ */ new Error("Native channel closed"));
			closeHandler?.();
		});
		const opened = () => {
			if (socket.handshakeHash?.length !== 64 || socket.publicKey?.length !== 32 || socket.remotePublicKey?.length !== 32) {
				socket.destroy(/* @__PURE__ */ new Error("Noise session binding unavailable"));
				return;
			}
			channel.send(PREFACE);
		};
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.length >= 4) {
				const word = buffer.readUInt32BE(0);
				const binary = word >= BINARY, length = word % BINARY;
				if (length === 0 || length > 61440 || binary && !preface) {
					socket.destroy(/* @__PURE__ */ new Error("Invalid frame length"));
					return;
				}
				if (buffer.length < 4 + length) break;
				let text;
				if (binary) text = new Uint8Array(buffer.subarray(4, 4 + length));
				else try {
					text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(4, 4 + length));
				} catch {
					socket.destroy(/* @__PURE__ */ new Error("Invalid UTF-8 frame"));
					return;
				}
				buffer = buffer.subarray(4 + length);
				if (!preface) {
					if (text !== PREFACE) {
						socket.destroy(/* @__PURE__ */ new Error("Unexpected application protocol"));
						return;
					}
					preface = true;
					clearTimeout(timer);
					resolveOpen({
						channel,
						binding: {
							transport: "hyperdht/1",
							context: socket.handshakeHash.toString("hex"),
							identities: [socket.publicKey.toString("hex"), socket.remotePublicKey.toString("hex")].sort()
						}
					});
				} else if (reader) reader(text);
				else if (pending.length < 64) pending.push(text);
				else {
					socket.destroy(/* @__PURE__ */ new Error("Receive queue exceeded"));
					return;
				}
			}
		});
		socket.opened.then((ok) => {
			if (ok) opened();
			else rejectOpen(/* @__PURE__ */ new Error("Noise handshake failed"));
		});
		return ready;
	}
	const server = node.createServer((socket) => {
		attach(socket).then((bound) => {
			if (stopped) bound.channel.close();
			else if (incomingHandler) incomingHandler(bound);
			else waiting.push(bound);
		}).catch(() => {});
	});
	try {
		await server.listen(keyPair);
	} catch (error) {
		await node.destroy();
		throw error;
	}
	return {
		transport: "hyperdht/1",
		descriptor,
		onDescriptor: null,
		get onConnection() {
			return incomingHandler;
		},
		set onConnection(value) {
			incomingHandler = value;
			if (value) for (const bound of waiting.splice(0)) value(bound);
		},
		async connect(address) {
			if (stopped || !address || !/^[a-f0-9]{64}$/.test(address.publicKey)) throw new Error("Invalid HyperDHT endpoint");
			const remote = Buffer.from(address.publicKey, "hex");
			return redial(() => {
				const socket = node.connect(remote, { keyPair });
				let counted = null;
				const ready = attach(socket, (channel) => {
					counted = channel;
				});
				return {
					opened: socket.opened,
					ready,
					rtt: () => socket.rawStream?.rtt ?? 0,
					close() {
						if (counted) channels.delete(counted);
						socket.destroy();
					}
				};
			});
		},
		async close() {
			stopped = true;
			const ended = [...channels].map((channel) => channel.close());
			waiting.length = 0;
			await Promise.all(ended);
			await server.close();
			await node.destroy();
		}
	};
}
//#endregion
export { MAX_FRAME, createHyperEndpoint };

//# sourceMappingURL=endpoint-Cl3cgAYl.js.map