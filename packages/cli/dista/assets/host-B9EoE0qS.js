import { $o as RTC_CONFIG, Ni as isPublicAddress, Qo as CALL_SIGNAL_MAX_AGE_MS, Tl as fromBase64Url, as as parseCallSignal, es as answersOffer, is as extractParamsFromSdp, li as checkPushEndpoint, ns as callRtcConfig, ol as setLinkTraceSink, os as signalHasVideo, rs as callSignalHeardAt, ts as buildSdpFromSignal } from "./src-dfGE33hw.js";
import { a as fedimintSdkOn, r as irohRelayProblem } from "./irohWeb-B0JRxO3f.js";
import { r as asCliError, t as CliError } from "./errors-B-zMxbcd.js";
import { a as findChat } from "./apiKit-BeSsbld5.js";
import { _ as flushCardUpdates, c as paymentJson, d as nodeLocalFetch, f as chatJson, g as resumeHolds, h as groupMessageJson, l as reportAppFrames, m as groupJson, p as chatMessageJson, r as callApi, u as servedApps } from "./api-CnHy2xkB.js";
import { n as RESTORED_MARK, r as acquireLock } from "./profiles-CI6Z0_ww.js";
import { r as privateFolder, t as ownFolder } from "./privateFolder-Bk9C9oFv.js";
import { createRequire } from "node:module";
import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createServer, isIP } from "node:net";
import { createInterface } from "node:readline";
import { lookup } from "node:dns/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { lookup as lookup$1 } from "node:dns";
import { request } from "node:https";
import { deserialize, serialize } from "node:v8";
import { IDBFactory, IDBKeyRange, IDBTransaction } from "fake-indexeddb";
//#region src/announce.ts
/**
* What the app's chat screen does by itself, done here for a profile no screen shows (apps/ui/src/hooks/useChat.ts): the side
* that joined says "👋 <name> joined" once the chat first goes live, and the side that invited answers once. Contacts
* see the bot arrive as they see a person; each is said once per chat, across restarts.
*/
function announceJoins(hub, node) {
	const say = (chat) => {
		if (hub.said(chat, "join")) return;
		hub.markSaid(chat, "join");
		const nick = node.getState().settings.nick?.trim();
		node.sendMessage({
			linkId: chat,
			text: nick ? `👋 ${nick} joined` : "👋 joined"
		}).catch(() => {});
	};
	return hub.onEvent((event) => {
		const chat = event.chat;
		if (!chat) return;
		const link = node.getState().links.find((l) => l.id === chat);
		if (!link?.profile) return;
		if (event.type === "chat.connection" && event.live && link.pairingProgress?.role === "joiner") say(chat);
		else if (event.type === "chat.joined") say(chat);
	});
}
var CALL_RATES = [
	8e3,
	12e3,
	16e3,
	24e3,
	48e3
];
var DEFAULT_RATE = 48e3;
var frameSamples = (rate) => rate * 20 / 1e3;
var frameBytes = (rate) => frameSamples(rate) * 2;
var bytesToMs = (rate, bytes) => Math.round(bytes / 2 / rate * 1e3);
function isCallRate(value) {
	return CALL_RATES.includes(value);
}
/** The most a program may queue ahead of the call: five minutes of speech. What goes past it is dropped. */
var MAX_QUEUE_MS = 3e5;
/**
* What the program wrote, waiting to be sent: taken one 20 ms frame per tick, silence when there is nothing, and
* dropped whole by a flush (barge-in). The program may write any amount at any time, faster than real time too.
*/
var PlaybackQueue = class {
	rate;
	now;
	chunks = [];
	head = 0;
	length = 0;
	lastPush = 0;
	frame;
	max;
	silence;
	/** Bytes dropped because the queue was full, since the start. */
	dropped = 0;
	constructor(rate, now = Date.now, maxMs = MAX_QUEUE_MS) {
		this.rate = rate;
		this.now = now;
		this.frame = frameBytes(rate);
		this.max = Math.floor(rate * maxMs / 1e3) * 2;
		this.silence = Buffer.alloc(this.frame);
	}
	/** Adds what the program wrote. Returns the bytes it could not keep (the queue was full). */
	push(chunk) {
		if (!chunk.length) return 0;
		this.lastPush = this.now();
		const room = this.max - this.length;
		const kept = chunk.length <= room ? chunk : chunk.subarray(0, Math.max(0, room));
		const lost = chunk.length - kept.length;
		this.dropped += lost;
		if (kept.length) {
			this.chunks.push(Buffer.from(kept));
			this.length += kept.length;
		}
		return lost;
	}
	/** Queued audio, in milliseconds (whole frames and a partial one). */
	get queuedMs() {
		return bytesToMs(this.rate, this.length - this.length % 2);
	}
	/** One frame to send now, and whether it is the program's audio or silence. */
	next() {
		if (this.length >= this.frame) return {
			frame: this.take(this.frame),
			silent: false
		};
		const whole = this.length - this.length % 2;
		if (whole > 0 && this.now() - this.lastPush >= 60) {
			const frame = Buffer.alloc(this.frame);
			this.take(whole).copy(frame);
			return {
				frame,
				silent: false
			};
		}
		return {
			frame: this.silence,
			silent: true
		};
	}
	/** Drops everything queued; returns how much, in milliseconds. */
	flush() {
		const ms = this.queuedMs;
		this.chunks = [];
		this.head = 0;
		this.length = 0;
		return ms;
	}
	/** Drops up to that much from the front, in whole frames (audio whose time went by); returns how much, in milliseconds. */
	skip(ms) {
		const frames = Math.min(Math.floor(ms / 20), Math.floor(this.length / this.frame));
		if (frames > 0) this.take(frames * this.frame);
		return Math.max(0, frames) * 20;
	}
	take(bytes) {
		const out = Buffer.allocUnsafe(bytes);
		let filled = 0;
		while (filled < bytes) {
			const chunk = this.chunks[0];
			const n = Math.min(bytes - filled, chunk.length - this.head);
			chunk.copy(out, filled, this.head, this.head + n);
			filled += n;
			this.head += n;
			if (this.head === chunk.length) {
				this.chunks.shift();
				this.head = 0;
			}
		}
		this.length -= bytes;
		return out;
	}
};
//#endregion
//#region src/calls/audioSocket.ts
/**
* A call's audio socket (WISP 1100 § Calls): `<profile>/calls/<call>.sock`, 0600, in a folder only the owner may
* open. When that path is too long for a Unix socket: `/tmp/ghostly-calls-<hash of the profile>/<call>.sock`, in a
* folder of the owner's, 0700, checked as such before use. A named pipe on Windows.
*/
function audioSocketPath(profileDir, callId) {
	const inside = join(profileDir, "calls", `${callId}.sock`);
	if (process.platform === "win32") return `\\\\.\\pipe\\ghostly-call-${createHash("sha256").update(inside).digest("hex").slice(0, 24)}`;
	if (Buffer.byteLength(inside) <= 100) return inside;
	return join("/tmp", `ghostly-calls-${createHash("sha256").update(profileDir).digest("hex").slice(0, 24)}`, `${callId}.sock`);
}
/**
* Removes the call sockets a daemon that died during a call left in this profile's folder (`audioSocketPath`; call
* ids are 12 hex digits): no call outlives its daemon. A folder that is a link or someone else's is left alone.
*/
function clearAudioSockets(profileDir) {
	if (process.platform === "win32") return;
	const folder = dirname(audioSocketPath(profileDir, "0".repeat(12)));
	try {
		const info = lstatSync(folder);
		if (!info.isDirectory() || process.getuid && info.uid !== process.getuid()) return;
		for (const entry of readdirSync(folder, { withFileTypes: true })) if (entry.name.endsWith(".sock") && !entry.isDirectory()) rmSync(join(folder, entry.name), { force: true });
	} catch {}
}
/**
* Serves one call's audio to one program at a time: what the program writes is handed to `onAudio` as it comes (raw
* PCM, any amount); `write` gives it the caller's audio. A second connection replaces the first. `close` ends the
* program's connection (it reads EOF) and removes the socket.
*/
var AudioSocket = class AudioSocket {
	path;
	server;
	rate;
	client = null;
	closed = false;
	/** Frames the program did not read in time, since the start. */
	dropped = 0;
	constructor(path, server, rate) {
		this.path = path;
		this.server = server;
		this.rate = rate;
	}
	static async open(path, rate, handlers) {
		if (process.platform !== "win32") {
			privateFolder(join(path, ".."), "calls will not put their audio there");
			if (existsSync(path)) rmSync(path, { force: true });
		}
		let self = null;
		const server = createServer((socket) => self.accept(socket, handlers));
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(path, () => {
				server.off("error", reject);
				resolve();
			});
		});
		if (process.platform !== "win32") chmodSync(path, 384);
		self = new AudioSocket(path, server, rate);
		return self;
	}
	get connected() {
		return !!this.client && !this.client.destroyed;
	}
	accept(socket, handlers) {
		if (this.closed) {
			socket.destroy();
			return;
		}
		const before = this.client;
		this.client = socket;
		before?.end();
		socket.setNoDelay?.(true);
		socket.on("data", (chunk) => {
			if (this.client === socket) handlers.onAudio(chunk);
		});
		socket.on("error", () => {});
		socket.on("close", () => {
			if (this.client !== socket) return;
			this.client = null;
			handlers.onClient?.(false);
		});
		handlers.onClient?.(true);
	}
	/** One frame of the caller's audio for the program; dropped when nobody listens or the program stopped reading. */
	write(frame) {
		const client = this.client;
		if (!client || client.destroyed) return;
		if (bytesToMs(this.rate, client.writableLength) > 1e3) {
			this.dropped++;
			return;
		}
		client.write(frame);
	}
	/** Ends the program's connection (EOF once what was written is read) and removes the socket. */
	close() {
		if (this.closed) return Promise.resolve();
		this.closed = true;
		const client = this.client;
		this.client = null;
		client?.end();
		if (client) setTimeout(() => client.destroy(), 2e3).unref();
		return new Promise((resolve) => {
			this.server.close(() => resolve());
			if (process.platform !== "win32") rmSync(this.path, { force: true });
		});
	}
};
/** Whether a packet on the muxed port is RTCP (RFC 5761 § 4: its second byte is 192-223), not RTP. */
function isRtcp(packet) {
	return packet.length >= 2 && packet[1] >= 192 && packet[1] <= 223;
}
/** Reads an RTP packet: CSRCs, a header extension and padding are stepped over. Null for anything malformed. */
function parseRtp(packet) {
	if (packet.length < 12 || packet[0] >> 6 !== 2 || isRtcp(packet)) return null;
	let offset = 12 + (packet[0] & 15) * 4;
	if (packet[0] & 16) {
		if (packet.length < offset + 4) return null;
		offset += 4 + packet.readUInt16BE(offset + 2) * 4;
	}
	let end = packet.length;
	if (packet[0] & 32) {
		const padding = packet[packet.length - 1];
		if (padding === 0) return null;
		end -= padding;
	}
	if (end < offset) return null;
	return {
		payloadType: packet[1] & 127,
		marker: (packet[1] & 128) !== 0,
		sequence: packet.readUInt16BE(2),
		timestamp: packet.readUInt32BE(4),
		ssrc: packet.readUInt32BE(8),
		payload: packet.subarray(offset, end)
	};
}
/** Numbers this side's packets: one SSRC, a sequence and a timestamp from random starts. */
var RtpWriter = class {
	ssrc;
	payloadType;
	sequence = randomBytes(2).readUInt16BE(0);
	timestamp = randomBytes(4).readUInt32BE(0);
	constructor(ssrc, payloadType) {
		this.ssrc = ssrc;
		this.payloadType = payloadType;
	}
	/** The next frame's packet. `marker` starts a talkspurt (the first sound after silence). */
	packet(payload, marker = false) {
		const header = Buffer.allocUnsafe(12);
		header[0] = 128;
		header[1] = (marker ? 128 : 0) | this.payloadType & 127;
		header.writeUInt16BE(this.sequence, 2);
		header.writeUInt32BE(this.timestamp, 4);
		header.writeUInt32BE(this.ssrc >>> 0, 8);
		this.sequence = this.sequence + 1 & 65535;
		this.timestamp = this.timestamp + 960 >>> 0;
		return Buffer.concat([header, payload]);
	}
};
/** The most frames a gap in the packets becomes (concealed by the decoder, see CallAudio). */
var MAX_LOST_FRAMES = 3;
/** Sequence numbers compared across the 16-bit wrap: positive when `a` comes after `b`. */
function sequenceDelta(a, b) {
	const d = a - b & 65535;
	return d >= 32768 ? d - 65536 : d;
}
/**
* Puts packets back in order, holding at most `depth` of them for one that is late: a lost packet costs one frame
* the decoder conceals (40 ms of waiting at most), a duplicate or a packet that came too late is dropped, and a new stream (its
* SSRC changed, or its sequence jumped) starts over.
*/
var ReorderBuffer = class {
	depth;
	expected = null;
	ssrc = null;
	held = /* @__PURE__ */ new Map();
	constructor(depth = 2) {
		this.depth = depth;
	}
	push(packet) {
		if (this.ssrc !== packet.ssrc || this.expected === null || Math.abs(sequenceDelta(packet.sequence, this.expected)) > 1e3) {
			this.ssrc = packet.ssrc;
			this.expected = packet.sequence;
			this.held.clear();
		}
		if (sequenceDelta(packet.sequence, this.expected) < 0 || this.held.has(packet.sequence)) return [];
		this.held.set(packet.sequence, packet.payload);
		const out = [];
		this.release(out);
		while (this.held.size > this.depth) {
			const next = [...this.held.keys()].reduce((a, b) => sequenceDelta(a, b) < 0 ? a : b);
			const gap = sequenceDelta(next, this.expected);
			for (let i = 0; i < Math.min(gap, MAX_LOST_FRAMES); i++) out.push({ lost: true });
			this.expected = next;
			this.release(out);
		}
		return out;
	}
	release(out) {
		for (;;) {
			const payload = this.held.get(this.expected);
			if (!payload) return;
			this.held.delete(this.expected);
			out.push({ payload });
			this.expected = this.expected + 1 & 65535;
		}
	}
};
//#endregion
//#region src/calls/audio.ts
/** The longest stall of the sender whose frames are still sent after it (see `catchUp`). */
var MAX_CATCH_UP_MS = 1e3;
/**
* One call's audio: every 20 ms a frame from the queue (the program's audio, or silence) is encoded and sent; what
* comes in is put back in order, decoded, and handed on in 20 ms frames as soon as it is. Nothing waits on a clock
* but the sending side, so the audio adds at most a frame of delay each way inside the CLI.
*/
var CallAudio = class {
	options;
	queue;
	writer;
	reorder = new ReorderBuffer();
	frame;
	samples;
	silence;
	pending = Buffer.alloc(0);
	/** What the decoder concealed for the current gap and is not handed on yet (see `conceal`). */
	concealed = null;
	timer = null;
	startedAt = 0;
	ticks = 0;
	/** What was left in the queue after the last frame sent: the program's audio written ahead of the call. */
	ahead = 0;
	/** After a stall that was not replayed: how much of its audio is still to drop, down to what queue, and until when. */
	owed = 0;
	kept = 0;
	owedUntil = 0;
	talking = false;
	/** The last silent frame's packet, how many silent frames in a row gave it, and that packet once it is kept (see `settle`). */
	lastQuiet = null;
	same = 0;
	quiet = null;
	stopped = false;
	/** Frames sent and received, for `call list`. */
	sent = 0;
	received = 0;
	/** When the last packet, RTP or RTCP, came from the contact (Date.now(); 0: none yet), for the call's watch. */
	heardAt = 0;
	constructor(options) {
		this.options = options;
		const now = options.now ?? Date.now;
		this.queue = options.queue ?? new PlaybackQueue(options.rate, now);
		this.writer = new RtpWriter(options.ssrc, options.payloadType);
		this.frame = frameBytes(options.rate);
		this.samples = frameSamples(options.rate);
		this.silence = Buffer.alloc(this.frame);
		options.track.onPacket((packet) => this.receive(packet));
	}
	/** Starts sending, a frame every 20 ms from now on. */
	start() {
		if (this.timer || this.stopped) return;
		this.startedAt = (this.options.now ?? Date.now)();
		this.ticks = 0;
		this.schedule();
	}
	stop() {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.options.encoder.delete?.();
		this.options.decoder.delete?.();
	}
	/** Sends the frame that is due now. Exposed for tests, which drive the clock themselves. */
	tick() {
		if (this.stopped) return;
		const { frame, silent } = this.queue.next();
		const still = silent || frame.equals(this.silence);
		let payload;
		if (still && this.quiet) payload = this.quiet;
		else {
			try {
				payload = this.options.encoder.encode(frame, this.samples);
			} catch {
				return;
			}
			this.settle(still, payload);
		}
		const marker = !silent && !this.talking;
		this.talking = !silent;
		this.options.track.send(this.writer.packet(payload, marker));
		this.sent++;
		this.ahead = this.queue.queuedMs;
	}
	/**
	* Keeps the packet silence encodes to once the encoder gave it SETTLED_FRAMES times in a row: it is sent again for
	* the silent frames that follow, without the encoder, until the program's audio is back.
	*/
	settle(still, payload) {
		if (!still) {
			this.lastQuiet = null;
			this.quiet = null;
			this.same = 0;
			return;
		}
		if (this.lastQuiet?.equals(payload)) {
			if (++this.same >= 25) this.quiet = this.lastQuiet;
			return;
		}
		this.lastQuiet = Buffer.from(payload);
		this.same = 1;
	}
	/** Handles one packet from the track. Exposed for tests. */
	receive(packet) {
		if (this.stopped) return;
		this.heardAt = (this.options.now ?? Date.now)();
		if (isRtcp(packet)) return;
		const rtp = parseRtp(packet);
		if (!rtp || rtp.payloadType !== this.options.payloadType) return;
		for (const item of this.reorder.push(rtp)) {
			let pcm;
			if ("lost" in item) pcm = this.conceal();
			else {
				this.concealed = null;
				try {
					pcm = this.options.decoder.decode(item.payload);
				} catch {
					pcm = this.silence;
				}
			}
			this.emit(pcm);
		}
	}
	/**
	* A frame for one that never came: the decoder's loss concealment (libopus PLC, what an empty packet decodes to), as
	* the apps' WebRTC stacks do, not a frame of silence (a click). opusscript conceals 60 ms at a time (its largest
	* frame), so one run of it serves the frames of a gap in turn (ReorderBuffer gives MAX_LOST_FRAMES at most).
	*/
	conceal() {
		if (!this.concealed || this.concealed.length < this.frame) try {
			this.concealed = Buffer.from(this.options.decoder.decode(Buffer.alloc(0)));
		} catch {
			this.concealed = null;
		}
		if (!this.concealed || this.concealed.length < this.frame) return this.silence;
		const pcm = this.concealed.subarray(0, this.frame);
		this.concealed = this.concealed.subarray(this.frame);
		return pcm;
	}
	/** Hands decoded audio on in 20 ms frames, whatever the contact's packet length (10, 20, 40 or 60 ms). */
	emit(pcm) {
		let data = this.pending.length ? Buffer.concat([this.pending, pcm]) : pcm;
		while (data.length >= this.frame) {
			this.options.onFrame(Buffer.from(data.subarray(0, this.frame)));
			this.received++;
			data = data.subarray(this.frame);
		}
		this.pending = Buffer.from(data);
	}
	schedule() {
		const now = this.options.now ?? Date.now;
		const due = this.startedAt + (this.ticks + 1) * 20;
		this.timer = setTimeout(() => {
			if (this.stopped) return;
			if (now() - due < 20) {
				this.ticks++;
				this.drop();
				this.tick();
				this.schedule();
				return;
			}
			setImmediate(() => {
				if (this.stopped) return;
				this.catchUp(now() - due);
				this.schedule();
			});
		}, Math.max(0, due - now()));
	}
	/**
	* Meets the clock again after the loop was busy: every frame that is due goes out at once, so a loop that turns
	* slower than a frame for a while (every 40 ms under a large file) keeps up, and a program writing at real time
	* stays there. The contact's jitter buffer takes the short burst. A stall past MAX_CATCH_UP_MS is not replayed: the
	* clock starts again and what the program wrote during it is dropped, or it would be heard that much late for the
	* rest of the call.
	*/
	catchUp(late) {
		const now = this.options.now ?? Date.now;
		if (late > 1e3) {
			this.owed = late;
			this.kept = this.ahead;
			this.owedUntil = now() + MAX_CATCH_UP_MS;
			this.startedAt = now();
			this.ticks = 0;
			this.drop();
			this.tick();
			return;
		}
		do {
			this.ticks++;
			this.drop();
			this.tick();
		} while (this.startedAt + (this.ticks + 1) * 20 <= now());
	}
	/**
	* Drops the audio of a stall that was not replayed, as it is read: a long one does not fit the program's socket, so
	* the rest of it comes over the next turns. What was queued before the stall (a clip written ahead) is kept.
	*/
	drop() {
		if (this.owed <= 0) return;
		if ((this.options.now ?? Date.now)() > this.owedUntil) {
			this.owed = 0;
			return;
		}
		this.owed -= this.queue.skip(Math.min(this.owed, this.queue.queuedMs - this.kept));
	}
};
//#endregion
//#region src/calls/media.ts
var loading = null;
/** The media stack, or why calls are not available here (the reason the call buttons of the contact's app show). */
function loadCallStack() {
	return loading ??= (async () => {
		if (process.env.GHOSTLY_WEBRTC === "0") return "Calls are off on this headless Ghostly (GHOSTLY_WEBRTC=0)";
		try {
			const ndc = await import("node-datachannel");
			const lib = ndc.PeerConnection ? ndc : ndc.default;
			const OpusScript = (await import("opusscript")).default;
			const opus = (rate) => {
				const codec = new OpusScript(rate, 1, OpusScript.Application.VOIP);
				codec.setBitrate(32e3);
				return codec;
			};
			opus(48e3).delete?.();
			return {
				ndc: lib,
				opus
			};
		} catch (error) {
			return `Calls are not available on this headless Ghostly (${error instanceof Error ? error.message : String(error)})`;
		}
	})();
}
/**
* The ICE servers of a call, as libdatachannel takes them: the apps' STUN servers (RTC_CONFIG; libjuice uses the
* first; none with `GHOSTLY_STUN=0`), then the profile's own (Settings `iceServers`: a TURN relay, typically), as the
* apps' calls use them.
*/
function callIceServers(extra = [], env = process.env) {
	const out = env.GHOSTLY_STUN === "0" ? [] : (RTC_CONFIG.iceServers ?? []).flatMap((server) => [server.urls].flat()).slice(0, 2);
	for (const server of callRtcConfig(extra).iceServers?.slice(RTC_CONFIG.iceServers?.length ?? 0) ?? []) for (const url of [server.urls].flat()) {
		const m = /^(stun|turns?):([^:?\s]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i.exec(url);
		if (!m) continue;
		const scheme = m[1].toLowerCase(), hostname = m[2], transport = m[4]?.toLowerCase();
		if (scheme === "stun") {
			out.push(`stun:${hostname}:${m[3] ?? 3478}`);
			continue;
		}
		out.push({
			hostname,
			port: Number(m[3] ?? (scheme === "turns" ? 5349 : 3478)),
			...server.username ? { username: server.username } : {},
			...typeof server.credential === "string" ? { password: server.credential } : {},
			relayType: scheme === "turns" ? "TurnTls" : transport === "tcp" ? "TurnTcp" : "TurnUdp"
		});
	}
	return out;
}
/** A candidate as `call list` and the log show it: address, port and type. */
function describePair(pair) {
	if (!pair) return null;
	const one = (c) => `${c.address}:${c.port} ${c.type}`;
	return `${one(pair.local)} <-> ${one(pair.remote)}`;
}
/**
* For tests (the e2e of a web app calling back a bot): the first this many answers the process applies are refused
* as libdatachannel 0.24.5 refuses one in its race (see CallManager's `redial`): the connection closes, and it throws.
*/
var refuseAnswers = Number(process.env.GHOSTLY_CALL_REFUSE_ANSWERS) || 0;
/** How long a description waits for its candidates: a server reflexive one and a little after it, or this long. */
var GATHER_MS = 5e3;
/** The signal keeps the first server reflexive candidate only: the apps' calls and the chats' data link settle as long. */
var SETTLE_MS = 150;
/**
* With a candidate in (a host one comes in milliseconds), the server reflexive one is waited for this long at most,
* not the whole of `GATHER_MS`: a STUN server that answers does in tens of milliseconds, and one that never does (UDP
* to it blocked, as on many office, school and hotel networks) made every call ring 5 s late and connect 5 s after
* the answer. The apps' calls and the chats' data link bound theirs the same way (`HOST_GATHER_MS`,
* `OFFER_HOST_GATHER_MS`).
*/
var HOST_GATHER_MS = 2e3;
/**
* A connection and its description, with its candidates. An early answer's (`held`) takes the contact's offer
* without its candidates: with none, this side sends the contact no check, so nothing connects, and no audio is sent
* or read, before the answer adds them.
*/
async function openConnection(stack, options, offer, held = false) {
	const { ndc } = stack;
	const bind = process.env.GHOSTLY_CALL_BIND;
	const iceServers = callIceServers(options.iceServers);
	const pc = new ndc.PeerConnection("ghostly-call", {
		iceServers,
		...bind ? { bindAddress: bind } : {}
	});
	const born = Date.now();
	const sink = options.log ?? (() => {});
	const log = (line) => sink(`+${Date.now() - born}ms ${line}`);
	let conn = null;
	pc.onSignalingStateChange((state) => {
		if (!conn?.closed) log(`signaling ${state}`);
	});
	pc.onIceStateChange((state) => {
		if (conn?.closed) return;
		let pair = null;
		if (state === "connected" || state === "completed") try {
			pair = describePair(pc.getSelectedCandidatePair());
		} catch {}
		if (conn) {
			conn.ice.state = state;
			if (state === "connected" || state === "completed") conn.ice.pair = pair;
		}
		log(`ice ${state}${pair ? ` over ${pair}` : ""}`);
	});
	pc.onStateChange((state) => {
		if (conn?.closed) return;
		log(`connection ${state}`);
		if (!conn) return;
		if (state === "failed") conn.failed = true;
		if (state === "connected") conn.onState?.("connected");
		else if (state === "failed" || state === "closed") conn.onState?.(state);
	});
	try {
		const payloadType = offer?.ap ?? 111;
		const ssrc = randomBytes(4).readUInt32BE(0) || 1;
		const audioSection = new ndc.Audio("0", "SendRecv");
		audioSection.addOpusCodec(payloadType);
		audioSection.addSSRC(ssrc, "ghostly", "stream", "audio0");
		const track = pc.addTrack(audioSection);
		let videoTrack = null;
		if (offer?.m?.includes("v")) {
			const video = new ndc.Video(String(offer.m.indexOf("v")), "Inactive");
			video.addVP8Codec(offer.vp ?? 96);
			videoTrack = pc.addTrack(video);
			videoTrack.onMessage(() => {});
		}
		const gathered = gathering(pc, { turn: callUsesTurn(iceServers) });
		if (offer) pc.setRemoteDescription(buildSdpFromSignal(held ? {
			...offer,
			c: []
		} : offer), "offer");
		else pc.setLocalDescription("offer");
		await gathered;
		const sdp = pc.localDescription()?.sdp;
		if (!sdp) throw new Error("No local description");
		const local = {
			...extractParamsFromSdp(sdp, {
				maxCandidates: 8,
				loopback: !!bind
			}),
			ss: [ssrc]
		};
		if (offer?.m) local.m = [...offer.m];
		if (videoTrack) local.vr = 0;
		conn = {
			pc,
			track,
			videoTrack,
			local,
			payloadType,
			ssrc,
			log,
			ice: {
				state: "new",
				pair: null
			},
			closed: false,
			failed: false,
			onState: null
		};
		log(`candidates here: ${(local.c ?? []).join(" | ") || "none"}`);
		try {
			conn.ice.state = pc.iceState();
		} catch {}
		return conn;
	} catch (error) {
		pc.close();
		throw error;
	}
}
function closeConnection(conn) {
	conn.closed = true;
	try {
		conn.track.close();
	} catch {}
	try {
		conn.videoTrack?.close();
	} catch {}
	try {
		conn.pc.close();
	} catch {}
}
/**
* The answer's connection, made while the call rings: its description and candidates are ready when the call is
* answered, so the answer goes at once, where gathering them then took up to HOST_GATHER_MS (a STUN server that never
* answers). The offer's candidates wait for the answer (see `openConnection`). libjuice gives up on a connection that
* has nothing to check after about 40 s: a call that rings longer has its early answer made again (CallManager).
*/
var EarlyAnswer = class EarlyAnswer {
	conn;
	offer;
	constructor(conn, offer) {
		this.conn = conn;
		this.offer = offer;
	}
	static async open(stack, offer, options) {
		return new EarlyAnswer(await openConnection(stack, options, offer, true), offer);
	}
	/** Whether it can still answer: not closed, not given up on, not used. */
	get usable() {
		return !!this.conn && !this.conn.closed && !this.conn.failed;
	}
	/** Its connection, once, for the answer to the offer it was made for. */
	take(offer) {
		if (!this.usable || offer !== this.offer) return null;
		const conn = this.conn;
		this.conn = null;
		return conn;
	}
	/** Closed unused: the call ended, or a newer one replaced it. Nothing once taken. */
	close() {
		if (this.conn) closeConnection(this.conn);
		this.conn = null;
	}
};
/**
* One call's peer connection. Its SDP never travels: the compact signal does (`local`), and each side rebuilds the
* other's SDP from it (`buildSdpFromSignal`), so the payload types, SSRC and mids here are the ones that rebuilt SDP
* uses: audio is mid 0, Opus is 111 unless the contact's offer says otherwise.
*/
var CallMedia = class CallMedia {
	conn;
	audio;
	log;
	constructor(conn, audio) {
		this.conn = conn;
		this.audio = audio;
		this.log = conn.log;
	}
	get local() {
		return this.conn.local;
	}
	/** An offer: audio only (the contact's app answers one section, and its video lane stays closed). */
	static async offer(stack, options) {
		return CallMedia.create(stack, options, null);
	}
	/**
	* The answer to a contact's offer, which is rebuilt into its SDP here: on the connection made while the call rang
	* when it is still good, else on a new one.
	*/
	static async answer(stack, offer, options, early) {
		return CallMedia.create(stack, options, offer, early?.take(offer) ?? null);
	}
	static async create(stack, options, offer, early = null) {
		const conn = early ?? await openConnection(stack, options, offer);
		const { pc, track, log } = conn;
		try {
			const listeners = [];
			track.onMessage((packet) => {
				for (const listener of listeners) listener(packet);
			});
			const audio = new CallAudio({
				rate: options.rate,
				payloadType: conn.payloadType,
				ssrc: conn.ssrc,
				track: {
					send: (packet) => {
						if (track.isOpen()) track.sendMessageBinary(packet);
					},
					onPacket: (listener) => listeners.push(listener)
				},
				encoder: stack.opus(options.rate),
				decoder: stack.opus(options.rate),
				onFrame: options.onFrame,
				queue: options.queue
			});
			const media = new CallMedia(conn, audio);
			conn.onState = options.onState;
			if (offer) log(`contact's candidates: ${(offer.c ?? []).join(" | ") || "none"}`);
			if (offer) mdnsNote(offer, log);
			track.onOpen(() => audio.start());
			if (early && offer) {
				log("answered on the connection made as the call rang: the contact's candidates go in now");
				const mid = String(Math.max(0, (offer.m ?? ["a"]).indexOf("a")));
				for (const candidate of offer.c ?? []) pc.addRemoteCandidate(`candidate:${candidate}`, mid);
			}
			if (track.isOpen()) audio.start();
			return media;
		} catch (error) {
			closeConnection(conn);
			throw error;
		}
	}
	/** The contact's answer to this side's offer. */
	applyAnswer(answer) {
		this.log(`contact's candidates: ${(answer.c ?? []).join(" | ") || "none"}`);
		mdnsNote(answer, this.log);
		if (refuseAnswers > 0) {
			refuseAnswers--;
			this.conn.pc.close();
			throw new Error("libdatachannel error while adding remote description: Got a remote candidate without ICE transport (GHOSTLY_CALL_REFUSE_ANSWERS)");
		}
		this.conn.pc.setRemoteDescription(buildSdpFromSignal(answer), "answer");
		this.log("answer applied");
	}
	get ice() {
		return this.conn.ice;
	}
	close() {
		if (this.conn.closed) return;
		this.audio.stop();
		closeConnection(this.conn);
	}
};
/**
* WebKit (Safari, the macOS app) hides its host addresses behind mDNS names, which other machines, and often this
* one, cannot resolve: then the call can only connect when the contact's own checks reach this side. The log says so,
* since that is what a call stuck on "connecting" needs to be understood.
*/
function mdnsNote(signal, log) {
	for (const candidate of signal.c ?? []) {
		const host = candidate.split(" ")[4];
		if (!host?.endsWith(".local")) continue;
		lookup(host, { all: true }).then((found) => log(`${host} resolves here to ${found.map((a) => a.address).join(", ")}`), () => log(`${host} does not resolve here: the call connects only if the contact's checks reach this side`));
	}
}
/** Whether a call's ICE servers (`callIceServers`) have a TURN server: its relay candidate is then the one waited for. */
function callUsesTurn(servers) {
	return servers.some((server) => typeof server !== "string");
}
/**
* Resolves once the local description has its candidates (see GATHER_MS and HOST_GATHER_MS). `turn`: the connection
* has a TURN server, and its relay candidate is waited for rather than the reflexive one, as the apps' calls do
* (`waitForIceGathering`): an allocation takes two round trips, and a TURN server 100 ms away gave its relay after the
* description had gone without it, on the networks where only the relay connects.
*/
function gathering(pc, { turn = false } = {}) {
	const wanted = turn ? / typ relay/ : / typ srflx/;
	return new Promise((resolve) => {
		let settle = null;
		let any = false;
		const done = () => {
			clearTimeout(cap);
			clearTimeout(bounded);
			if (settle) clearTimeout(settle);
			resolve();
		};
		const cap = setTimeout(done, GATHER_MS);
		const bounded = setTimeout(() => {
			if (any) done();
		}, HOST_GATHER_MS);
		pc.onGatheringStateChange((state) => {
			if (state === "complete") done();
		});
		pc.onLocalCandidate((candidate) => {
			any = true;
			if (!settle && wanted.test(candidate)) settle = setTimeout(done, SETTLE_MS);
		});
	});
}
//#endregion
//#region src/calls/manager.ts
/** An outgoing call rings this long, then ends as `unanswered`. */
var RING_MS = 6e4;
/** An answered or accepted call has this long to connect its media, then ends as `failed`. */
var CONNECT_MS = 3e4;
/** How long a call whose media closed or failed waits for the contact's hang-up signal to say why. */
var MEDIA_GRACE_MS = 3e3;
/** After a hang-up, the signal is cleared this much later (the apps' own delay). */
var CLEAR_MS = 5e3;
var REDIAL_BACKOFF_MS = [
	150,
	300,
	600,
	600
];
var CallManager = class {
	host;
	calls = /* @__PURE__ */ new Map();
	/** Per chat: the timestamp of the last signal handled. */
	lastSignal = /* @__PURE__ */ new Map();
	/** Per chat: the timestamp of the last signal sent (`stamp`). */
	lastSent = /* @__PURE__ */ new Map();
	/** Per chat: the timer that clears the hang-up signal. */
	clearing = /* @__PURE__ */ new Map();
	/** Per chat: when this side's last call there ended before it was answered (`CALL_PACE_MS`). */
	unansweredAt = /* @__PURE__ */ new Map();
	/** The early answers being made, those of ended calls too (MAX_EARLY_ANSWERS). */
	makings = /* @__PURE__ */ new Set();
	auto;
	configPath;
	stopping = false;
	constructor(host) {
		this.host = host;
		this.configPath = join(host.profileDir, "calls.json");
		this.auto = readAuto(this.configPath);
		if (host.answers !== false) clearAudioSockets(host.profileDir);
	}
	get now() {
		return (this.host.now ?? Date.now)();
	}
	/**
	* A new signal's timestamp in a chat: now, or 1 ms after the last one sent there. The contact drops a signal no
	* newer than the last it heard, so a redial or a hang-up in the same millisecond as the signal before it would be lost.
	*/
	stamp(chat) {
		const ts = Math.max(this.now, (this.lastSent.get(chat) ?? 0) + 1);
		this.lastSent.set(chat, ts);
		return ts;
	}
	/** A signal the contact's app sent in a chat (the engine's `call-signal`). */
	onSignal(chat, json) {
		if (this.stopping) return;
		const signal = parseCallSignal(json, this.now);
		if (!signal) return;
		if (signal.ts <= (this.lastSignal.get(chat) ?? 0)) return;
		const call = this.byChat(chat);
		if (signal.t === "r" || signal.t === "a" && signal.re !== void 0) return;
		if (call?.state === "connected" && signal.t !== "h" && signal.t !== "v") return;
		if (signal.t === "o" && !call) {
			this.lastSignal.set(chat, signal.ts);
			this.incoming(chat, signal);
		} else if (signal.t === "a" && call?.direction === "out" && call.offering && answersOffer(signal, call.offerTs)) {
			this.lastSignal.set(chat, signal.ts);
			this.accepted(call, signal);
		} else if (signal.t === "o" && call?.direction === "out" && call.state === "ringing") {
			this.lastSignal.set(chat, signal.ts);
			const mine = call.offering ? call.offerTs : 0;
			if (!mine || signal.ts < mine || signal.ts === mine && (signal.f ?? "") < (call.media?.local.f ?? "")) this.yieldTo(call, signal);
		} else if (signal.t === "o" && call?.direction === "in" && call.state === "connecting" && call.media && signal.ts > (call.offer?.ts ?? 0)) {
			this.lastSignal.set(chat, signal.ts);
			this.reanswer(call, signal);
		} else if (signal.t === "v") this.lastSignal.set(chat, signal.ts);
		else if (signal.t === "h") {
			this.lastSignal.set(chat, signal.ts);
			if (call) {
				const unreachable = signal.r === "u" && call.state !== "connected";
				const failed = unreachable || call.state !== "connected" && (call.offering || call.direction === "out" && call.redials > 0);
				const reason = call.state === "ringing" && call.direction === "in" ? "missed" : call.state === "ringing" && !unreachable ? "rejected" : failed ? "failed" : "remote-hangup";
				this.end(call, reason, false);
			}
		}
	}
	/**
	* The contact's offer won a glare: our call ends as `crossed`, sending nothing (a hang-up would end the contact's
	* call, and clearing our signal could drop an answer we are about to give), and the contact's call rings here.
	*/
	async yieldTo(call, offer) {
		await this.end(call, "crossed", false);
		if (this.lastSignal.get(call.chat) !== offer.ts || this.byChat(call.chat) || this.stopping) return;
		this.incoming(call.chat, offer);
	}
	incoming(chat, offer) {
		const link = this.link(chat);
		const call = this.add(chat, "in", this.auto.rate);
		call.offer = offer;
		call.video = signalHasVideo(offer);
		this.arm(call, Math.max(1e3, callSignalHeardAt(offer) + CALL_SIGNAL_MAX_AGE_MS - this.now), "missed", false);
		this.host.emit("call.incoming", `call.incoming:${call.id}`, {
			call: call.id,
			chat,
			name: link ? nameOf(link) : null,
			video: call.video,
			auto: this.autoFor(chat)
		});
		this.prepare(call);
		if (this.host.answers !== false && this.autoFor(chat)) this.answer(call.id, {}).catch((error) => process.stderr.write(`ghostly: auto-answer failed: ${error instanceof Error ? error.message : String(error)}\n`));
	}
	accepted(call, answer) {
		call.offering = false;
		call.state = "connecting";
		const attempt = call.answered = call.attempt;
		call.answeredAt = Date.now();
		try {
			call.media.applyAnswer(answer);
		} catch (error) {
			if (attempt === call.attempt) this.refused(call, `the answer was refused (${error instanceof Error ? error.message : String(error)})`);
			return;
		}
		if (attempt === call.attempt) this.arm(call, CONNECT_MS, "failed", true);
	}
	/**
	* The contact's answer on this connection was refused, or the connection failed right after it (the same race,
	* whose handshake can also fail once the answer is in): offering again (`redial`) while there are tries left.
	*/
	refused(call, what) {
		if (call.redials < this.maxRedials) {
			process.stderr.write(`ghostly: call ${call.id}: ${what}: offering again on a new connection\n`);
			this.redial(call);
			return;
		}
		process.stderr.write(`ghostly: call ${call.id}: ${what}\n`);
		this.end(call, "failed", true);
	}
	get maxRedials() {
		return this.host.maxRedials ?? 4;
	}
	/**
	* A new offer on a new connection, up to MAX_REDIALS times, each after a short wait. libdatachannel (0.24.5) can
	* refuse a good answer: when the contact's checks and its DTLS hello came before the answer (they do, the answer
	* crosses the chat session), ICE connects and the handshake ends inside setRemoteDescription, before the answer's
	* fingerprint is recorded; the fingerprint check fails, the connection closes its transports, and adding the
	* answer's candidates throws "Got a remote candidate without ICE transport". That connection is done for, and the
	* contact's side saw the handshake fail too, so both start over: the contact's side answers the newer offer
	* (`reanswer`). Each new connection runs the same race (CI runners lose about one in six, Linux arm64 twice in a
	* row), hence several. The race can also let the answer in and fail the handshake a moment later: a connection
	* that fails after its answer, before it ever connected, starts over the same way. The contact's side ends a call whose connection failed after MEDIA_GRACE_MS: every wait stays
	* well under it. Fixed upstream in libdatachannel 0235225a, which no release has yet.
	*/
	async redial(call) {
		const wait = REDIAL_BACKOFF_MS[Math.min(call.redials, REDIAL_BACKOFF_MS.length - 1)];
		call.redials++;
		call.attempt++;
		call.media?.close();
		call.media = null;
		this.arm(call, CONNECT_MS, "failed", true);
		await new Promise((resolve) => setTimeout(resolve, wait));
		if (call.ended) return;
		try {
			const stack = await this.stack();
			if (!await this.connect(call, (media) => CallMedia.offer(stack, media))) return;
			call.offerTs = this.stamp(call.chat);
			call.offering = true;
			await this.send(call.chat, {
				t: "o",
				ts: call.offerTs,
				...call.media.local,
				v: 0
			});
		} catch (error) {
			process.stderr.write(`ghostly: call ${call.id}: offering again failed (${error instanceof Error ? error.message : String(error)})\n`);
			this.end(call, "failed", true);
		}
	}
	/** The contact's newer offer (its `redial`): answered on a new connection, on the call's socket. */
	async reanswer(call, offer) {
		process.stderr.write(`ghostly: call ${call.id}: the contact offered again: answering on a new connection\n`);
		call.offer = offer;
		call.video = signalHasVideo(offer);
		this.arm(call, CONNECT_MS, "failed", true);
		try {
			const stack = await this.stack();
			if (!await this.connect(call, (media) => CallMedia.answer(stack, offer, media))) return;
			await this.send(call.chat, {
				t: "a",
				ts: this.stamp(call.chat),
				o: offer.ts,
				...call.media.local,
				v: 0
			});
		} catch (error) {
			process.stderr.write(`ghostly: call ${call.id}: answering again failed (${error instanceof Error ? error.message : String(error)})\n`);
			this.end(call, "failed", true);
		}
	}
	/**
	* The ringing call's answer, made now (`EarlyAnswer`): when the call is answered, its candidates have been gathered
	* and the answer goes at once. Made again every EARLY_ANSWER_MS while it rings; when it cannot be made, the answer makes its own.
	*/
	prepare(call) {
		if (this.host.answers === false || call.ended || call.state !== "ringing") return;
		this.stopEarly(call);
		call.earlyTimer = setTimeout(() => this.prepare(call), this.host.earlyAnswerMs ?? 3e4);
		call.earlyTimer.unref?.();
		if (call.making) return;
		const held = [...this.calls.values()].filter((c) => c !== call && c.early).length;
		if (this.makings.size + held >= 4 || [...this.makings].some((m) => m.chat === call.chat)) return;
		const offer = call.offer;
		const making = {
			chat: call.chat,
			done: this.stack().then((stack) => EarlyAnswer.open(stack, offer, {
				iceServers: this.host.engine.getState().settings?.iceServers ?? [],
				log: (line) => process.stderr.write(`ghostly: call ${call.id}: ${line}\n`)
			})).catch((error) => {
				this.stopEarly(call);
				process.stderr.write(`ghostly: call ${call.id}: the answer could not be made ahead (${error instanceof Error ? error.message : String(error)})\n`);
				return null;
			}),
			claimed: false
		};
		call.making = making;
		this.makings.add(making);
		making.done.then((early) => {
			this.makings.delete(making);
			if (call.making === making) call.making = null;
			if (!making.claimed && early) {
				if (call.ended || call.state !== "ringing") early.close();
				else {
					call.early?.close();
					call.early = early;
				}
			}
			const next = this.byChat(making.chat);
			if (next && next !== call && next.direction === "in" && !next.making && !next.early) this.prepare(next);
		});
	}
	/** The answered call's early answer: the one made, if still good, or the one being made; none from then on. */
	async takeEarly(call) {
		this.stopEarly(call);
		const early = call.early;
		call.early = null;
		if (early?.usable) return early;
		early?.close();
		const making = call.making;
		if (!making) return null;
		making.claimed = true;
		return making.done;
	}
	/** The early answer is not made again. */
	stopEarly(call) {
		if (call.earlyTimer) clearTimeout(call.earlyTimer);
		call.earlyTimer = null;
	}
	async start(chat, options) {
		const link = this.callable(chat);
		if (this.byChat(link.id)) throw new CliError("busy", "A call is already on in this chat");
		this.paced(link.id);
		const rate = rateOf(options.rate, this.auto.rate);
		const stack = await this.stack();
		if (this.byChat(link.id)) throw new CliError("busy", "A call is already on in this chat");
		const call = this.add(link.id, "out", rate);
		try {
			await this.attach(call, (media) => CallMedia.offer(stack, media));
			if (call.reason === "crossed") throw new CliError("busy", "The contact called at the same time: their call rings here");
			if (call.ended) throw new CliError("unavailable", "The call ended before it was placed");
			call.offerTs = this.stamp(link.id);
			call.offering = true;
			await this.send(link.id, {
				t: "o",
				ts: call.offerTs,
				...call.media.local,
				v: 0
			});
		} catch (error) {
			await this.end(call, "failed", false, false);
			throw error;
		}
		this.arm(call, RING_MS, "unanswered", true);
		this.host.emit("call.outgoing", `call.outgoing:${call.id}`, {
			call: call.id,
			chat: link.id,
			name: nameOf(link),
			audio: this.audioInfo(call)
		});
		return this.view(call);
	}
	async answer(ref, options) {
		const call = this.find(ref, (c) => c.direction === "in" && c.state === "ringing");
		if (call.direction !== "in" || call.state !== "ringing") throw new CliError("refused", "That call is not ringing here");
		this.callable(call.chat);
		call.rate = rateOf(options.rate, call.rate);
		const stack = await this.stack();
		if (call.ended) throw new CliError("unavailable", "The call ended before it was answered");
		if (call.state !== "ringing") throw new CliError("refused", "That call is not ringing here");
		call.state = "connecting";
		this.disarm(call);
		let early = null;
		try {
			early = await this.takeEarly(call);
			await this.attach(call, (media) => CallMedia.answer(stack, call.offer, media, early));
			if (call.ended) throw new CliError("unavailable", "The call ended before it was answered");
			await this.send(call.chat, {
				t: "a",
				ts: this.stamp(call.chat),
				o: call.offer.ts,
				...call.media.local,
				v: 0
			});
		} catch (error) {
			await this.end(call, "failed", true, false);
			throw error;
		} finally {
			early?.close();
		}
		this.arm(call, CONNECT_MS, "failed", true);
		return this.view(call);
	}
	async hangup(ref) {
		const call = this.find(ref);
		const view = this.view(call);
		await this.end(call, "hangup", true);
		return {
			...view,
			state: "ended",
			reason: "hangup"
		};
	}
	/** One call, by its id or its chat (or the only one). */
	get(ref) {
		return this.view(this.find(ref));
	}
	list() {
		return [...this.calls.values()].map((call) => this.view(call));
	}
	/** Drops the audio the program queued and the call has not sent yet (barge-in). */
	flush(ref) {
		const call = this.find(ref);
		const flushedMs = call.queue?.flush() ?? 0;
		return {
			call: call.id,
			chat: call.chat,
			flushedMs
		};
	}
	getAuto() {
		return {
			...this.auto,
			from: [...this.auto.from]
		};
	}
	setAuto(next) {
		const from = (next.from ?? []).map((ref) => this.chatId(ref));
		this.auto = {
			on: next.on,
			from: next.on ? from : [],
			rate: rateOf(next.rate, next.on ? this.auto.rate : DEFAULT_RATE)
		};
		const tmp = `${this.configPath}.tmp`;
		writeFileSync(tmp, JSON.stringify({ autoAnswer: this.auto }, null, 2) + "\n", { mode: 384 });
		renameSync(tmp, this.configPath);
		return this.getAuto();
	}
	/** Before the engine stops: every call is hung up (the contact's app is told), its program gets EOF. */
	async stopAll() {
		this.stopping = true;
		await Promise.all([...this.calls.values()].map((call) => this.end(call, "stopped", true)));
		for (const timer of this.clearing.values()) clearTimeout(timer);
		this.clearing.clear();
	}
	add(chat, direction, rate) {
		if (this.stopping) throw new CliError("unavailable", "The daemon is stopping");
		const clearing = this.clearing.get(chat);
		if (clearing) {
			clearTimeout(clearing);
			this.clearing.delete(chat);
		}
		const call = {
			id: randomBytes(6).toString("hex"),
			chat,
			direction,
			state: "ringing",
			rate,
			video: false,
			offer: null,
			offerTs: 0,
			offering: false,
			redials: 0,
			attempt: 0,
			answered: 0,
			answeredAt: 0,
			media: null,
			early: null,
			making: null,
			earlyTimer: null,
			socket: null,
			queue: null,
			startedAt: this.now,
			connectedAt: null,
			timer: null,
			watcher: null,
			stalledFrom: null,
			stalls: 0,
			ended: false
		};
		this.calls.set(call.id, call);
		return call;
	}
	/**
	* The call's socket (open from now on: a program may connect before the media is up) and its media. A call that
	* ended while its socket opened closes it here: `end` found none to close, and nothing lists the call any more.
	*/
	async attach(call, create) {
		const queue = call.queue = new PlaybackQueue(call.rate);
		const socket = await AudioSocket.open(audioSocketPath(this.host.profileDir, call.id), call.rate, { onAudio: (chunk) => queue.push(chunk) });
		if (call.ended) {
			await socket.close();
			return;
		}
		call.socket = socket;
		await this.connect(call, create);
	}
	/**
	* A connection for the call, in place of the one it had (closed first); the socket and its queue stay. False when
	* the call ended, or asked for a newer connection, while this one was made: then it is closed.
	*/
	async connect(call, create) {
		if (call.ended) return false;
		const attempt = ++call.attempt;
		call.media?.close();
		call.media = null;
		let failed = false;
		const media = await create({
			rate: call.rate,
			queue: call.queue ?? void 0,
			log: (line) => process.stderr.write(`ghostly: call ${call.id}: ${line}\n`),
			iceServers: this.host.engine.getState().settings?.iceServers ?? [],
			onFrame: (frame) => call.socket?.write(frame),
			onState: (state) => {
				if (call.ended || attempt !== call.attempt) return;
				if (state === "connected") {
					this.connected(call);
					return;
				}
				if (state === "closed" && failed) return;
				failed ||= state === "failed";
				if (state === "failed" && call.direction === "out" && call.answered === attempt && call.state !== "connected" && Date.now() - call.answeredAt < 2e3) {
					this.refused(call, "the connection failed as the answer went in");
					return;
				}
				this.arm(call, MEDIA_GRACE_MS, state === "closed" ? "remote-hangup" : "failed", false);
			}
		});
		if (call.ended || attempt !== call.attempt) {
			media.close();
			return false;
		}
		call.media = media;
		return true;
	}
	connected(call) {
		if (call.state === "connected") return;
		call.state = "connected";
		call.connectedAt = this.now;
		this.disarm(call);
		this.host.emit("call.connected", `call.connected:${call.id}`, {
			call: call.id,
			chat: call.chat,
			direction: call.direction,
			audio: this.audioInfo(call)
		});
		this.watch(call);
	}
	/**
	* libjuice says nothing of a contact whose side went away (a crash, a closed lid, a lost network) until its consent
	* checks fail, about 30 s later: a connected call watches the contact's packets instead. An app sends them all along
	* (silence while muted, and RTCP), and so does the CLI. Nothing for STALL_MS: `call.stalled`; packets again:
	* `call.resumed`; nothing for STALL_END_MS: the call ends as `failed`, and the contact's app is told.
	*/
	watch(call) {
		const { afterMs, endMs } = this.host.stall ?? {
			afterMs: 5e3,
			endMs: 15e3
		};
		const since = Date.now();
		call.watcher = setInterval(() => {
			if (call.ended) return;
			const heardAt = Math.max(since, call.media?.audio.heardAt ?? 0);
			const silentMs = Date.now() - heardAt;
			const fields = {
				call: call.id,
				chat: call.chat,
				direction: call.direction
			};
			if (silentMs >= endMs) {
				process.stderr.write(`ghostly: call ${call.id}: nothing heard from the contact for ${Math.round(silentMs / 1e3)} s\n`);
				this.end(call, "failed", true);
			} else if (silentMs >= afterMs && call.stalledFrom === null) {
				call.stalledFrom = heardAt;
				call.stalls++;
				process.stderr.write(`ghostly: call ${call.id}: stalled, nothing heard from the contact for ${silentMs} ms\n`);
				this.host.emit("call.stalled", `call.stalled:${call.id}:${call.stalls}`, {
					...fields,
					silentMs
				});
			} else if (silentMs < afterMs && call.stalledFrom !== null) {
				const gapMs = heardAt - call.stalledFrom;
				call.stalledFrom = null;
				process.stderr.write(`ghostly: call ${call.id}: resumed after ${gapMs} ms\n`);
				this.host.emit("call.resumed", `call.resumed:${call.id}:${call.stalls}`, {
					...fields,
					silentMs: gapMs
				});
			}
		}, Math.min(1e3, afterMs / 5));
		call.watcher.unref?.();
	}
	async end(call, reason, tell, report = true) {
		if (call.ended) return;
		call.ended = true;
		call.reason = reason;
		this.disarm(call);
		if (call.watcher) clearInterval(call.watcher);
		this.calls.delete(call.id);
		if (call.direction === "out" && call.connectedAt === null && call.state === "ringing" && (reason === "hangup" || reason === "unanswered")) this.unansweredAt.set(call.chat, this.now);
		if (report) process.stderr.write(`ghostly: call ${call.id}: ended (${reason})${call.media ? `, ice ${call.media.ice.state}` : ""}\n`);
		call.media?.close();
		this.stopEarly(call);
		call.early?.close();
		call.early = null;
		await call.socket?.close();
		if (tell) {
			await this.send(call.chat, {
				t: "h",
				ts: this.stamp(call.chat)
			}).catch(() => {});
			if (!this.stopping) {
				const timer = setTimeout(() => {
					this.clearing.delete(call.chat);
					this.sendRaw(call.chat, null).catch(() => {});
				}, CLEAR_MS);
				timer.unref?.();
				this.clearing.set(call.chat, timer);
			}
		} else if (reason !== "crossed") await this.sendRaw(call.chat, null).catch(() => {});
		if (report) this.host.emit("call.ended", `call.ended:${call.id}`, {
			call: call.id,
			chat: call.chat,
			direction: call.direction,
			reason,
			...call.connectedAt !== null ? { duration: this.now - call.connectedAt } : {}
		});
	}
	/** Refuses a call placed too soon after this side's last unanswered one in the chat (`CALL_PACE_MS`). */
	paced(chat) {
		const pace = this.host.callPaceMs ?? 2e3, last = this.unansweredAt.get(chat);
		if (!pace || last === void 0) return;
		const left = last + pace - this.now;
		if (left <= 0) {
			this.unansweredAt.delete(chat);
			return;
		}
		throw new CliError("busy", `Your last call in this chat ended unanswered a moment ago: call again in ${Math.ceil(left / 100) / 10} s`, { retryAfterMs: left });
	}
	arm(call, ms, reason, tell) {
		this.disarm(call);
		call.timer = setTimeout(() => void this.end(call, reason, tell), ms);
		call.timer.unref?.();
	}
	disarm(call) {
		if (call.timer) clearTimeout(call.timer);
		call.timer = null;
	}
	send(chat, signal) {
		return this.sendRaw(chat, JSON.stringify(signal));
	}
	async sendRaw(chat, signal) {
		try {
			await this.host.engine.setCallSignal({
				linkId: chat,
				signal
			});
		} catch (error) {
			throw new CliError("unavailable", error instanceof Error ? error.message : String(error));
		}
	}
	async stack() {
		if (this.host.answers === false) throw new CliError("unavailable", "Calls need the daemon (a call outlives this command): start it with `ghostly daemon --detach`");
		const stack = await (this.host.stack ?? loadCallStack)();
		if (typeof stack === "string") throw new CliError("unavailable", stack);
		return stack;
	}
	audioInfo(call) {
		return call.socket ? {
			socket: call.socket.path,
			rate: call.rate,
			channels: 1,
			format: "s16le",
			frameMs: 20
		} : null;
	}
	view(call) {
		const audio = call.media?.audio;
		return {
			call: call.id,
			chat: call.chat,
			direction: call.direction,
			state: call.state,
			stalled: call.stalledFrom !== null,
			video: call.video,
			startedAt: call.startedAt,
			connectedAt: call.connectedAt,
			audio: this.audioInfo(call),
			...call.socket ? { stats: {
				framesIn: audio?.received ?? 0,
				framesOut: audio?.sent ?? 0,
				queuedMs: call.queue?.queuedMs ?? 0,
				programConnected: call.socket.connected,
				ice: call.media?.ice ?? null
			} } : {}
		};
	}
	byChat(chat) {
		for (const call of this.calls.values()) if (call.chat === chat) return call;
	}
	/** A call by its id, or by its chat; with no ref, the only call (or the only one `prefer` picks). */
	find(ref, prefer) {
		if (ref) {
			const byId = this.calls.get(ref);
			if (byId) return byId;
			const call = this.byChat(this.chatId(ref));
			if (!call) throw new CliError("not_found", `No call in chat ${ref}`);
			return call;
		}
		const all = [...this.calls.values()];
		const picked = prefer && all.filter(prefer).length === 1 ? all.filter(prefer) : all;
		if (picked.length === 1) return picked[0];
		if (!picked.length) throw new CliError("not_found", "No call is on");
		throw new CliError("bad_request", "More than one call is on: name one (its id or its chat)", { calls: picked.map((c) => c.id) });
	}
	link(chat) {
		return this.host.engine.getState().links.find((l) => l.id === chat);
	}
	/** A chat by id, contact key, prefix or name (the API's rules, `findChat`). */
	chatId(ref) {
		return findChat(this.host.engine.getState().links, ref).id;
	}
	/** The chat, if a call can go in it now; else why not (the engine's reason). */
	callable(ref) {
		const link = this.link(this.chatId(ref));
		if (!link.profile) throw new CliError("unavailable", "Calls are in chats made since 0.4 (the chat session): this is a compatibility chat");
		if (link.callsUnavailable) throw new CliError("unavailable", link.callsUnavailable);
		return link;
	}
	autoFor(chat) {
		return this.auto.on && (this.auto.from.length === 0 || this.auto.from.includes(chat));
	}
};
function nameOf(link) {
	return link.label?.trim() || link.peerNick?.trim() || null;
}
function rateOf(value, fallback) {
	if (value === void 0 || value === null) return fallback;
	if (!isCallRate(value)) throw new CliError("bad_request", "rate must be 8000, 12000, 16000, 24000 or 48000");
	return value;
}
function readAuto(path) {
	const off = {
		on: false,
		from: [],
		rate: DEFAULT_RATE
	};
	if (!existsSync(path)) return off;
	try {
		const saved = JSON.parse(readFileSync(path, "utf8")).autoAnswer;
		if (!saved) return off;
		return {
			on: saved.on === true,
			from: Array.isArray(saved.from) ? saved.from.filter((c) => typeof c === "string") : [],
			rate: isCallRate(saved.rate) ? saved.rate : DEFAULT_RATE
		};
	} catch {
		return off;
	}
}
/** A journal past this is trimmed, and only this much of its end is ever read. */
var JOURNAL_MAX_BYTES = 33554432;
var SEEN_DB = "ghostly-cli";
var SEEN = "seen";
/**
* How long the seen set keeps the note of a settled message after its last activity (its arrival, its edit, a reaction):
* older notes are dropped, and a message that came here longer ago with no note is no news. A daemon kept a note per
* message of its whole history in memory, for as long as it ran.
*/
var SEEN_KEEP_MS = 2592e6;
/** How often a daemon drops the notes that passed `SEEN_KEEP_MS`. */
var SWEEP_EVERY_MS = 216e5;
/** How long a `file.*` event waits for the message that carries its file. */
var FILE_MESSAGE_WAIT_MS = 2e3;
/** The notice an app sends when a chat first goes live (apps/ui/src/hooks/useChat.ts): shown as a line, not a message. */
var JOIN_NOTICE = /^👋 (?:(.+) )?joined$/;
/**
* Turns the engine's events into the stream, keeps the journal, and remembers which messages it already reported
* (a store of its own in the profile's IndexedDB): after a restart, only what is new is reported, and a first
* start reports nothing of the history that was already there.
*/
var EventHub = class {
	journalPath;
	now;
	seenDb;
	seq = 0;
	journalLines = 0;
	journalBytes = 0;
	listeners = /* @__PURE__ */ new Set();
	stateListeners = /* @__PURE__ */ new Set();
	callListeners = /* @__PURE__ */ new Set();
	appListeners = /* @__PURE__ */ new Set();
	seen = /* @__PURE__ */ new Map();
	firstRun = false;
	chats = /* @__PURE__ */ new Map();
	groups = /* @__PURE__ */ new Map();
	payments = /* @__PURE__ */ new Map();
	transfers = /* @__PURE__ */ new Map();
	received = /* @__PURE__ */ new Map();
	/** File id to the message that carries it, for `file.*` events. */
	fileMessages = /* @__PURE__ */ new Map();
	/** `file.*` events whose message was not seen yet: they wait for it a moment (the engine stores it right after). */
	pendingFiles = /* @__PURE__ */ new Map();
	baselined = false;
	/** Chats and groups whose history the baseline did not read whole, and how to read it: until a file event needs it. */
	unread = /* @__PURE__ */ new Map();
	/**
	* Whether the seen set notes mentions (`+m`): false on a set written before it did, whose mentions were reported with
	* their `group.message` already. Its first baseline then notes them without a `group.mentioned` each.
	*/
	mentionsNoted = true;
	/** Whether the notes carry their time (`@…`): false on a set written before they did, until a whole read stamps them. */
	agesNoted = true;
	sweeper = null;
	db;
	state = null;
	/** `seenDb`: the IndexedDB database of the seen set (tests give each hub its own). */
	constructor(journalPath, now = Date.now, seenDb = SEEN_DB) {
		this.journalPath = journalPath;
		this.now = now;
		this.seenDb = seenDb;
	}
	/** Loads the journal's last seq and the seen set; call before `sink` is attached. */
	async open() {
		try {
			if (existsSync(this.journalPath)) {
				const { lines, size } = journalTail(this.journalPath);
				this.journalLines = lines.length;
				this.journalBytes = size;
				for (let i = lines.length - 1; i >= 0; i--) try {
					this.seq = JSON.parse(lines[i]).seq;
					break;
				} catch {}
				if (size > 33554432 || lines.length > 2e4) this.trimJournal();
			}
		} catch (error) {
			process.stderr.write(`ghostly: the event journal could not be read, a new one begins: ${error instanceof Error ? error.message : String(error)}\n`);
			try {
				renameSync(this.journalPath, this.journalPath + ".unreadable");
			} catch {}
			this.journalLines = 0;
			this.journalBytes = 0;
		}
		this.db = await new Promise((resolve, reject) => {
			const request = indexedDB.open(this.seenDb, 1);
			request.onupgradeneeded = () => {
				request.result.createObjectStore(SEEN);
				this.firstRun = true;
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const store = this.db.transaction(SEEN).objectStore(SEEN);
		const all = (request) => new Promise((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const [keys, values] = await Promise.all([all(store.getAllKeys()), all(store.getAll())]);
		for (let i = 0; i < keys.length; i++) {
			const [chat, id] = keys[i];
			this.seenOf(chat).set(id, values[i]);
		}
		this.mentionsNoted = this.firstRun || this.seen.get(FORMAT)?.get(MENTIONS_NOTED) === "yes";
		this.agesNoted = this.firstRun || this.seen.get(FORMAT)?.get(AGES_NOTED) === "yes";
	}
	/** The sink the engine server posts to. */
	sink = { post: (message) => {
		try {
			this.handle(message);
		} catch (error) {
			process.stderr.write(`ghostly: event error: ${error instanceof Error ? error.stack : String(error)}\n`);
		}
	} };
	/**
	* The engine as it is at start, before the sink is attached: chats and groups are known without events; messages
	* missing from the seen set are news (they came while no process derived events, a crash), except on a first
	* run, which only learns the history that was already there.
	*/
	baseline(state, histories, rest) {
		this.stateChanged(state);
		for (const [chat, messages] of histories) this.messages(chat, messages);
		for (const [chat, messages] of rest?.newest ?? []) {
			this.messages(chat, messages, []);
			this.unread.set(chat, rest.whole);
		}
		this.baselined = true;
		this.firstRun = false;
		const marks = [MENTIONS_NOTED, AGES_NOTED].filter((mark) => this.seen.get(FORMAT)?.get(mark) !== "yes");
		for (const mark of marks) this.seenOf(FORMAT).set(mark, "yes");
		if (marks.length) this.persist(FORMAT, marks.map((mark) => [mark, "yes"]));
		this.mentionsNoted = true;
		this.agesNoted = true;
		this.sweep();
		if (!this.sweeper) {
			this.sweeper = setInterval(() => this.sweep(), SWEEP_EVERY_MS);
			this.sweeper.unref?.();
		}
	}
	/**
	* Drops the notes of settled messages, and of reactions, whose last activity is older than `SEEN_KEEP_MS`: from memory
	* and from the store. A message of mine still on its way (or failed, which a retry sends again) keeps its note.
	*/
	sweep() {
		const cutoff = this.now() - SEEN_KEEP_MS;
		let dropped = 0;
		for (const [chat, known] of this.seen) {
			if (chat === FORMAT || chat.startsWith("said:")) continue;
			const reactions = chat.startsWith("reactions:");
			const gone = [];
			for (const [id, note] of known) {
				const at = timeIn(note);
				if (at === void 0 || at >= cutoff || !reactions && !settled(stateIn(note))) continue;
				known.delete(id);
				gone.push([id, null]);
			}
			if (gone.length) {
				this.persist(chat, gone);
				dropped += gone.length;
			}
			if (!known.size) this.seen.delete(chat);
		}
		return dropped;
	}
	/**
	* Whether these messages of a chat or group (its newest) are all as the seen set has them, reactions included: there
	* is then nothing to report of them. Never on a first run, nor on a seen set from before it noted mentions: those
	* take the whole history once.
	*/
	inStep(chat, messages) {
		if (this.firstRun || !this.mentionsNoted || !this.agesNoted) return false;
		const known = this.seen.get(chat), reactions = this.seen.get(`reactions:${chat}`);
		const cutoff = this.now() - SEEN_KEEP_MS;
		return messages.every((message) => {
			const note = known?.get(message.id), before = note === void 0 ? void 0 : stateIn(note);
			if (note === void 0 && message.timestamp < cutoff && activityOf(message) < cutoff) return true;
			let state = stateOf(message);
			if (before !== void 0 && mentionedIn(before) && !mentionedIn(state)) state = withFlag(state, MENTIONED);
			if (before !== state) return false;
			return Object.entries(message.reactions ?? {}).every(([by, r]) => {
				const note = reactions?.get(`${message.id}|${by}`);
				return note === void 0 ? r.at < cutoff : stateIn(note) === String(r.n);
			});
		});
	}
	onEvent(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	onState(listener) {
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	}
	/** A call signal from a contact's app, as the engine gives it. */
	onCallSignal(listener) {
		this.callListeners.add(listener);
		return () => this.callListeners.delete(listener);
	}
	/** A frame of a contact's mini-app (apps/1), as the engine gives it: the app named by its chat app id. */
	onAppFrame(listener) {
		this.appListeners.add(listener);
		return () => this.appListeners.delete(listener);
	}
	/** Events after `since` still in the journal; a gap event first when older ones were dropped. */
	replay(since) {
		if (!existsSync(this.journalPath) || since >= this.seq) return [];
		const out = [];
		for (const line of journalTail(this.journalPath).lines) try {
			const event = JSON.parse(line);
			if (event.seq > since) out.push(event);
		} catch {}
		if (out.length && out[0].seq > since + 1) out.unshift({
			seq: since,
			id: `events.gap:${since}:${out[0].seq}`,
			type: "events.gap",
			at: this.now(),
			from: since + 1,
			to: out[0].seq - 1
		});
		return out;
	}
	get lastSeq() {
		return this.seq;
	}
	/** Emits an event the host makes itself (`daemon.started`). */
	emit(type, id, fields = {}) {
		const event = {
			seq: ++this.seq,
			id,
			type,
			at: this.now(),
			...fields
		};
		try {
			const line = JSON.stringify(event) + "\n";
			appendFileSync(this.journalPath, line, { mode: 384 });
			this.journalBytes += Buffer.byteLength(line);
			if (++this.journalLines > 2e4 || this.journalBytes > 33554432) this.trimJournal();
		} catch (error) {
			process.stderr.write(`ghostly: event journal error: ${error instanceof Error ? error.message : String(error)}\n`);
		}
		for (const listener of this.listeners) try {
			listener(event);
		} catch {}
		return event;
	}
	/** Keeps the last `JOURNAL_KEEP` events, and of them no more than `JOURNAL_KEEP_BYTES`. */
	trimJournal() {
		const lines = journalTail(this.journalPath).lines.slice(-1e4);
		let start = lines.length, bytes = 0;
		while (start > 0 && bytes + Buffer.byteLength(lines[start - 1]) + 1 <= 16777216) bytes += Buffer.byteLength(lines[--start]) + 1;
		const kept = lines.slice(start);
		writeFileSync(this.journalPath + ".tmp", kept.length ? kept.join("\n") + "\n" : "", { mode: 384 });
		renameSync(this.journalPath + ".tmp", this.journalPath);
		this.journalLines = kept.length;
		this.journalBytes = bytes;
	}
	handle(message) {
		switch (message.kind) {
			case "state":
				this.stateChanged(message.state);
				break;
			case "messages":
				this.messages(message.linkId, message.messages);
				break;
			case "message-changes":
				this.messages(message.linkId, message.messages, message.deleted);
				break;
			case "call-signal":
				for (const listener of this.callListeners) try {
					listener(message.linkId, message.signal);
				} catch (error) {
					process.stderr.write(`ghostly: call error: ${error instanceof Error ? error.stack : String(error)}\n`);
				}
				break;
			case "app-frame": for (const listener of this.appListeners) try {
				listener(message.linkId, message.event);
			} catch (error) {
				process.stderr.write(`ghostly: app frame error: ${error instanceof Error ? error.stack : String(error)}\n`);
			}
		}
	}
	stateChanged(state) {
		const quiet = !this.baselined;
		const links = new Map(state.links.map((link) => [link.id, link]));
		for (const [id, link] of links) {
			const shape = chatShape(link), before = this.chats.get(id);
			this.chats.set(id, shape);
			if (quiet) continue;
			if (!before) {
				this.emit("chat.created", `chat.created:${id}`, {
					chat: id,
					summary: {
						...chatJson(link),
						invite: null
					}
				});
				continue;
			}
			if (shape.stage && shape.stage !== before.stage) {
				const progress = link.pairingProgress;
				this.emit("chat.pairing", `chat.pairing:${id}:${shape.stage}:${progress?.since ?? this.now()}`, {
					chat: id,
					stage: shape.stage,
					...progress?.detail ? { detail: progress.detail } : {},
					...progress?.reason ? { reason: progress.reason } : {},
					...progress?.peerSeen ? { peerSeen: true } : {}
				});
			}
			if (shape.live !== before.live || shape.transport !== before.transport) {
				const at = this.now();
				this.emit("chat.connection", `chat.connection:${id}:${shape.live ? shape.transport : "down"}:${at}`, {
					chat: id,
					live: shape.live,
					transport: shape.transport,
					text: link.textDelivery ?? null
				});
			}
			if (shape.name !== before.name) this.emit("chat.renamed", `chat.renamed:${id}:${this.now()}`, {
				chat: id,
				name: shape.name
			});
			this.pinned("chat", id, before.pin, shape.pin);
			if (shape.typing !== before.typing) this.emit(shape.typing ? "typing.started" : "typing.stopped", `typing.${shape.typing ? "started" : "stopped"}:${id}:${this.now()}`, {
				chat: id,
				...shape.typing ? typingFields(shape) : {}
			});
			else if (shape.typing && (shape.typingKind !== before.typingKind || shape.typingStatus !== before.typingStatus)) this.emit("typing.started", `typing.started:${id}:${this.now()}:${this.seq + 1}`, {
				chat: id,
				...typingFields(shape)
			});
		}
		for (const id of [...this.chats.keys()]) {
			if (links.has(id)) continue;
			this.chats.delete(id);
			if (!quiet) this.emit("chat.removed", `chat.removed:${id}`, { chat: id });
		}
		const groups = new Map(state.groups.map((group) => [group.id, group]));
		for (const [id, group] of groups) {
			const shape = groupShape(group), before = this.groups.get(id);
			this.groups.set(id, shape);
			if (quiet) continue;
			if (!before) {
				this.emit("group.created", `group.created:${id}`, {
					group: id,
					summary: groupJson(group)
				});
				continue;
			}
			if (shape.status !== before.status) this.emit("group.status", `group.status:${id}:${shape.status}:${this.now()}`, {
				group: id,
				status: shape.status
			});
			const joined = shape.members.filter((key) => !before.members.includes(key));
			const left = before.members.filter((key) => !shape.members.includes(key));
			if (joined.length || left.length) this.emit("group.members", `group.members:${id}:${this.now()}`, {
				group: id,
				joined,
				left
			});
			this.pinned("group", id, before.pin, shape.pin);
			for (const [member, word] of Object.entries(shape.typing)) {
				const was = before.typing[member];
				if (was && was.kind === word.kind && was.status === word.status) continue;
				this.emit("group.typing.started", `group.typing.started:${id}:${member}:${this.now()}${was ? `:${this.seq + 1}` : ""}`, {
					group: id,
					member,
					...word
				});
			}
			for (const member of Object.keys(before.typing)) if (!shape.typing[member]) this.emit("group.typing.stopped", `group.typing.stopped:${id}:${member}:${this.now()}`, {
				group: id,
				member
			});
		}
		for (const id of [...this.groups.keys()]) {
			if (groups.has(id)) continue;
			this.groups.delete(id);
			if (!quiet) this.emit("group.removed", `group.removed:${id}`, { group: id });
		}
		for (const [id, payment] of Object.entries(state.payments ?? {})) {
			const shape = `${payment.state}|${payment.error ?? ""}|${payment.closed ? 1 : 0}`, before = this.payments.get(id);
			this.payments.set(id, shape);
			if (quiet || before === shape) continue;
			const json = paymentJson(payment);
			if (before === void 0) this.emit("payment.created", `payment.created:${id}`, {
				chat: payment.linkId,
				payment: json
			});
			else this.emit("payment.updated", `payment.updated:${id}:${payment.state}:${this.now()}`, {
				chat: payment.linkId,
				payment: json
			});
		}
		for (const link of state.links) for (const identity of link.identities?.received ?? []) {
			const key = `${link.id}:${identity.id}`, shape = identity.status, before = this.received.get(key);
			this.received.set(key, shape);
			if (quiet || before === shape) continue;
			this.emit(before === void 0 ? "identity.received" : "identity.status", `identity.${before === void 0 ? "received" : "status"}:${key}:${shape}`, {
				chat: link.id,
				identity: {
					id: identity.id,
					provider: identity.provider,
					subject: identity.subject,
					status: identity.status,
					verified: identity.verified
				}
			});
		}
		for (const [id, transfer] of Object.entries(state.transfers ?? {})) {
			const shape = `${transfer.state}|${transfer.stage ?? ""}`, before = this.transfers.get(id);
			this.transfers.set(id, shape);
			if (quiet || before === shape) continue;
			const chat = state.links.find((l) => id.startsWith(`${l.id}-`))?.id ?? null;
			const group = chat ? void 0 : state.groups.find((g) => id.startsWith(`group-${g.id}-`))?.id;
			const fields = {
				chat,
				...group ? { group } : {},
				file: id,
				direction: transfer.direction ?? (id.includes("-in-") ? "in" : "out"),
				size: transfer.size,
				transferred: transfer.transferred,
				...transfer.error ? { error: transfer.error } : {}
			};
			let emit = null;
			if (transfer.state === "done") {
				const key = `file.done:${id}`;
				emit = (messageId) => this.emit("file.done", key, {
					...fields,
					messageId
				});
			} else if (transfer.state === "failed") {
				const key = `file.failed:${id}:${this.now()}`;
				emit = (messageId) => this.emit("file.failed", key, {
					...fields,
					messageId,
					retry: !!transfer.retry
				});
			} else if (transfer.stage === "asking" && fields.direction === "in") {
				const key = `file.offered:${id}:${this.now()}`;
				emit = (messageId) => this.emit("file.offered", key, {
					...fields,
					messageId,
					room: transfer.room ?? null
				});
			} else if (transfer.stage) {
				const key = `file.stage:${id}:${transfer.stage}:${this.now()}`, stage = {
					stage: transfer.stage,
					...transfer.pausedBy ? { pausedBy: transfer.pausedBy } : {}
				};
				emit = (messageId) => this.emit("file.stage", key, {
					...fields,
					messageId,
					...stage
				});
			}
			if (emit) this.fileEvent(id, emit, chat ?? (group ? `group:${group}` : null));
		}
		this.state = state;
		for (const listener of this.stateListeners) try {
			listener(state);
		} catch {}
	}
	/**
	* Someone else pinned a message, or unpinned it (WISP 400 § Pinned message): `chat.pinned` or `group.pinned`, with
	* `messageId` (the row here; null when it is not here, or unpinned), `ref` (the id both sides know), `by` (`peer` or a
	* member key) and `removed`. What this profile pins itself says nothing: its command answered already.
	*/
	pinned(kind, id, before, now) {
		if (!now || now.by === "me" || before?.id === now.id && before.at === now.at) return;
		const fields = {
			[kind]: id,
			messageId: now.messageId ?? null,
			ref: now.id || null,
			by: now.by,
			removed: !now.id
		};
		this.emit(`${kind}.pinned`, `${kind}.pinned:${id}:${now.id || "off"}:${now.at}`, fields);
	}
	/**
	* A `file.*` event names the message that carries the file. The engine can say where a transfer stands before it
	* stores that message: the event then waits for it, up to 2 s, and goes with `messageId: null` after that.
	*/
	fileEvent(fileId, emit, chat) {
		const pending = this.pendingFiles.get(fileId);
		const messageId = this.fileMessages.get(fileId);
		if (messageId && !pending) {
			emit(messageId);
			return;
		}
		if (pending) {
			pending.emits.push(emit);
			return;
		}
		const timer = setTimeout(() => this.flushFile(fileId, null), FILE_MESSAGE_WAIT_MS);
		timer.unref?.();
		this.pendingFiles.set(fileId, {
			timer,
			emits: [emit]
		});
		const read = chat === null ? void 0 : this.unread.get(chat);
		if (!read) return;
		this.unread.delete(chat);
		read(chat).then((messages) => {
			for (const message of messages) {
				if (!message.file || this.fileMessages.has(message.file.id)) continue;
				this.fileMessages.set(message.file.id, message.id);
				this.flushFile(message.file.id, message.id);
			}
		}).catch(() => {});
	}
	flushFile(fileId, messageId) {
		const pending = this.pendingFiles.get(fileId);
		if (!pending) return;
		this.pendingFiles.delete(fileId);
		clearTimeout(pending.timer);
		for (const emit of pending.emits) emit(messageId);
	}
	/** Whether this side said something once in a chat (the join notice): kept with the seen set. */
	said(chat, what) {
		return this.seen.get(`said:${chat}`)?.has(what) ?? false;
	}
	markSaid(chat, what) {
		this.seenOf(`said:${chat}`).set(what, "yes");
		this.persist(`said:${chat}`, [[what, "yes"]]);
	}
	seenOf(chat) {
		let map = this.seen.get(chat);
		if (!map) this.seen.set(chat, map = /* @__PURE__ */ new Map());
		return map;
	}
	/** A chat's or group's whole history, or with `deleted` only what changed in it (then only those ids are gone). */
	messages(chat, messages, deleted) {
		const known = this.seenOf(chat);
		const group = chat.startsWith("group:") ? chat.slice(6) : null;
		const quiet = this.firstRun && !this.baselined || !!group && !deleted && messages.length === 0;
		const changes = [];
		const present = /* @__PURE__ */ new Set();
		this.reactions(chat, group, messages, quiet);
		const files = [];
		const cutoff = this.now() - SEEN_KEEP_MS;
		for (const message of messages) {
			present.add(message.id);
			if (message.file && this.fileMessages.get(message.file.id) !== message.id) {
				this.fileMessages.set(message.file.id, message.id);
				files.push([message.file.id, message.id]);
			}
			let state = stateOf(message);
			const note = known.get(message.id), before = note === void 0 ? void 0 : stateIn(note);
			const at = activityOf(message);
			const json = () => group ? groupMessageJson(message, this.state?.groups.find((g) => g.id === group)) : chatMessageJson(message, this.state?.links.find((l) => l.id === chat));
			if (before === void 0 && message.timestamp < cutoff) {
				if (at < cutoff) continue;
				const noted = noteOf(state, at);
				known.set(message.id, noted);
				changes.push([message.id, noted]);
				const edit = message.edit;
				if (quiet || !edit || edit.at < cutoff || message.sender === "me" && edit.restore) continue;
				if (group) this.emit("group.message.edited", `group.message.edited:${group}:${message.id}:${edit.seq}`, {
					group,
					messageId: message.id,
					edits: edit.seq,
					message: json()
				});
				else this.emit("message.edited", `message.edited:${chat}:${message.id}:${edit.seq}`, {
					chat,
					messageId: message.id,
					edits: edit.seq,
					message: json()
				});
				continue;
			}
			if (before !== void 0 && mentionedIn(before) && !mentionedIn(state)) state = withFlag(state, MENTIONED);
			if (before === state) {
				if (timeIn(note) === void 0) {
					const noted = noteOf(state, at);
					known.set(message.id, noted);
					changes.push([message.id, noted]);
				}
				continue;
			}
			const noted = noteOf(state, at);
			known.set(message.id, noted);
			changes.push([message.id, noted]);
			if (quiet) continue;
			if (before === void 0) {
				if (group) {
					const type = message.event ? "group.event" : message.sender === "peer" ? "group.message" : "group.sent";
					this.emit(type, `${type}:${group}:${message.id}`, {
						group,
						message: json()
					});
				} else {
					const notice = JOIN_NOTICE.exec(message.text);
					const type = notice ? message.sender === "peer" ? "chat.joined" : "chat.announced" : message.sender === "peer" ? "message.received" : "message.sent";
					this.emit(type, `${type}:${chat}:${message.id}`, {
						chat,
						message: json(),
						...notice ? { name: notice[1] ?? null } : {}
					});
				}
				if (message.sender === "peer" && message.press) this.pressed(chat, group, message, json());
				continue;
			}
			if (message.sender === "peer" && message.press && !pressedIn(before)) this.pressed(chat, group, message, json());
			if (group && mentionedIn(state) && !mentionedIn(before) && this.mentionsNoted) this.emit("group.mentioned", `group.mentioned:${group}:${message.id}`, {
				group,
				messageId: message.id,
				message: json()
			});
			if (group) {
				const [, edits] = splitState(state), [, edited] = splitState(before);
				if (edits > edited) this.emit("group.message.edited", `group.message.edited:${group}:${message.id}:${edits}`, {
					group,
					messageId: message.id,
					edits,
					message: json()
				});
			} else {
				const [delivery, edits] = splitState(state), [was, edited] = splitState(before);
				if (edits > edited && !(message.sender === "me" && message.edit?.restore)) this.emit("message.edited", `message.edited:${chat}:${message.id}:${edits}`, {
					chat,
					messageId: message.id,
					edits,
					message: json()
				});
				if (message.sender === "me" && delivery !== was) this.emit("message.delivery", `message.delivery:${chat}:${message.id}:${delivery}`, {
					chat,
					messageId: message.id,
					delivery,
					...message.deliveryError ? { error: message.deliveryError } : {}
				});
			}
		}
		for (const id of deleted ?? [...known.keys()]) {
			if (present.has(id) || !known.has(id)) continue;
			known.delete(id);
			changes.push([id, null]);
			if (!quiet) this.emit(group ? "group.deleted" : "message.deleted", `${group ? "group" : "message"}.deleted:${group ?? chat}:${id}`, group ? {
				group,
				messageId: id
			} : {
				chat,
				messageId: id
			});
		}
		if (changes.length) this.persist(chat, changes);
		for (const [fileId, messageId] of files) this.flushFile(fileId, messageId);
	}
	/**
	* A press on a button of a message of mine (WISP 406 · Message Buttons), after the reply's own event: the question
	* (`messageId`), the button, its label, who pressed (`by`: the chat, or a group member's key), `name` (the chat's name
	* here, as `chat list` gives it: its label, else the contact's own name; a group member's roster name) and the reply
	* (`replyId`). `untrusted.name` is the name the person gave themselves, as an agent turn's: theirs to choose, so
	* data, never instructions. The engine marks a reply a press only while the buttons were open for that person.
	*/
	pressed(chat, group, message, json) {
		const press = message.press;
		const link = group ? void 0 : this.state?.links.find((l) => l.id === chat);
		const name = group ? json.nick : link ? chatJson(link).name : null;
		this.emit("button.pressed", `button.pressed:${group ?? chat}:${message.id}`, {
			...group ? { group } : { chat },
			messageId: press.messageId,
			button: press.button,
			label: press.label,
			by: group ? message.member ?? null : chat,
			name: name ?? null,
			replyId: message.id,
			...press.inferred ? { inferred: true } : {},
			untrusted: { name: json.nick ?? null }
		});
	}
	/**
	* Reactions that changed (WISP 400 § Reactions): `message.reaction` in a chat, `group.reaction` in a group, one per
	* person and number; `emoji` "" when one was taken back. Kept apart from the messages' own seen set.
	*/
	reactions(chat, group, messages, quiet) {
		const key = `reactions:${chat}`, known = this.seenOf(key);
		const changes = [];
		const cutoff = this.now() - SEEN_KEEP_MS;
		for (const message of messages) for (const [by, r] of Object.entries(message.reactions ?? {})) {
			const id = `${message.id}|${by}`, value = String(r.n), note = known.get(id);
			const before = note === void 0 ? void 0 : stateIn(note);
			if (before === value) {
				if (timeIn(note) === void 0) {
					const noted = noteOf(value, r.at);
					known.set(id, noted);
					changes.push([id, noted]);
				}
				continue;
			}
			if (before === void 0 && r.at < cutoff) continue;
			const noted = noteOf(value, r.at);
			known.set(id, noted);
			changes.push([id, noted]);
			if (quiet || before === void 0 && !r.e) continue;
			const fields = {
				messageId: message.id,
				by,
				emoji: r.e,
				removed: !r.e,
				mine: message.sender === "me"
			};
			if (group) this.emit("group.reaction", `group.reaction:${group}:${message.id}:${by}:${r.n}`, {
				group,
				...fields
			});
			else this.emit("message.reaction", `message.reaction:${chat}:${message.id}:${by}:${r.n}`, {
				chat,
				...fields
			});
		}
		if (changes.length) this.persist(key, changes);
	}
	/**
	* Relaxed: nobody waits for it, and a note lost to a power cut is made again from the history at the next start
	* (its event is then reported a second time, as after a crash between a message's row and its note). A disk sync
	* for each one held the whole daemon for milliseconds, three times per message sent.
	*/
	persist(chat, changes) {
		const store = this.db.transaction(SEEN, "readwrite", { durability: "relaxed" }).objectStore(SEEN);
		for (const [id, state] of changes) if (state === null) store.delete([chat, id]);
		else store.put(state, [chat, id]);
	}
};
function deliveryOf(message) {
	return message.sender === "peer" ? "received" : message.delivery ?? "sent";
}
/** What a received button press adds to its delivery in the seen set (`received+p`): it is reported once. */
var PRESSED = "+p";
/** What a group message that mentions me adds (`received+m`): a mention learned late is reported once. */
var MENTIONED = "+m";
/** The seen set's own notes: whether it notes mentions (sets from before `+m` do not). */
var FORMAT = "format:";
var MENTIONS_NOTED = "mentions";
/** The seen set's mark that its notes carry their time. */
var AGES_NOTED = "ages";
/**
* A note: what the seen set keeps of a message (or a reaction's number), then `@` and the time of its last activity in
* base 36 (`received+p#e2@mg3k1x2a`), by which `sweep` drops it. A note from before has no time.
*/
var noteOf = (state, at) => `${state}@${Math.max(0, Math.floor(at)).toString(36)}`;
function stateIn(note) {
	const at = note.lastIndexOf("@");
	return at === -1 ? note : note.slice(0, at);
}
function timeIn(note) {
	const at = note.lastIndexOf("@");
	return at === -1 ? void 0 : parseInt(note.slice(at + 1), 36);
}
/** The last time a message changed here: it came, it was edited, someone reacted. */
function activityOf(message) {
	let at = Math.max(message.timestamp, message.edit?.at ?? 0);
	for (const r of Object.values(message.reactions ?? {})) at = Math.max(at, r.at ?? 0);
	return at;
}
/** A message that will not change by itself any more: received, or mine and delivered. */
function settled(state) {
	const delivery = splitState(state)[0].split("+")[0];
	return delivery === "received" || delivery === "delivered";
}
/**
* What the seen set keeps of a message: its delivery (`+p` once a press on a message of mine was reported, `+m` once a
* group message's mention of me was), and its edit number once edited (`sent#e3`, `received+p+m#e2`).
*/
function stateOf(message) {
	const peer = message.sender === "peer";
	const delivery = deliveryOf(message) + (peer && message.press ? PRESSED : "") + (peer && message.mentioned && message.linkId.startsWith("group:") ? MENTIONED : "");
	return message.edit ? `${delivery}#e${message.edit.seq}` : delivery;
}
var flagsOf = (state) => splitState(state)[0].split("+").slice(1).map((flag) => "+" + flag);
var pressedIn = (state) => flagsOf(state).includes(PRESSED);
var mentionedIn = (state) => flagsOf(state).includes(MENTIONED);
/** The state with a flag added before its edit number. */
function withFlag(state, flag) {
	const at = state.lastIndexOf("#e");
	return at === -1 ? state + flag : state.slice(0, at) + flag + state.slice(at);
}
function splitState(state) {
	const at = state.lastIndexOf("#e");
	return at === -1 ? [state, 0] : [state.slice(0, at), Number(state.slice(at + 2)) || 0];
}
function chatShape(link) {
	const view = chatJson(link);
	return {
		stage: view.stage,
		live: view.live,
		transport: view.transport,
		name: view.name,
		typing: !!link.peerTyping,
		typingKind: link.peerTyping ? link.peerTypingKind ?? "typing" : "typing",
		typingStatus: link.peerTyping ? link.peerTypingStatus ?? null : null,
		pin: link.pin ?? null
	};
}
/** A `typing.started`'s word: the kind, and the contact's status line when it gave one (already cleaned). */
function typingFields(shape) {
	return {
		kind: shape.typingKind,
		...shape.typingStatus ? { status: shape.typingStatus } : {}
	};
}
function groupShape(group) {
	return {
		status: group.status ?? (group.invitation ? "invited" : null),
		members: group.members.map((m) => m.key).sort(),
		typing: Object.fromEntries((group.typing ?? []).map((t) => [t.key, {
			kind: t.kind ?? "typing",
			...t.status ? { status: t.status } : {}
		}])),
		pin: group.pin ?? null
	};
}
/**
* The journal's whole lines within its last `JOURNAL_MAX_BYTES`, and its size: never the whole file as one string, so
* a journal grown past what a string can hold (or a trim's bound) is still read, and in bounded time.
*/
function journalTail(path) {
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		const from = Math.max(0, size - JOURNAL_MAX_BYTES - 1);
		const buffer = Buffer.alloc(size - from);
		let read = 0;
		while (read < buffer.length) {
			const n = readSync(fd, buffer, read, buffer.length - read, from + read);
			if (!n) break;
			read += n;
		}
		const lines = buffer.toString("utf8", 0, read).split("\n");
		if (from > 0) lines.shift();
		return {
			lines: lines.filter(Boolean),
			size
		};
	} finally {
		closeSync(fd);
	}
}
//#endregion
//#region src/runtime/fedimint.ts
/**
* The Fedimint client on Node (WISP 1100 § Wallet SDKs on Node): the app's own SDK and WebAssembly, each database in
* a `worker_threads` worker (fedimintWorker.mjs) and a file of the profile's `fedimint/` folder, where the browser has
* a module worker and the origin-private file system. Only the platform differs: the client and what the engine does
* with it are the app's.
*/
var WASM_PACKAGE = "@fedimint/fedimint-client-wasm-bundler";
var DATABASE = /^ghostly-fedimint-[\w-]{1,80}\.db$/;
/** The worker's file: beside this chunk wherever the bundler put it (the entry, or assets/), else the workspace's. */
function workerFile() {
	for (const place of ["./fedimintWorker.mjs", "./assets/fedimintWorker.mjs"]) {
		const url = new URL(place, import.meta.url);
		if (existsSync(fileURLToPath(url))) return url;
	}
	throw new Error("The Fedimint worker is missing from this build");
}
var compiling;
/** Compiled once per process (11 MB): each worker is handed the module, not the bytes. */
function compiled() {
	return compiling ??= WebAssembly.compile(readFileSync(createRequire(import.meta.url).resolve(`${WASM_PACKAGE}/fedimint_client_wasm_bg.wasm`))).catch((error) => {
		compiling = void 0;
		throw error;
	});
}
function databasePath(dir, database) {
	if (!DATABASE.test(database)) throw new Error("Invalid Fedimint database name");
	return join(dir, database);
}
/** The SDK on this profile's folder `dir`. Loaded on first use, as in the app: a bot that joins no federation compiles nothing. */
function nodeFedimintSdk(dir) {
	let loading;
	return () => loading ??= (async () => {
		const [{ Transport }, module] = await Promise.all([import("@fedimint/types"), compiled()]);
		mkdirSync(dir, {
			recursive: true,
			mode: 448
		});
		const glue = pathToFileURL(createRequire(import.meta.url).resolve(`${WASM_PACKAGE}/fedimint_client_wasm_bg.js`)).href;
		const worker = workerFile();
		class ThreadTransport extends Transport {
			logger = {
				debug() {},
				info() {},
				warn() {},
				error() {}
			};
			thread = new Worker(worker, { workerData: {
				dir,
				glue
			} });
			/** Why the thread ended, once it has: later requests fail with it rather than wait on nothing. */
			ended;
			constructor() {
				super();
				this.thread.on("message", (message) => this.messageHandler(message));
				this.thread.on("error", (error) => this.end(`The Fedimint client stopped: ${error instanceof Error && error.message || "unknown error"}`));
				this.thread.on("exit", () => this.end("The Fedimint client stopped"));
			}
			end(error) {
				if (this.ended) return;
				this.ended = error;
				this.messageHandler({
					type: "error",
					error
				});
			}
			postMessage(message) {
				const ended = this.ended;
				if (ended) {
					queueMicrotask(() => this.messageHandler({
						type: "error",
						error: ended,
						request_id: message.requestId
					}));
					return;
				}
				this.thread.postMessage(message.type === "init" ? {
					...message,
					payload: {
						...message.payload,
						module
					}
				} : message);
			}
			terminate() {
				this.ended ??= "The Fedimint client was closed";
				this.thread.terminate();
			}
		}
		return fedimintSdkOn({
			transport: async () => new ThreadTransport(),
			async exists(database) {
				try {
					return statSync(databasePath(dir, database)).size > 0;
				} catch {
					return false;
				}
			},
			async remove(database) {
				rmSync(databasePath(dir, database), { force: true });
			}
		});
	})().catch((error) => {
		loading = void 0;
		throw error;
	});
}
//#endregion
//#region src/runtime/fileFetch.ts
/**
* `fetch` for `file:` URLs, which Node's does not do. The wallet SDKs' WebAssembly (Bark, BDK, Breez, Iroh) is loaded
* the way a page loads it, `fetch(new URL("…wasm", import.meta.url))`; on Node that URL is a file beside the bundle.
* Only `.wasm` files are answered, and nothing else of fetch changes.
*/
function installFileFetch() {
	const original = globalThis.fetch;
	const patched = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.startsWith("file:")) {
			const parsed = new URL(url);
			if (!parsed.pathname.endsWith(".wasm") || parsed.search || parsed.hash) throw new TypeError(`Refusing to fetch ${url}`);
			const bytes = await readFile(fileURLToPath(parsed));
			return new Response(bytes, { headers: { "content-type": "application/wasm" } });
		}
		return original(input, init);
	};
	globalThis.fetch = patched;
}
//#endregion
//#region src/runtime/pushSend.ts
/** An address as bytes (4 or 16), or null when it is not one. */
function addressBytes(address) {
	const family = isIP(address);
	if (family === 4) return Uint8Array.from(address.split(".").map(Number));
	if (family !== 6) return null;
	let text = address.replace(/%.*$/, "");
	const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
	if (v4) {
		const [a, b, c, d] = v4[1].split(".").map(Number);
		text = text.slice(0, -v4[1].length) + (a << 8 | b).toString(16) + ":" + (c << 8 | d).toString(16);
	}
	const [head, tail] = text.includes("::") ? text.split("::") : [text, null];
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const groups = tail === null ? left : [
		...left,
		...Array(8 - left.length - right.length).fill("0"),
		...right
	];
	if (groups.length !== 8) return null;
	const bytes = /* @__PURE__ */ new Uint8Array(16);
	groups.forEach((group, i) => {
		const n = parseInt(group, 16);
		bytes[i * 2] = n >> 8;
		bytes[i * 2 + 1] = n & 255;
	});
	return bytes;
}
/** True when `address` is on the public Internet (see `isPublicAddress`). */
function isPublicIp(address) {
	const bytes = addressBytes(address);
	return bytes !== null && isPublicAddress(bytes);
}
/** `lookup` over `resolve` (`dns.lookup`), refusing a name any of whose addresses is not public. */
var publicOnly = (resolve) => (hostname, options, callback) => {
	resolve(hostname, {
		...options,
		all: true
	}, (error, found) => {
		if (error) return callback(error, "", 4);
		const addresses = found;
		if (!addresses.length || addresses.some((a) => !isPublicIp(a.address))) return callback(Object.assign(/* @__PURE__ */ new Error(`${hostname} is not a public address`), { code: "ENOTFOUND" }), "", 4);
		if (options.all) return callback(null, addresses);
		callback(null, addresses[0].address, addresses[0].family);
	});
};
var publicOnlyLookup = publicOnly(lookup$1);
/**
* Posts a wake-up (WISP 401 § Wake-up push) the way the Desktop does from Rust: only to a push service's endpoint
* (`checkPushEndpoint`), whose name must resolve to public addresses only, no redirect followed, no proxy, 10 s at most.
* Answers the push service's status.
*/
async function nodePushSend(push, lookup = publicOnlyLookup) {
	const url = checkPushEndpoint(push.url);
	return new Promise((resolve, reject) => {
		const req = request(url, {
			method: "POST",
			headers: {
				...push.headers,
				"Content-Length": String(push.body.length)
			},
			lookup,
			agent: false,
			timeout: 1e4
		}, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("timeout", () => req.destroy(/* @__PURE__ */ new Error("The push service did not answer")));
		req.on("error", reject);
		req.end(push.body);
	});
}
//#endregion
//#region src/runtime/rows.ts
/** The warning `node:sqlite` gives as it loads (experimental on Node 22 and 23): said once for every command, it is noise. */
var SQLITE_WARNING = /^SQLite is an experimental feature/;
var loaded;
/**
* `node:sqlite`, or null where Node has none (before 22.13 it needs a flag): the store then keeps every value in
* memory and in the snapshot, as before rows.db.
*/
function loadSqlite() {
	loaded ??= (async () => {
		const emit = process.emitWarning;
		process.emitWarning = function(warning, ...rest) {
			if (SQLITE_WARNING.test(typeof warning === "string" ? warning : warning?.message ?? "")) return;
			return emit.call(process, warning, ...rest);
		};
		try {
			return await import("node:sqlite");
		} catch {
			return null;
		} finally {
			process.emitWarning = emit;
		}
	})();
	return loaded;
}
/** Format 2's rows, read. */
function openRowFile(sqlite, path) {
	const db = new sqlite.DatabaseSync(path);
	db.exec("CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY, value BLOB NOT NULL)");
	const select = db.prepare("SELECT value FROM rows WHERE id = ?");
	return {
		get(id) {
			const row = select.get(id);
			if (!row) throw new Error(`The store's rows.db has no row ${id}: the profile's store is damaged`);
			return deserialize(row.value);
		},
		count() {
			return Number(db.prepare("SELECT count(*) AS n FROM rows").get().n);
		},
		close() {
			db.close();
		}
	};
}
/** Where a record of format 2 has its value. */
var ROW = Symbol("ghostly.row");
/** Records of a snapshot of format 2, whose value is read from `rows` (a getter shared by all of them). */
function rowRecords(rows) {
	const read = function() {
		return rows.get(this[ROW]);
	};
	const proto = Object.defineProperty({}, "value", {
		get: read,
		enumerable: true,
		configurable: true
	});
	return { make(key, row) {
		const record = Object.create(proto);
		record.key = key;
		record[ROW] = row;
		return record;
	} };
}
//#endregion
//#region src/runtime/keyBytes.ts
/**
* An IndexedDB key as bytes whose order is the keys' own (W3C IndexedDB § Compare two keys: a number before a date
* before a string before binary before an array; strings by UTF-16 code unit; arrays item by item, the shorter
* first), so that SQLite, comparing them as blobs, sorts and ranges them as IndexedDB does. Held as a "latin1" string
* (one char per byte): JavaScript compares those in the same order.
*
* Every encoding is prefix-free (numbers and dates are 9 bytes; strings, binary and arrays end with a 0 byte no unit or
* item begins with), so a key followed by another (an index entry's key, then its record's) sorts as the pair does.
*/
var NUMBER = 16;
var DATE = 32;
var STRING = 48;
var BINARY = 64;
var ARRAY = 80;
function keyBytes(key) {
	const out = [];
	write(key, out, 0);
	let text = "";
	for (let at = 0; at < out.length; at += 8192) text += String.fromCharCode(...out.slice(at, at + 8192));
	return text;
}
function write(key, out, depth) {
	if (depth > 1e3) throw new Error("A key nested too deep");
	if (typeof key === "number") {
		out.push(NUMBER);
		number(key, out);
		return;
	}
	if (key instanceof Date) {
		out.push(DATE);
		number(key.getTime(), out);
		return;
	}
	if (typeof key === "string") {
		out.push(STRING);
		for (let at = 0; at < key.length; at++) {
			const unit = key.charCodeAt(at);
			if (unit < 126) out.push(unit + 1);
			else out.push(127, (unit >> 12) + 1, (unit >> 6 & 63) + 1, (unit & 63) + 1);
		}
		out.push(0);
		return;
	}
	if (key instanceof ArrayBuffer || ArrayBuffer.isView(key)) {
		const bytes = key instanceof ArrayBuffer ? new Uint8Array(key) : new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
		out.push(BINARY);
		for (const byte of bytes) out.push((byte >> 4) + 1, (byte & 15) + 1);
		out.push(0);
		return;
	}
	if (Array.isArray(key)) {
		out.push(ARRAY);
		for (const item of key) write(item, out, depth + 1);
		out.push(0);
		return;
	}
	throw new Error("Not an IndexedDB key");
}
var view = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(8));
/** A float64 big-endian, its sign bit flipped (a positive number) or every bit flipped (a negative one): bytes in the numbers' order. */
function number(value, out) {
	view.setFloat64(0, value === 0 ? 0 : value);
	const negative = (view.getUint8(0) & 128) !== 0;
	for (let at = 0; at < 8; at++) {
		const byte = view.getUint8(at);
		out.push(negative ? ~byte & 255 : at === 0 ? byte ^ 128 : byte);
	}
}
//#endregion
//#region src/runtime/sqlTree.ts
var buffer = (bytes) => Buffer.from(bytes, "latin1");
/**
* Values just read from rows.db, which nothing else holds: fake-indexeddb copies each value it hands out, and for these
* the copy is a second one (v8 made the first), 7.6 s of a 30 s profile of sends in a chat of 15,000. A value that goes
* into a layer leaves the set: from then on the store holds it.
*/
var fresh = /* @__PURE__ */ new WeakSet();
function thaw(bytes) {
	const value = deserialize(bytes);
	if (value && typeof value === "object") fresh.add(value);
	return value;
}
/** A value to hand out: one just read from rows.db as it is, once; any other a copy, as fake-indexeddb makes. */
function handOut(value) {
	return value && typeof value === "object" && fresh.delete(value) ? value : structuredClone(value);
}
/** rows.db's trees: the stores kept on disk and their indexes, each a tree id in `entries`. */
var TreeFile = class {
	db;
	constraintError;
	/** The transaction whose writes come now (its rollback log), set by `storage.ts` around each; null for one without. */
	owner = null;
	live = /* @__PURE__ */ new Set();
	get;
	count;
	put;
	remove;
	empty;
	/** `range`'s page reads by their SQL: a few shapes (direction, bounds), each prepared once. */
	pages = /* @__PURE__ */ new Map();
	constructor(db, constraintError) {
		this.db = db;
		this.constraintError = constraintError;
		db.exec(`
      CREATE TABLE IF NOT EXISTS trees (id INTEGER PRIMARY KEY, db TEXT NOT NULL, store TEXT NOT NULL, idx TEXT NOT NULL, UNIQUE (db, store, idx));
      CREATE TABLE IF NOT EXISTS entries (tree INTEGER NOT NULL, id BLOB NOT NULL, pv BLOB, key BLOB NOT NULL, value BLOB NOT NULL, PRIMARY KEY (tree, id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS entries_by_value ON entries (tree, pv) WHERE pv IS NOT NULL;
      CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value) WITHOUT ROWID;
    `);
		this.get = db.prepare("SELECT key, value FROM entries WHERE tree = ? AND id = ?");
		this.count = db.prepare("SELECT count(*) AS n FROM entries WHERE tree = ?");
		this.put = db.prepare("INSERT OR REPLACE INTO entries (tree, id, pv, key, value) VALUES (?, ?, ?, ?, ?)");
		this.remove = db.prepare("DELETE FROM entries WHERE tree = ? AND id = ?");
		this.empty = db.prepare("DELETE FROM entries WHERE tree = ?");
	}
	/** The tree of a store (`index` "") or of one of its indexes, made when it is new. */
	treeId(db, store, index = "") {
		const found = this.db.prepare("SELECT id FROM trees WHERE db = ? AND store = ? AND idx = ?").get(db, store, index);
		if (found) return Number(found.id);
		return Number(this.db.prepare("INSERT INTO trees (db, store, idx) VALUES (?, ?, ?)").run(db, store, index).lastInsertRowid);
	}
	tree(id, keysAreUnique, index) {
		const tree = new SqlTree(this, id, keysAreUnique, index);
		this.live.add(tree);
		return tree;
	}
	/** The last journal entry whose writes SQLite holds. */
	applied() {
		const row = this.db.prepare("SELECT value FROM meta WHERE name = 'applied'").get();
		return row ? Number(row.value) : 0;
	}
	/** A finished transaction's layers, numbered as its journal entry: they wait for `apply`. */
	complete(owner, seq) {
		for (const tree of this.live) tree.complete(owner, seq);
	}
	/** An aborted transaction's layers go, and what it wrote with them. */
	abort(owner) {
		for (const tree of this.live) tree.abort(owner);
	}
	/** The layers of the journal's entries up to `upTo` into SQLite, in one transaction that says so (`applied`). */
	apply(upTo) {
		const due = [...this.live].filter((tree) => tree.due(upTo));
		if (!due.length) return;
		this.db.exec("BEGIN");
		try {
			let top = 0;
			for (const tree of due) top = Math.max(top, tree.write(upTo));
			this.db.prepare("INSERT OR REPLACE INTO meta (name, value) VALUES ('applied', max(?, coalesce((SELECT value FROM meta WHERE name = 'applied'), 0)))").run(top);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		for (const tree of due) tree.settle(upTo);
	}
	/** Whether a store (`index` "") or one of its indexes has its tree here (a snapshot of format 3 names ones that must). */
	has(db, store, index = "") {
		return this.db.prepare("SELECT 1 FROM trees WHERE db = ? AND store = ? AND idx = ?").get(db, store, index) !== void 0;
	}
	/** Everything SQLite holds is on disk: before a snapshot takes the place of the journal that had it. */
	sync() {
		this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	}
	/** Trees whose store or index is gone from the schema (deleted, a database removed) go, with their entries. */
	sweep(keep) {
		const ids = this.db.prepare("SELECT id FROM trees").all().map((row) => Number(row.id)).filter((id) => !keep.has(id));
		if (!ids.length) return;
		this.db.exec("BEGIN");
		try {
			for (const id of ids) {
				this.empty.run(id);
				this.db.prepare("DELETE FROM trees WHERE id = ?").run(id);
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		for (const tree of this.live) if (!keep.has(tree.id)) this.live.delete(tree);
	}
	/** Writes a tree's entries as they are, outside any transaction's layer (moving a store from memory). */
	load(id, entries, index, keysAreUnique) {
		this.empty.run(id);
		for (const entry of entries) this.row(id, entry, index, keysAreUnique);
	}
	/** @internal */
	row(id, entry, index, keysAreUnique) {
		const key = keyBytes(entry.key);
		const bytes = keysAreUnique ? key : key + keyBytes(entry.value);
		this.put.run(id, buffer(bytes), index ? buffer(keyBytes(entry.value)) : null, serialize(entry.key), serialize(entry.value));
	}
	/** @internal */
	read(id, bytes) {
		const row = this.get.get(id, buffer(bytes));
		return row && {
			key: deserialize(row.key),
			value: thaw(row.value)
		};
	}
	/** @internal */
	size(id) {
		return Number(this.count.get(id).n);
	}
	/** @internal */
	drop(id, bytes) {
		this.remove.run(id, buffer(bytes));
	}
	/** @internal */
	clearRows(id) {
		this.empty.run(id);
	}
	/** @internal The index entries whose record key's bytes are from `lower` up to (not with) `upper`, either one open. */
	withValue(id, lower, upper) {
		const where = ["tree = ?", "pv IS NOT NULL"], args = [id];
		if (lower !== void 0) {
			where.push("pv >= ?");
			args.push(buffer(lower));
		}
		if (upper !== void 0) {
			where.push("pv < ?");
			args.push(buffer(upper));
		}
		const sql = `SELECT key, value FROM entries INDEXED BY entries_by_value WHERE ${where.join(" AND ")}`;
		let statement = this.pages.get(sql);
		if (!statement) this.pages.set(sql, statement = this.db.prepare(sql));
		return statement.all(...args).map((row) => ({
			key: deserialize(row.key),
			value: thaw(row.value)
		}));
	}
	/** @internal */
	/**
	* The entries between two ids, a page at a time: no statement stays open between pages, so a read that takes the
	* first entry and stops (fake-indexeddb's `get`) leaves nothing that would lock the table for a later write.
	*/
	*range(id, lower, upper, descending) {
		let from = descending ? upper : lower, first = true, size = 8;
		for (;;) {
			const where = ["tree = ?"], args = [id];
			const low = descending ? lower : from, high = descending ? from : upper;
			if (low !== void 0) {
				where.push(!descending && !first ? "id > ?" : "id >= ?");
				args.push(buffer(low));
			}
			if (high !== void 0) {
				where.push("id < ?");
				args.push(buffer(high));
			}
			args.push(size);
			const sql = `SELECT id, key, value FROM entries WHERE ${where.join(" AND ")} ORDER BY id ${descending ? "DESC" : "ASC"} LIMIT ?`;
			let statement = this.pages.get(sql);
			if (!statement) this.pages.set(sql, statement = this.db.prepare(sql));
			const rows = statement.all(...args);
			for (const row of rows) yield [Buffer.from(row.id).toString("latin1"), {
				key: deserialize(row.key),
				value: thaw(row.value)
			}];
			if (rows.length < size) return;
			from = Buffer.from(rows.at(-1).id).toString("latin1");
			first = false;
			size = Math.min(size * 4, 512);
		}
	}
};
var SqlTree = class {
	file;
	id;
	_keysAreUnique;
	index;
	pending = [];
	active = null;
	constructor(file, id, _keysAreUnique, index) {
		this.file = file;
		this.id = id;
		this._keysAreUnique = _keysAreUnique;
		this.index = index;
	}
	idOf(entry) {
		const key = keyBytes(entry.key);
		return this._keysAreUnique ? key : key + keyBytes(entry.value);
	}
	layer() {
		const owner = this.file.owner;
		if (this.active) {
			if (owner && this.active.owner && this.active.owner !== owner) throw new Error("Two transactions wrote one store kept on disk at once");
			if (owner && !this.active.owner) this.active.owner = owner;
			return this.active;
		}
		return this.active = {
			owner,
			seq: 0,
			cleared: false,
			puts: /* @__PURE__ */ new Map(),
			byValue: /* @__PURE__ */ new Map()
		};
	}
	/** An entry (or its removal, `entry` null) in this transaction's layer; an index's by its record key too. */
	set(bytes, record, entry) {
		if (entry?.value && typeof entry.value === "object") fresh.delete(entry.value);
		const layer = this.layer();
		layer.puts.set(bytes, entry);
		if (!this.index) return;
		const value = keyBytes(record.value);
		let ids = layer.byValue.get(value);
		if (!ids) layer.byValue.set(value, ids = /* @__PURE__ */ new Set());
		ids.add(bytes);
	}
	/** Newest first: the layer that has the entry says what it is; one cleared hides everything older. */
	lookup(bytes) {
		const layers = this.active ? [...this.pending, this.active] : this.pending;
		for (let at = layers.length - 1; at >= 0; at--) {
			const layer = layers[at];
			if (layer.puts.has(bytes)) return layer.puts.get(bytes) ?? null;
			if (layer.cleared) return null;
		}
	}
	size() {
		let hidden = false;
		const map = /* @__PURE__ */ new Map();
		for (const layer of this.active ? [...this.pending, this.active] : this.pending) {
			if (layer.cleared) {
				hidden = true;
				map.clear();
			}
			for (const [bytes, entry] of layer.puts) map.set(bytes, entry);
		}
		let size = hidden ? 0 : this.file.size(this.id);
		for (const [bytes, entry] of map) {
			const below = !hidden && this.file.read(this.id, bytes) !== void 0;
			if (entry && !below) size++;
			else if (!entry && below) size--;
		}
		return size;
	}
	get(record) {
		const bytes = this.idOf(record);
		const found = this.lookup(bytes);
		if (found !== void 0) return found ?? void 0;
		return this.file.read(this.id, bytes);
	}
	contains(record) {
		return this.get(record) !== void 0;
	}
	put(record, noOverwrite = false) {
		if (holdsBlob(record.value)) throw new Error("A store kept in rows.db takes no Blob");
		const existing = this.get(record);
		if (existing !== void 0 && noOverwrite) throw new this.file.constraintError();
		this.set(this.idOf(record), record, record);
		return existing;
	}
	delete(record) {
		if (this.get(record) === void 0) return;
		this.set(this.idOf(record), record, null);
	}
	clear() {
		const layer = this.layer();
		layer.puts.clear();
		layer.byValue.clear();
		layer.cleared = true;
	}
	*getAllRecords(descending = false) {
		yield* this.getRecords(void 0, descending);
	}
	*getRecords(range, descending = false) {
		if (this._keysAreUnique && range && onlyBytes(range) !== void 0) {
			const found = this.get({
				key: range.lower,
				value: void 0
			});
			if (found) yield found;
			return;
		}
		const [lower, upper] = bounds(range);
		let hidden = false;
		const map = /* @__PURE__ */ new Map();
		for (const layer of this.active ? [...this.pending, this.active] : this.pending) {
			if (layer.cleared) {
				hidden = true;
				map.clear();
			}
			for (const [bytes, entry] of layer.puts) map.set(bytes, entry);
		}
		const over = [...map].filter(([bytes]) => (lower === void 0 || bytes >= lower) && (upper === void 0 || bytes < upper)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
		if (descending) over.reverse();
		const base = hidden ? void 0 : this.file.range(this.id, lower, upper, descending);
		let next = base?.next();
		let at = 0;
		for (;;) {
			const below = next && !next.done ? next.value : void 0;
			const above = over[at];
			if (!below && !above) return;
			if (above && (!below || (descending ? above[0] >= below[0] : above[0] <= below[0]))) {
				if (below && above[0] === below[0]) next = base.next();
				at++;
				if (above[1]) yield above[1];
			} else {
				yield below[1];
				next = base.next();
			}
		}
	}
	/**
	* The index entries whose record key (`value`) is in `range`, looked up by its bytes, not walked: removing a chat
	* (its messages' keys from [chat] to [chat, []]) read every message of the profile, 1.5 s at 100,000.
	*/
	deleteByValue(range) {
		const [lower, upper] = bounds(range);
		const only = onlyBytes(range);
		const candidates = this.index ? [...this.file.withValue(this.id, lower, upper), ...this.overlayWithValue(lower, upper, only)] : [...this.getAllRecords()];
		const deleted = [], seen = /* @__PURE__ */ new Set();
		for (const candidate of candidates) {
			const bytes = this.idOf(candidate);
			if (seen.has(bytes) || !range.includes(candidate.value)) continue;
			seen.add(bytes);
			const current = this.get(candidate);
			if (!current) continue;
			this.set(bytes, current, null);
			deleted.push(current);
		}
		return deleted;
	}
	/**
	* The entries of the layers whose record key's bytes are between these (as `withValue`), or are `only`'s. A
	* transaction that wrote over k records walked every entry of its layer k times: 16,000 took 6.6 s.
	*/
	overlayWithValue(lower, upper, only) {
		const out = [];
		const take = (layer, ids) => {
			for (const bytes of ids) {
				const entry = layer.puts.get(bytes);
				if (entry) out.push(entry);
			}
		};
		for (const layer of this.active ? [...this.pending, this.active] : this.pending) {
			if (only !== void 0) {
				const ids = layer.byValue.get(only);
				if (ids) take(layer, ids);
				continue;
			}
			for (const [value, ids] of layer.byValue) {
				if (lower !== void 0 && value < lower || upper !== void 0 && value >= upper) continue;
				take(layer, ids);
			}
		}
		return out;
	}
	/** @internal */
	complete(owner, seq) {
		if (!this.active || this.active.owner !== owner && this.active.owner !== null) return;
		this.active.seq = seq;
		this.pending.push(this.active);
		this.active = null;
	}
	/** @internal */
	abort(owner) {
		if (this.active && (this.active.owner === owner || this.active.owner === null)) this.active = null;
	}
	/** @internal */
	due(upTo) {
		return this.pending.length > 0 && this.pending[0].seq <= upTo;
	}
	/** @internal */
	write(upTo) {
		let top = 0;
		for (const layer of this.pending) {
			if (layer.seq > upTo) break;
			top = layer.seq;
			if (layer.cleared) this.file.clearRows(this.id);
			for (const [bytes, entry] of layer.puts) if (entry) this.file.row(this.id, entry, this.index, this._keysAreUnique);
			else this.file.drop(this.id, bytes);
		}
		return top;
	}
	/** @internal */
	settle(upTo) {
		while (this.pending.length && this.pending[0].seq <= upTo) this.pending.shift();
	}
	/** Whether a transaction's writes are still waiting here (a snapshot then waits for them). */
	get busy() {
		return this.active !== null || this.pending.length > 0;
	}
};
/**
* rows.db, owner-only (SQLite makes its WAL files with the database's mode), in WAL with NORMAL: the journal makes a
* transaction durable, and `sync` runs before a snapshot takes the journal's place. With `secure_delete` SQLite zeroes
* what a delete frees: a message or chat deleted is not left readable in the file's free pages after the fold.
*/
function openTreeFile(sqlite, path, constraintError) {
	closeSync(openSync(path, "a", 384));
	const db = new sqlite.DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA secure_delete = ON");
	return new TreeFile(db, constraintError);
}
/** A range's keys as bytes: from the first (in) up to the second (out), undefined where it is open. */
function bounds(range) {
	return [range?.lower === void 0 ? void 0 : keyBytes(range.lower) + (range.lowerOpen ? "ÿ" : ""), range?.upper === void 0 ? void 0 : keyBytes(range.upper) + (range.upperOpen ? "" : "ÿ")];
}
/** A range of one key (IDBKeyRange.only, or a bound with the same key at both ends, both in): that key's bytes. */
function onlyBytes(range) {
	if (range.lower === void 0 || range.upper === void 0 || range.lowerOpen || range.upperOpen) return void 0;
	const lower = keyBytes(range.lower);
	return keyBytes(range.upper) === lower ? lower : void 0;
}
function holdsBlob(value, depth = 0) {
	if (value instanceof Blob) return true;
	if (!value || typeof value !== "object" || depth > 32 || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
	if (value instanceof Map) {
		for (const [k, v] of value) if (holdsBlob(k, depth + 1) || holdsBlob(v, depth + 1)) return true;
		return false;
	}
	for (const item of Object.values(value)) if (holdsBlob(item, depth + 1)) return true;
	return false;
}
//#endregion
//#region src/runtime/storage.ts
var SNAPSHOT = "snapshot.bin";
var JOURNAL = "journal.bin";
var ROWS = "rows.db";
/**
* The stores kept in `rows.db` by default: the engine's messages, and each file's state (its transfer and files/3
* record), which grew the heap by every file ever sent or received. Not the files store: a file small enough to hold
* whole is a Blob in its record, which SQLite does not take.
*/
var ON_DISK = /* @__PURE__ */ new Set(["messages", "fileState"]);
/** A journal past this is folded into the snapshot at the next quiet moment. */
var COMPACT_BYTES = 33554432;
/** A journal up to this is kept at close and at start: replaying it costs less than writing the snapshot again. */
var KEEP_BYTES = 1048576;
/**
* The database a journal's close mark names. No profile has it, so a replay skips the mark (an older version's too:
* it skips an op whose store it does not find).
*/
var CLOSED = "__ghostly_closed__";
/** The database a journal's first entry names, with the snapshot the journal follows: skipped by a replay as the mark is. */
var FOLLOWS = "__ghostly_journal__";
/** The database an entry's first op names, with the entry's number (`seq`): SQLite's trees hold the entries up to theirs. */
var SEQ = "__ghostly_entry__";
/** How long `close` waits for the transactions still running: one left open for good does not keep the process. */
var CLOSE_WAIT_MS = 5e3;
/** How long a relaxed transaction's entry may wait for a sync when no other transaction brings one. */
var RELAXED_SYNC_MS = 1e3;
var BLOB = "__ghostlyBlob";
var RANGE = "__ghostlyRange";
var PROBE = "__ghostly_storage_probe__";
/**
* Opens the store in `dir` (created 0700; files 0600) and installs it as this process's `indexedDB` and
* `IDBKeyRange`. Call once, before anything touches IndexedDB.
*/
async function openPersistentIndexedDb(dir, options = {}) {
	mkdirSync(dir, {
		recursive: true,
		mode: 448
	});
	const factory = new IDBFactory();
	const raw = factory;
	const classes = await probeClasses(factory);
	dropIndexEntriesByRecord(classes, (a, b) => factory.cmp(a, b));
	readWithoutCopy(classes);
	const order = keyOrder((a, b) => factory.cmp(a, b));
	const rowsPath = join(dir, ROWS);
	const rowsFound = existsSync(rowsPath);
	const sqlite = await loadSqlite();
	const trees = sqlite ? openTreeFile(sqlite, rowsPath, classes.constraintError) : null;
	const onDisk = options.rowsOnDisk ?? ((_db, store) => ON_DISK.has(store));
	const disk = (store) => trees !== null && raw._databases.get(store.rawDatabase.name) === store.rawDatabase && onDisk(store.rawDatabase.name, store.name);
	/** The number of the last journal entry made: SQLite says which ones its trees hold (`TreeFile.applied`). */
	let seq = trees?.applied() ?? 0;
	let writing = true;
	let restoring = true;
	let journalFd = null;
	let queue = Promise.resolve();
	let queued = 0;
	let schemaDirty = false;
	/** A write to the journal or the snapshot failed: what is held is not all on disk, and only a whole snapshot makes it so. */
	let unsaved = false;
	/** Set while the journal holds relaxed entries no sync has covered yet. */
	let relaxed = null;
	const pending = /* @__PURE__ */ new WeakMap();
	const snapshotPath = join(dir, SNAPSHOT);
	const journalPath = join(dir, JOURNAL);
	const snapshotFound = existsSync(snapshotPath), journalFound = existsSync(journalPath);
	const saved = snapshotFound ? deserialize(readFileSync(snapshotPath)) : null;
	const rows = sqlite && saved?.format === 2 && rowsFound ? openRowFile(sqlite, rowsPath) : null;
	/** Stores kept on disk that a snapshot of format 1 had inline, written straight into rows.db by `restore`. */
	let restoredToDisk = false;
	try {
		if (saved) restoredToDisk = restore(classes, raw._databases, saved, order, {
			trees,
			rows,
			made: rows ? rowRecords(rows) : null,
			rowsFound,
			attach: attachTrees,
			onDisk
		});
	} catch (error) {
		rows?.close();
		trees?.db.close();
		if (!rowsFound) for (const file of [
			rowsPath,
			`${rowsPath}-wal`,
			`${rowsPath}-shm`
		]) rmSync(file, { force: true });
		throw error;
	}
	/** The name of the snapshot on disk, which its journal begins with. */
	let snapshotName = saved?.journal;
	let journal = journalFound ? readFileSync(journalPath) : null;
	const named = journal ? follows(journal) : void 0;
	const folded = named !== void 0 && snapshotName !== void 0 && named !== snapshotName;
	if (folded) {
		rmSync(journalPath, { force: true });
		journal = null;
	}
	const replayed = journal ? replay(raw._databases, journal, order, {
		applied: restoredToDisk ? 0 : seq,
		onTrees
	}) : {
		end: 0,
		closed: !folded,
		seq: 0
	};
	seq = Math.max(seq, replayed.seq);
	if (trees) {
		trees.complete(null, seq);
		trees.apply(seq);
	}
	let moved = restoredToDisk;
	if (trees) {
		for (const db of raw._databases.values()) for (const store of db.rawObjectStores.values()) if (!store.deleted && disk(store) && !onTrees(store)) {
			toDisk(store);
			moved = true;
		}
	}
	restoring = false;
	/** Whether the journal on disk says the store is closed: nothing was written since its mark, or there is none. */
	let marked = replayed.closed;
	const kept = !!journal && named !== void 0 && named === snapshotName && replayed.end === journal.length && journal.length <= KEEP_BYTES;
	const rewrite = journal && !kept || !snapshotFound || moved;
	if (rewrite) await writeSnapshot();
	rows?.close();
	if (rows && rewrite) trees.db.exec("DROP TABLE IF EXISTS rows");
	const storeProto = classes.ObjectStore.prototype;
	const storeRecord = storeProto.storeRecord;
	const deleteRecord = storeProto.deleteRecord;
	const clear = storeProto.clear;
	const opsOf = (log) => {
		let ops = pending.get(log);
		if (!ops) pending.set(log, ops = []);
		return ops;
	};
	/**
	* A write to a store kept on disk goes to its trees' layer of this transaction (its rollback log names it): a store
	* made since the open (an upgrade) moves to the trees at its first write.
	*/
	function owned(store, rollbackLog, work) {
		if (!disk(store)) return work();
		if (!onTrees(store)) toDisk(store);
		if (!rollbackLog) return work();
		trees.owner = rollbackLog;
		try {
			return work();
		} finally {
			trees.owner = null;
		}
	}
	storeProto.storeRecord = function(record, noOverwrite, rollbackLog) {
		const key = owned(this, rollbackLog, () => storeRecord.call(this, record, noOverwrite, rollbackLog));
		if (rollbackLog && !restoring) opsOf(rollbackLog).push({
			db: this.rawDatabase.name,
			store: this.name,
			kind: "put",
			key,
			value: record.value
		});
		return key;
	};
	storeProto.deleteRecord = function(key, rollbackLog) {
		owned(this, rollbackLog, () => deleteRecord.call(this, key, rollbackLog));
		if (rollbackLog && !restoring) opsOf(rollbackLog).push({
			db: this.rawDatabase.name,
			store: this.name,
			kind: "delete",
			key: keyToDisk(key)
		});
	};
	storeProto.clear = function(rollbackLog) {
		owned(this, rollbackLog, () => clear.call(this, rollbackLog));
		if (rollbackLog && !restoring) opsOf(rollbackLog).push({
			db: this.rawDatabase.name,
			store: this.name,
			kind: "clear"
		});
	};
	const indexProto = classes.Index.prototype;
	const initialize = indexProto.initialize;
	indexProto.initialize = function(transaction) {
		const store = this.rawObjectStore;
		if (disk(store) && onTrees(store) && !(this.records.records instanceof SqlTree)) {
			const tree = trees.tree(trees.treeId(store.rawDatabase.name, store.name, this.name), this.records.keysAreUnique, true);
			tree.clear();
			attachTree(this.records, tree, true);
		}
		return initialize.call(this, transaction);
	};
	const txProto = IDBTransaction.prototype;
	const dispatch = txProto.dispatchEvent;
	txProto.dispatchEvent = function(event) {
		if (event.type === "complete" && writing) {
			if (this.mode === "versionchange") {
				schemaDirty = true;
				if (trees) {
					trees.complete(this._rollbackLog, ++seq);
					written(seq);
				}
			} else {
				const ops = pending.get(this._rollbackLog);
				if (ops?.length) {
					const entry = ++seq;
					trees?.complete(this._rollbackLog, entry);
					append(ops, this.durability === "relaxed", entry);
				}
			}
			pending.delete(this._rollbackLog);
			if (schemaDirty) enqueue(writeSnapshot);
		} else if (event.type === "abort") {
			pending.delete(this._rollbackLog);
			trees?.abort(this._rollbackLog);
		}
		const dispatched = dispatch.call(this, event);
		if ((event.type === "complete" || event.type === "abort") && this._state === "finished") {
			const list = this.db._rawDatabase.transactions;
			const at = list.indexOf(this);
			if (at >= 0) list.splice(at, 1);
		}
		return dispatched;
	};
	const deleteDatabase = factory.deleteDatabase.bind(factory);
	factory.deleteDatabase = (name) => {
		const request = deleteDatabase(name);
		request.addEventListener("success", () => {
			schemaDirty = true;
			enqueue(writeSnapshot);
		});
		return request;
	};
	/** A committed transaction's entry, numbered `entry` (its first op says so, where there are trees). */
	function append(ops, lazy, entry) {
		if (trees) ops = [{
			db: SEQ,
			store: "",
			kind: "clear",
			seq: entry
		}, ...ops];
		if (queued === 0 && !ops.some((op) => op.kind === "put" && hasBlob(op.value))) {
			if (writeEntry(serialize(ops), lazy)) written(entry);
			return;
		}
		enqueue(async () => {
			if (writeEntry(serialize(await Promise.all(ops.map(async (op) => op.kind === "put" ? {
				...op,
				value: await blobsToDisk(op.value)
			} : op))), lazy)) written(entry);
		});
	}
	/**
	* The journal has entry `entry`: the trees' layers up to it go to SQLite. One that fails stays in memory, where reads
	* find it, and goes with the next entry, or before the next snapshot (which fails without it).
	*/
	function written(entry) {
		if (!trees || !writing) return;
		try {
			trees.apply(entry);
		} catch (error) {
			failed(error);
		}
	}
	/** Whether a store's records are in the trees already. */
	function onTrees(store) {
		return store.records.records instanceof SqlTree;
	}
	/** A tree in place of fake-indexeddb's in a record store; its `clear` and (an index's) `deleteByValue` with it. */
	function attachTree(records, tree, index) {
		records.records = tree;
		records.clear = () => {
			const deleted = [...tree.getAllRecords()];
			tree.clear();
			return deleted;
		};
		if (index) records.deleteByValue = (key) => tree.deleteByValue(key instanceof IDBKeyRange ? key : IDBKeyRange.only(key));
	}
	/** A store whose records and index entries are in rows.db already (a snapshot of format 3): its trees attached. */
	function attachTrees(store) {
		const db = store.rawDatabase.name;
		attachTree(store.records, trees.tree(trees.treeId(db, store.name), true, false), false);
		for (const index of store.rawIndexes.values()) if (!index.deleted) attachTree(index.records, trees.tree(trees.treeId(db, store.name, index.name), index.records.keysAreUnique, true), true);
	}
	/** A store kept on disk, held in memory: its records and index entries written to rows.db, its trees in place. */
	function toDisk(store) {
		const db = store.rawDatabase.name;
		const indexes = [...store.rawIndexes.values()].filter((index) => !index.deleted);
		const id = trees.treeId(db, store.name), ids = indexes.map((index) => trees.treeId(db, store.name, index.name));
		trees.db.exec("BEGIN");
		try {
			trees.load(id, store.records.values(), false, true);
			indexes.forEach((index, at) => trees.load(ids[at], index.records.values(), true, index.records.keysAreUnique));
			trees.db.exec("COMMIT");
		} catch (error) {
			trees.db.exec("ROLLBACK");
			throw error;
		}
		attachTree(store.records, trees.tree(id, true, false), false);
		indexes.forEach((index, at) => attachTree(index.records, trees.tree(ids[at], index.records.keysAreUnique, true), true));
	}
	/** The trees of the stores and indexes the schema has now: the others are swept after a snapshot. */
	function liveTrees() {
		const keep = /* @__PURE__ */ new Set();
		for (const db of raw._databases.values()) for (const store of db.rawObjectStores.values()) {
			if (store.deleted || !onTrees(store)) continue;
			keep.add(store.records.records.id);
			for (const index of store.rawIndexes.values()) if (!index.deleted && index.records.records instanceof SqlTree) keep.add(index.records.records.id);
		}
		return keep;
	}
	function enqueue(work) {
		queued++;
		queue = queue.then(work).catch(failed).finally(() => {
			queued--;
		});
		return queue;
	}
	function failed(error) {
		unsaved = true;
		process.stderr.write(`ghostly: storage write failed: ${error instanceof Error ? error.message : String(error)}\n`);
	}
	/**
	* `lazy`: a relaxed transaction's entry. A sync blocks the whole process for milliseconds, and what such a
	* transaction wrote can be made again (the event set's note of a message it already reported): written, it outlives
	* the process; a power cut may take its last second.
	*/
	function writeEntry(entry, lazy = false) {
		if (!writing) return false;
		try {
			if (journalFd === null) {
				journalFd = openSync(journalPath, "a", 384);
				if (snapshotName !== void 0 && fstatSync(journalFd).size === 0) writeAll(journalFd, framed(serialize([{
					db: FOLLOWS,
					store: "",
					kind: "clear",
					snapshot: snapshotName
				}])));
			}
			marked = false;
			writeAll(journalFd, framed(entry));
		} catch (error) {
			unsaved = true;
			throw error;
		}
		if (lazy) relaxed ??= setTimeout(() => {
			try {
				sync();
			} catch (error) {
				failed(error);
			}
		}, RELAXED_SYNC_MS).unref();
		else sync();
		if (statSync(journalPath).size > COMPACT_BYTES) enqueue(writeSnapshot);
		return true;
	}
	function sync() {
		if (relaxed) {
			clearTimeout(relaxed);
			relaxed = null;
		}
		if (journalFd !== null) fsyncSync(journalFd);
	}
	async function writeSnapshot() {
		const dirty = schemaDirty;
		schemaDirty = false;
		try {
			await snapshotToDisk();
		} catch (error) {
			schemaDirty ||= dirty;
			throw error;
		}
	}
	/**
	* What is held, as a snapshot. `inline`: every value in it (format 1, `exportSnapshot`); otherwise the stores kept on
	* disk say only that they are (format 3).
	*/
	async function capture(journalName, inline) {
		const snapshot = {
			format: 1,
			...journalName !== void 0 && { journal: journalName },
			databases: []
		};
		for (const db of raw._databases.values()) {
			if (db.name === PROBE) continue;
			const stores = [];
			for (const store of db.rawObjectStores.values()) {
				if (store.deleted) continue;
				const live = [...store.rawIndexes.values()].filter((index) => !index.deleted);
				const meta = {
					name: store.name,
					keyPath: store.keyPath,
					autoIncrement: store.autoIncrement,
					keyGenerator: store.keyGenerator?.num ?? null,
					indexes: live.map(({ name, keyPath, multiEntry, unique }) => ({
						name,
						keyPath,
						multiEntry,
						unique
					}))
				};
				if (!inline && disk(store)) {
					if (!onTrees(store)) toDisk(store);
					stores.push({
						...meta,
						records: [],
						onDisk: true
					});
					snapshot.format = 3;
					continue;
				}
				const records = [];
				for (const record of store.records.values()) records.push([record.key, await blobsToDisk(record.value)]);
				stores.push({
					...meta,
					records
				});
			}
			snapshot.databases.push({
				name: db.name,
				version: db.version,
				stores
			});
		}
		return snapshot;
	}
	async function snapshotToDisk() {
		const name = randomBytes(8).toString("hex");
		const snapshot = await capture(name, false);
		if (trees) {
			trees.apply(seq);
			trees.sync();
		}
		const temporary = snapshotPath + ".tmp";
		const fd = openSync(temporary, "w", 384);
		try {
			writeAll(fd, serialize(snapshot));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, snapshotPath);
		try {
			trees?.sweep(liveTrees());
		} catch (error) {
			process.stderr.write(`ghostly: storage: old trees not removed: ${error instanceof Error ? error.message : String(error)}\n`);
		}
		snapshotName = name;
		unsaved = false;
		if (relaxed) {
			clearTimeout(relaxed);
			relaxed = null;
		}
		if (journalFd !== null) {
			closeSync(journalFd);
			journalFd = null;
		}
		rmSync(journalPath, { force: true });
		marked = true;
	}
	/** What `close` leaves: a short journal with the mark at its end, synced (its relaxed entries too), or a fresh snapshot. */
	async function leave() {
		if (schemaDirty || unsaved || journalBytes() > KEEP_BYTES) return writeSnapshot();
		if (marked) return;
		writeEntry(serialize([{
			db: CLOSED,
			store: "",
			kind: "clear"
		}]));
		marked = true;
	}
	function journalBytes() {
		return existsSync(journalPath) ? statSync(journalPath).size : 0;
	}
	/**
	* Resolves once no transaction is left to run. The engine does not wait for every write (`void db.deleteLink(…)`),
	* and fake-indexeddb runs a transaction on a later turn of the event loop: a command that closed in the turn it wrote
	* in (no chat to say goodbye to) took its last snapshot before the write, and answered done for what was not on disk.
	* Two quiet turns in a row: a write that begins when another ends (a chat's messages after its row) is seen too.
	*/
	async function settled() {
		const until = Date.now() + CLOSE_WAIT_MS;
		for (let quiet = 0; quiet < 2 && Date.now() < until;) {
			await new Promise((resolve) => setImmediate(resolve));
			quiet = busy() ? 0 : quiet + 1;
		}
	}
	/** Whether a transaction is running or waiting to. */
	function busy() {
		return [...raw._databases.values()].some((db) => db.transactions.some((transaction) => transaction._state !== "finished"));
	}
	const installed = globalThis;
	installed.indexedDB = factory;
	installed.IDBKeyRange = IDBKeyRange;
	return {
		factory,
		recovered: !replayed.closed,
		flush: () => queue,
		async compact() {
			await settled();
			let thrown = null;
			await enqueue(() => writeSnapshot().catch((error) => {
				thrown = { error };
				throw error;
			}));
			if (thrown) throw thrown.error;
		},
		async close() {
			if (!writing) return;
			await settled();
			await enqueue(leave);
			writing = false;
			if (journalFd !== null) {
				closeSync(journalFd);
				journalFd = null;
			}
			trees?.db.close();
		},
		journalBytes,
		async exportSnapshot(path) {
			await settled();
			const snapshot = await capture(void 0, true);
			const fd = openSync(path, "w", 384);
			try {
				writeAll(fd, serialize(snapshot));
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		}
	};
}
/** Writes every byte: one write may take only a part (a disk nearly full). */
function writeAll(fd, bytes) {
	for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at);
}
/** A journal entry as it is on disk: its length, then its bytes. */
function framed(entry) {
	const header = Buffer.alloc(4);
	header.writeUInt32BE(entry.length);
	return Buffer.concat([header, entry]);
}
/** The snapshot a journal says it follows, in its first entry; none in an older version's journal, or an empty one. */
function follows(journal) {
	if (journal.length < 4 || 4 + journal.readUInt32BE(0) > journal.length) return void 0;
	try {
		const [op] = deserialize(journal.subarray(4, 4 + journal.readUInt32BE(0)));
		return op?.db === FOLLOWS ? op.snapshot : void 0;
	} catch {
		return;
	}
}
/** fake-indexeddb's raw classes, from a throwaway database (they are not exported). */
async function probeClasses(factory) {
	const db = await new Promise((resolve, reject) => {
		const request = factory.open(PROBE, 1);
		request.onupgradeneeded = () => request.result.createObjectStore("s", { autoIncrement: true }).createIndex("i", "x");
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	const rawDb = db._rawDatabase;
	const rawStore = rawDb.rawObjectStores.get("s");
	const classes = {
		Database: rawDb.constructor,
		ObjectStore: rawStore.constructor,
		Index: rawStore.rawIndexes.get("i").constructor,
		RecordStore: rawStore.records.constructor,
		constraintError: Error
	};
	const probe = new classes.RecordStore(true);
	probe.put({
		key: 1,
		value: 1
	});
	try {
		probe.put({
			key: 1,
			value: 2
		}, true);
	} catch (error) {
		classes.constraintError = error.constructor;
	}
	db.close();
	await new Promise((resolve) => {
		const request = factory.deleteDatabase(PROBE);
		request.onsuccess = request.onerror = () => resolve();
	});
	return classes;
}
/** The classes whose index upkeep is already by record: they are fake-indexeddb's own, shared by every store opened. */
var byRecord = /* @__PURE__ */ new WeakSet();
/**
* fake-indexeddb drops an overwritten or deleted record from an index by walking every entry of it (an index is in
* its own key's order, not the record's): each delivery mark, edit or reaction cost time with every message of the
* profile, 170 ms at 10,000, and a long chat slowed every other one. The store has the records it just replaced or
* removed in hand, and they say which entries to drop; a call that comes any other way still walks.
*/
function dropIndexEntriesByRecord(classes, cmp) {
	const storeProto = classes.ObjectStore.prototype;
	const recordsProto = classes.RecordStore.prototype;
	if (byRecord.has(storeProto)) return;
	byRecord.add(storeProto);
	const { storeRecord, deleteRecord } = storeProto;
	const { put, delete: remove, deleteByValue } = recordsProto;
	let gone = null;
	storeProto.storeRecord = function(record, noOverwrite, rollbackLog) {
		if (!this.rawIndexes.size) return storeRecord.call(this, record, noOverwrite, rollbackLog);
		const records = this.records, indexes = this.rawIndexes, outer = gone;
		records.put = (next, keep) => {
			const replaced = put.call(this.records, next, keep);
			gone = {
				indexes,
				records: replaced ? [replaced] : []
			};
			return replaced;
		};
		try {
			return storeRecord.call(this, record, noOverwrite, rollbackLog);
		} finally {
			delete records.put;
			gone = outer;
		}
	};
	storeProto.deleteRecord = function(key, rollbackLog) {
		if (!this.rawIndexes.size) return deleteRecord.call(this, key, rollbackLog);
		const records = this.records, indexes = this.rawIndexes, outer = gone;
		records.delete = (range) => {
			const removed = remove.call(this.records, range);
			gone = {
				indexes,
				records: removed
			};
			return removed;
		};
		try {
			deleteRecord.call(this, key, rollbackLog);
		} finally {
			delete records.delete;
			gone = outer;
		}
	};
	recordsProto.deleteByValue = function(key) {
		let index;
		if (gone) {
			for (const candidate of gone.indexes.values()) if (candidate.records === this) index = candidate;
		}
		if (!gone || !index) return deleteByValue.call(this, key);
		return dropEntries(index, gone.records, cmp);
	};
}
/** The classes whose reads of a store kept on disk hand out what rows.db gave: shared by every store opened. */
var uncopied = /* @__PURE__ */ new WeakSet();
/**
* fake-indexeddb copies every value a read hands out (`structuredClone`), as it must for its tree, which keeps the
* values. A store kept on disk read its values from rows.db just now (v8 made them), and copying them again made a
* whole-chat read 1.6 times the cost of one in memory. Its `get` and `getAll`, and an index's (which read through the
* store's `getValue`), hand those out as they are (`handOut`).
*/
function readWithoutCopy(classes) {
	const storeProto = classes.ObjectStore.prototype;
	if (uncopied.has(storeProto)) return;
	uncopied.add(storeProto);
	const { getValue, getAllValues } = storeProto;
	storeProto.getValue = function(key) {
		if (!(this.records.records instanceof SqlTree)) return getValue.call(this, key);
		const record = this.records.get(key);
		return record === void 0 ? void 0 : handOut(record.value);
	};
	storeProto.getAllValues = function(range, count, direction) {
		if (!(this.records.records instanceof SqlTree)) return getAllValues.call(this, range, count, direction);
		const values = [], most = count || Infinity;
		for (const record of this.records.values(range, direction)) {
			values.push(handOut(record.value));
			if (values.length >= most) break;
		}
		return values;
	};
}
/** Drops from an index the entries of records that left its store, and gives back the ones it dropped. */
function dropEntries(index, records, cmp) {
	const dropped = [];
	for (const entry of indexEntries(index, records, cmp)) {
		if (index.records.keysAreUnique) {
			const held = index.records.get(entry.key);
			if (!held || cmp(held.value, entry.value) !== 0) continue;
		}
		index.records.records.delete(entry);
		dropped.push(entry);
	}
	return dropped;
}
/**
* `cmp` for keys that are stored already (a record's, an index entry's): numbers, strings and arrays of them are
* ordered here, as IndexedDB orders them (a number before a string before an array; strings by code unit; arrays item
* by item, then the shorter first). Anything else (a date, bytes, a value that is no key) is left to `cmp`, which
* checks and copies both keys at every call: on the way back from a snapshot that was a third of a large store's time.
*/
function keyOrder(cmp) {
	const order = (a, b) => {
		const first = typeof a, second = typeof b;
		if (first === "number" && second === "number") return a === b ? 0 : a > b ? 1 : a < b ? -1 : cmp(a, b);
		if (first === "string" && second === "string") return a === b ? 0 : a > b ? 1 : -1;
		if (first === "number" && second === "string") return -1;
		if (first === "string" && second === "number") return 1;
		if (Array.isArray(a)) {
			if (second === "number" || second === "string") return 1;
			if (!Array.isArray(b)) return cmp(a, b);
			const length = Math.min(a.length, b.length);
			for (let at = 0; at < length; at++) {
				const item = order(a[at], b[at]);
				if (item !== 0) return item;
			}
			return a.length === b.length ? 0 : a.length > b.length ? 1 : -1;
		}
		if (Array.isArray(b) && (first === "number" || first === "string")) return -1;
		return cmp(a, b);
	};
	return order;
}
/** Whether it wrote a store of format 1 into rows.db (the snapshot is to be written again, of format 3). */
function restore(classes, databases, snapshot, cmp, disk) {
	if (snapshot?.format !== 1 && snapshot?.format !== 2 && snapshot?.format !== 3) throw new Error("This profile was last used by a newer version of ghostly (its store has a format this version does not read). Update ghostly to open it.");
	if (snapshot.format !== 1 && !disk.trees) throw new Error(`This profile keeps its messages in rows.db, which needs Node 22.13 or newer (this is ${process.version}). Update Node to open it.`);
	const missing = /* @__PURE__ */ new Error("This profile's store is missing rows.db (beside snapshot.bin): its messages cannot be read. Restore the profile from a backup.");
	const named = snapshot.format === 2 && snapshot.databases.some((db) => db.stores.some((store) => store.rows?.ids.some((id) => id >= 0)));
	if (snapshot.format === 2 && (!disk.rowsFound || !disk.rows || named && disk.rows.count() === 0)) throw missing;
	const kept = (db, store) => disk.trees.has(db, store.name) && store.indexes.every((index) => disk.trees.has(db, store.name, index.name));
	if (snapshot.format === 3 && (!disk.rowsFound || snapshot.databases.some((db) => db.stores.some((store) => store.onDisk && !kept(db.name, store))))) throw missing;
	const intern = interner();
	let written = false;
	for (const saved of snapshot.databases) {
		const db = new classes.Database(saved.name, saved.version);
		for (const s of saved.stores) {
			const store = new classes.ObjectStore(db, s.name, s.keyPath, s.autoIncrement);
			if (store.keyGenerator && s.keyGenerator !== null) store.keyGenerator.num = s.keyGenerator;
			for (const i of s.indexes) {
				const index = new classes.Index(store, i.name, i.keyPath, i.multiEntry, i.unique);
				index.initialized = true;
				store.rawIndexes.set(i.name, index);
			}
			db.rawObjectStores.set(s.name, store);
			if (s.onDisk) {
				disk.attach(store);
				continue;
			}
			if (s.rows) {
				const kept = s.rows;
				const records = kept.keys.map((key, at) => kept.ids[at] >= 0 ? disk.made.make(intern(key), kept.ids[at]) : {
					key: intern(key),
					value: void 0
				});
				for (const [at, value] of kept.inline) records[at] = {
					key: records[at].key,
					value: blobsFromDisk(value)
				};
				fill(store.records, records);
				for (const index of store.rawIndexes.values()) {
					const entries = kept.indexes[index.name];
					fill(index.records, entries ? entries.map(([key, at]) => ({
						key: intern(key),
						value: records[at].key
					})) : indexEntries(index, records, cmp));
				}
				continue;
			}
			const ordered = s.records.every(([key], at) => at === 0 || cmp(s.records[at - 1][0], key) < 0);
			if (ordered && disk.trees && disk.onDisk(saved.name, s.name)) {
				recordsToDisk(disk.trees, saved.name, store, s.records, cmp);
				s.records = [];
				disk.attach(store);
				written = true;
				continue;
			}
			const records = s.records.map(([key, value]) => ({
				key,
				value: blobsFromDisk(value)
			}));
			if (!ordered) {
				for (const record of records) store.storeRecord(record, false);
				continue;
			}
			fill(store.records, records);
			for (const index of store.rawIndexes.values()) fill(index.records, indexEntries(index, records, cmp));
		}
		databases.set(saved.name, db);
	}
	return written;
}
/** How many of a snapshot's records go to rows.db at a time, each with its index entries. */
var MOVE_BATCH = 2048;
/**
* A store of a snapshot of format 1 that is kept on disk, written into rows.db from the snapshot's records (in key
* order), a batch at a time with its index entries, in one SQLite transaction: building fake-indexeddb's trees first and
* copying them out held every message in those trees beside the snapshot at the update's first start (1.1 GB at
* 175,000, where the released start took 720 MB). Each batch's values are let go of in the snapshot once written.
*/
function recordsToDisk(trees, db, store, saved, cmp) {
	const indexes = [...store.rawIndexes.values()];
	const id = trees.treeId(db, store.name), ids = indexes.map((index) => trees.treeId(db, store.name, index.name));
	trees.db.exec("BEGIN");
	try {
		for (const tree of [id, ...ids]) trees.clearRows(tree);
		for (let from = 0; from < saved.length; from += MOVE_BATCH) {
			const batch = saved.slice(from, from + MOVE_BATCH).map(([key, value]) => ({
				key,
				value: blobsFromDisk(value)
			}));
			saved.fill(void 0, from, from + MOVE_BATCH);
			for (const record of batch) trees.row(id, record, false, true);
			indexes.forEach((index, at) => {
				for (const entry of indexEntries(index, batch, cmp)) trees.row(ids[at], entry, true, index.records.keysAreUnique);
			});
		}
		trees.db.exec("COMMIT");
	} catch (error) {
		trees.db.exec("ROLLBACK");
		throw error;
	}
}
/**
* One string for every copy of a chat's id among the keys (a message's key and its index entries each name its chat):
* a snapshot read back gives each its own.
*/
function interner() {
	const pool = /* @__PURE__ */ new Map();
	const one = (text) => {
		const held = pool.get(text);
		if (held !== void 0) return held;
		pool.set(text, text);
		return text;
	};
	return (key) => {
		if (typeof key === "string") return key.length <= 64 ? one(key) : key;
		if (Array.isArray(key) && typeof key[0] === "string" && key[0].length <= 64) key[0] = one(key[0]);
		return key;
	};
}
/**
* An index's entries for records in key order, sorted by the index's key: the index derives them itself (key path,
* multi-entry, invalid keys skipped) into a list instead of its tree. A stable sort keeps equal index keys in the
* records' key order, the tree's own tie-break.
*/
function indexEntries(index, records, cmp) {
	const entries = [];
	const tree = index.records;
	index.records = {
		get: () => void 0,
		put: (entry) => {
			entries.push(entry);
		}
	};
	try {
		for (const record of records) if (!absent(index.keyPath, record.value)) index.storeRecord(record);
	} finally {
		index.records = tree;
	}
	return entries.sort((a, b) => cmp(a.key, b.key));
}
/**
* Whether a key path surely finds nothing in a value: a plain object along it lacks the step (most messages have no
* `card` for the card index). The index would throw and catch a DataError for each of those; anything else it judges.
*/
function absent(keyPath, value) {
	if (typeof keyPath !== "string" || keyPath === "") return false;
	let object = value;
	for (const step of keyPath.split(".")) {
		if (object === null || typeof object !== "object" || Array.isArray(object) || object instanceof Blob) return false;
		if (!Object.hasOwn(object, step)) return true;
		object = object[step];
	}
	return false;
}
/**
* fake-indexeddb's red-black tree, built balanced from sorted records: every level full but the last, whose nodes
* are red, so each path holds the same number of black nodes and later inserts rebalance as usual.
*/
function fill(store, sorted) {
	const deepest = sorted.length ? Math.floor(Math.log2(sorted.length)) : 0;
	const build = (low, high, parent, depth) => {
		if (low > high) return void 0;
		const middle = low + high >>> 1;
		const node = {
			record: sorted[middle],
			left: void 0,
			right: void 0,
			parent,
			deleted: false,
			red: depth > 0 && depth === deepest
		};
		node.left = build(low, middle - 1, node, depth + 1);
		node.right = build(middle + 1, high, node, depth + 1);
		return node;
	};
	store.records._root = build(0, sorted.length - 1, void 0, 0);
	store.records._numNodes = sorted.length;
	store.records._numTombstones = 0;
}
/**
* Replays whole entries; a torn last entry (the process died mid-write) was never acknowledged and is dropped.
*
* A store's indexes are set aside while its ops replay and brought in step once at the end: fake-indexeddb drops an
* overwritten or deleted record from an index by walking every record of it, so a crash after a busy chat took
* tens of seconds to minutes to start, one write at a time against the whole profile. Only the rows the journal
* touched change in an index (what each was before goes, what it is now comes in): a journal of one message costs one
* message, not the profile's history once per index. A store the journal cleared has its indexes built again whole.
*/
function replay(databases, journal, cmp, trees) {
	const touched = /* @__PURE__ */ new Map();
	try {
		return replayEntries(databases, journal, touched, trees);
	} finally {
		for (const [store, { indexes, was, now }] of touched) {
			const records = store.records;
			delete records.put;
			delete records.delete;
			store.rawIndexes = indexes;
			for (const index of indexes.values()) {
				if (!was) index.records.clear();
				if (!index.initialized) continue;
				if (was) dropEntries(index, [...was], cmp);
				for (const record of was ? now : store.records.values()) if (!absent(index.keyPath, record.value)) index.storeRecord(record);
			}
		}
	}
}
function replayEntries(databases, journal, touched, trees) {
	let offset = 0, closed = false, last = 0;
	while (offset + 4 <= journal.length) {
		const length = journal.readUInt32BE(offset);
		if (offset + 4 + length > journal.length) break;
		let ops;
		try {
			ops = deserialize(journal.subarray(offset + 4, offset + 4 + length));
		} catch {
			break;
		}
		offset += 4 + length;
		closed = ops.some((op) => op.db === CLOSED);
		const marker = ops.find((op) => op.db === SEQ);
		const entry = marker?.kind === "clear" ? marker.seq : void 0;
		if (entry !== void 0) last = Math.max(last, entry);
		for (const op of ops) {
			const store = databases.get(op.db)?.rawObjectStores.get(op.store);
			if (!store) continue;
			const onTrees = trees.onTrees(store);
			if (onTrees && entry !== void 0 && entry <= trees.applied) continue;
			let change = onTrees ? void 0 : touched.get(store);
			if (!onTrees && !change) touched.set(store, change = watch(store));
			if (op.kind === "put") store.storeRecord({
				key: op.key,
				value: blobsFromDisk(op.value)
			}, false);
			else if (op.kind === "delete") store.deleteRecord(keyFromDisk(op.key));
			else {
				if (change) change.was = null;
				store.clear();
			}
		}
	}
	return {
		end: offset,
		closed: closed && offset === journal.length,
		seq: last
	};
}
/**
* Sets a store's indexes aside and notes, as its records are written over and removed, which ones left and which
* ones came: the record store hands back what a put replaced and what a delete removed, so a row costs no lookup.
* A record that came and left again was never in an index.
*/
function watch(store) {
	const change = {
		indexes: store.rawIndexes,
		was: store.rawIndexes.size ? /* @__PURE__ */ new Set() : null,
		now: /* @__PURE__ */ new Set()
	};
	store.rawIndexes = /* @__PURE__ */ new Map();
	if (!change.was) return change;
	const { put, delete: remove } = store.records;
	const left = (record) => {
		if (!change.now.delete(record)) change.was?.add(record);
	};
	store.records.put = (next, keep) => {
		const replaced = put.call(store.records, next, keep);
		if (replaced) left(replaced);
		change.now.add(next);
		return replaced;
	};
	store.records.delete = (key) => {
		const removed = remove.call(store.records, key);
		removed.forEach(left);
		return removed;
	};
	return change;
}
function keyToDisk(key) {
	if (key instanceof IDBKeyRange) return { [RANGE]: {
		lower: key.lower,
		upper: key.upper,
		lowerOpen: key.lowerOpen,
		upperOpen: key.upperOpen
	} };
	return key;
}
function keyFromDisk(key) {
	const range = key?.[RANGE];
	if (!range) return key;
	if (range.lower === void 0) return IDBKeyRange.upperBound(range.upper, range.upperOpen);
	if (range.upper === void 0) return IDBKeyRange.lowerBound(range.lower, range.lowerOpen);
	return IDBKeyRange.bound(range.lower, range.upper, range.lowerOpen, range.upperOpen);
}
function hasBlob(value, depth = 0) {
	if (value instanceof Blob) return true;
	if (!value || typeof value !== "object" || depth > 32 || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
	if (value instanceof Map) {
		for (const [k, v] of value) if (hasBlob(k, depth + 1) || hasBlob(v, depth + 1)) return true;
		return false;
	}
	for (const item of Object.values(value)) if (hasBlob(item, depth + 1)) return true;
	return false;
}
/** v8 cannot serialize a Blob: it goes to disk as its bytes and type, and comes back a Blob. */
async function blobsToDisk(value, depth = 0) {
	if (!hasBlob(value, depth)) return value;
	if (value instanceof Blob) return { [BLOB]: {
		type: value.type,
		bytes: new Uint8Array(await value.arrayBuffer())
	} };
	if (Array.isArray(value)) return Promise.all(value.map((item) => blobsToDisk(item, depth + 1)));
	if (value instanceof Map) return new Map(await Promise.all([...value].map(async ([k, v]) => [k, await blobsToDisk(v, depth + 1)])));
	const out = {};
	for (const [k, v] of Object.entries(value)) out[k] = await blobsToDisk(v, depth + 1);
	return out;
}
function blobsFromDisk(value, depth = 0) {
	if (!value || typeof value !== "object" || depth > 32 || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
	const blob = value[BLOB];
	if (blob) return new Blob([blob.bytes], { type: blob.type });
	if (Array.isArray(value)) return value.map((item) => blobsFromDisk(item, depth + 1));
	if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, blobsFromDisk(v, depth + 1)]));
	if (Object.getPrototypeOf(value) !== Object.prototype) return value;
	const out = {};
	for (const [k, v] of Object.entries(value)) out[k] = blobsFromDisk(v, depth + 1);
	return out;
}
//#endregion
//#region src/runtime/engine.ts
/**
* The HyperDHT network: `GHOSTLY_HYPERDHT_BOOTSTRAP` ("host:port,…") replaces the public bootstrap nodes, as it does
* for the Desktop's sidecar; a network all on loopback (the tests') is announced on loopback too.
*/
function hyperdhtNetwork(env = process.env.GHOSTLY_HYPERDHT_BOOTSTRAP) {
	const bootstrap = (env ?? "").split(",").map((node) => node.trim()).filter(Boolean);
	if (!bootstrap.length) return {};
	return {
		bootstrap,
		...bootstrap.every((node) => /^(127\.0\.0\.1|localhost):\d+$/.test(node)) ? { host: "127.0.0.1" } : {}
	};
}
/**
* The Pkarr relays of a private network or a test, `GHOSTLY_PKARR_RELAYS` ("http://…,…"), the Desktop's name for it:
* the only relays this process uses, whatever the profile's `relays` setting says, from its very first publish. Null
* when unset.
*/
function pkarrRelays(env = process.env) {
	const relays = (env.GHOSTLY_PKARR_RELAYS ?? "").split(",").map((url) => url.trim()).filter(Boolean);
	if (!relays.length) return null;
	const bad = relays.find((url) => !/^https?:\/\/[^/\s]/i.test(url));
	if (bad) throw new CliError("usage", `GHOSTLY_PKARR_RELAYS takes http:// or https:// URLs, comma-separated, not ${JSON.stringify(bad)}`);
	return relays;
}
/**
* The Iroh relays of a private network or a test, `GHOSTLY_IROH_RELAYS` ("https://…,…"; http:// on loopback): the only
* relays this process's Iroh homes on, whatever the profile's `irohRelays` setting says. Null when unset (the setting,
* else n0's public relays).
*/
function irohRelays(env = process.env) {
	const relays = (env.GHOSTLY_IROH_RELAYS ?? "").split(",").map((url) => url.trim()).filter(Boolean);
	if (!relays.length) return null;
	const bad = relays.map((url) => irohRelayProblem(url)).find(Boolean);
	if (bad) throw new CliError("usage", `GHOSTLY_IROH_RELAYS: ${bad}`);
	return relays;
}
/**
* The apps' public STUN servers (Google's, `RTC_CONFIG`), which every WebRTC connection asks for its public address:
* `GHOSTLY_STUN=0` leaves them out (a private network, or tests on one machine, where host candidates connect). The
* profile's own `iceServers` stay.
*/
function publicStun(env = process.env) {
	return env.GHOSTLY_STUN !== "0";
}
/** An RTC configuration without the apps' public STUN servers. */
function withoutPublicStun(config) {
	if (!config?.iceServers) return config;
	const ours = new Set((RTC_CONFIG.iceServers ?? []).flatMap((server) => [server.urls].flat()));
	const iceServers = config.iceServers.map((server) => ({
		...server,
		urls: [server.urls].flat().filter((url) => !ours.has(url))
	})).filter((server) => server.urls.length);
	return {
		...config,
		iceServers
	};
}
/**
* The Mainline DHT, for Pkarr beside the relays (`RelaysAndDht`): `GHOSTLY_DHT=0` leaves it out (relays only, as the web
* app), `GHOSTLY_DHT_BOOTSTRAP` ("host:port,…") replaces the public routers (a testnet; one all on loopback binds there).
* `GHOSTLY_PKARR_RELAYS` without a bootstrap leaves it out too, as on the Desktop: a private network stays off the
* public DHT.
*/
function mainlineNetwork(env = process.env) {
	if (env.GHOSTLY_DHT === "0") return { off: true };
	const bootstrap = (env.GHOSTLY_DHT_BOOTSTRAP ?? "").split(",").map((node) => node.trim()).filter(Boolean);
	if (!bootstrap.length && pkarrRelays(env)) return { off: true };
	if (!bootstrap.length) return { off: false };
	return {
		off: false,
		bootstrap,
		...bootstrap.every((node) => /^(127\.0\.0\.1|localhost):\d+$/.test(node)) ? { host: "127.0.0.1" } : {}
	};
}
/**
* WebRTC for the engine (WISP 101): libdatachannel through node-datachannel's W3C polyfill. Chats go live over it with
* browsers directly, and groups need it (their links use WebRTC alone). A native module: without it, or with
* `GHOSTLY_WEBRTC=0`, the CLI runs without WebRTC and says so.
*/
async function installWebRtc() {
	if (process.env.GHOSTLY_WEBRTC === "0") return false;
	try {
		const polyfill = await import("node-datachannel/polyfill");
		const scope = globalThis;
		for (const name of [
			"RTCPeerConnection",
			"RTCSessionDescription",
			"RTCIceCandidate",
			"RTCDataChannel",
			"RTCDataChannelEvent",
			"RTCPeerConnectionIceEvent",
			"RTCCertificate"
		]) scope[name] ??= polyfill[name];
		refuseDataAnswers(scope);
		if (!publicStun()) leaveOutPublicStun(scope);
		return true;
	} catch (error) {
		process.stderr.write(`ghostly: WebRTC is unavailable (${error instanceof Error ? error.message : String(error)}); chats use HyperDHT, Iroh or the DHT\n`);
		return false;
	}
}
/**
* For tests: `GHOSTLY_TEST_REFUSE_DATA_ANSWERS=<n>` refuses one in every n answers this process applies to its offers
* (the first, the n+1st, and so on), as libdatachannel 0.24.5 refuses one in its race (`ANSWER_REFUSED_REDIALS` in
* packages/core/src/datalink.ts): the connection closes, and setRemoteDescription throws.
*/
function refuseDataAnswers(scope) {
	const every = Number(process.env.GHOSTLY_TEST_REFUSE_DATA_ANSWERS) || 0;
	if (every <= 0) return;
	let answers = 0;
	const Base = scope.RTCPeerConnection;
	scope.RTCPeerConnection = class extends Base {
		async setRemoteDescription(description) {
			if (description.type === "answer" && answers++ % every === 0) {
				this.close();
				throw new Error("libdatachannel error while adding remote description: Got a remote candidate without ICE transport (GHOSTLY_TEST_REFUSE_DATA_ANSWERS)");
			}
			return super.setRemoteDescription(description);
		}
	};
}
/** `GHOSTLY_STUN=0`: every connection the engine makes leaves the apps' public STUN servers out of its configuration. */
function leaveOutPublicStun(scope) {
	const Base = scope.RTCPeerConnection;
	scope.RTCPeerConnection = class extends Base {
		constructor(config) {
			super(withoutPublicStun(config));
		}
	};
}
/** Server-sent events, which browsers have and Node does not: Arkade follows its server with them. */
async function installEventSource() {
	const scope = globalThis;
	if (scope.EventSource) return;
	scope.EventSource = (await import("eventsource")).EventSource;
}
/**
* Arkade's descriptor library is CommonJS and `require`s `@scure/bip32`, which is ESM. When the engine's own imports
* are still evaluating that module, Node's require(esm) hands the library a namespace without `HDKey` yet ("reading
* 'fromMasterSeed'"). Loading it whole first avoids the race.
*/
async function preloadWalletModules() {
	await import("@scure/bip32").catch(() => {});
	await import("@bitcoinerlab/descriptors-scure").catch(() => {});
}
/** Iroh's wasm, from next to the bundle (a package) or from the workspace (development and tests). */
function irohWasmBytes() {
	for (const place of ["./ghostly_iroh_web_bg.wasm", "./assets/ghostly_iroh_web_bg.wasm"]) {
		const path = fileURLToPath(new URL(place, import.meta.url));
		if (existsSync(path)) return readFileSync(path);
	}
	return readFileSync(createRequire(import.meta.url).resolve("@ghostly/iroh-web/wasm"));
}
/**
* Starts the app's engine on this profile (WISP 1100 § Runtime): IndexedDB on disk, WebRTC through libdatachannel,
* HyperDHT native in this process, Iroh's wasm build (relay only, as the web app), Pkarr through the relays in the
* settings and the Mainline DHT directly (read when the relays fail, written always).
* The caller holds the profile's lock.
*/
/** The files a light backup left out, as the restore wrote them in the mark (an empty mark: none). */
function leftOutIn(mark) {
	try {
		const ids = JSON.parse(readFileSync(mark, "utf8") || "{}").leftOut;
		return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
	} catch {
		return [];
	}
}
async function startRuntime(paths, options = {}) {
	const pinned = pkarrRelays();
	const pinnedIroh = irohRelays();
	const trace = process.env.GHOSTLY_LINK_TRACE;
	if (trace) {
		setLinkTraceSink((line) => appendFileSync(trace, line + "\n", { mode: 384 }));
		(await import("./joinTrace-D-fnt2p3.js")).setJoinTraceSink((line) => appendFileSync(trace, line + "\n", { mode: 384 }));
	}
	const store = await openPersistentIndexedDb(paths.db);
	const restored = join(paths.dir, RESTORED_MARK);
	if (existsSync(restored)) {
		try {
			const rows = await import("./restoredRows-BTjRgvSq.js");
			await rows.markRestoredWallet();
			await rows.markLeftOutFiles(leftOutIn(restored));
			await store.compact();
		} catch (error) {
			await store.close().catch(() => {});
			throw error;
		}
		rmSync(restored, { force: true });
	}
	const webrtc = await installWebRtc();
	const stack = webrtc ? await loadCallStack() : "Calls need WebRTC, which is off on this headless Ghostly";
	const callsUnavailable = typeof stack === "string" ? stack : null;
	installFileFetch();
	const testMints = process.env.GHOSTLY_TEST_MINTS;
	if (testMints) (await import("./mints-CqTdA4Gk.js")).declareTestMints(testMints.split(","));
	await installEventSource();
	await preloadWalletModules();
	(await import("./ghostly_iroh_web-BsAEFIjl.js")).initSync({ module: irohWasmBytes() });
	const [{ registerFileBytes }, { NodeFileBytes }] = await Promise.all([import("./fileBytes-C35e_pYn.js"), import("./fileBytes-BDUGlCnn.js")]);
	registerFileBytes("native", async () => new NodeFileBytes(paths.files), true);
	if (await (await import("./blobFiles-DKc6L-Hg.js")).moveBlobFiles()) await store.compact();
	const [{ EngineServer }, { createHyperEndpoint }] = await Promise.all([import("./server-7BynPwrK.js"), import("./endpoint-Cl3cgAYl.js")]);
	const network = hyperdhtNetwork();
	const dht = mainlineNetwork();
	const mainline = dht.off ? null : new (await (import("./mainline-FzT8IhvK.js"))).Mainline({
		bootstrap: dht.bootstrap,
		host: dht.host
	});
	const transport = mainline || pinned ? new (await (import("./mainline-FzT8IhvK.js"))).RelaysAndDht(mainline, pinned ? { relays: pinned } : {}, !!pinned) : null;
	const apps = servedApps(paths.dir).length > 0;
	const server = new EngineServer({
		...transport ? { transport } : {},
		irohWeb: true,
		...pinnedIroh ? { irohRelays: pinnedIroh } : {},
		singleDevice: true,
		nativeTransports: { "hyperdht/1": (seedB64) => createHyperEndpoint(fromBase64Url(seedB64), network) },
		automaticWallets: false,
		fedimintSdk: nodeFedimintSdk(join(paths.dir, "fedimint")),
		servicesSupport: true,
		apps: apps ? "wire" : false,
		staysOnline: process.env.GHOSTLY_HUB !== "0",
		localFetch: nodeLocalFetch,
		pushSend: (request) => nodePushSend(request),
		callsSupport: callsUnavailable === null,
		...callsUnavailable ? { callsUnavailable } : {},
		...options.deferGroups ? { deferGroups: true } : {},
		...options.offline ? { offline: true } : {},
		...process.env.GHOSTLY_TEST_WEBRTC_GROUP_LINKS === "1" ? { webrtcGroupLinks: true } : {}
	});
	try {
		await server.ready;
	} catch (error) {
		await mainline?.destroy().catch(() => {});
		await store.close().catch(() => {});
		throw error;
	}
	let closing = null;
	return {
		paths,
		server,
		store,
		webrtc,
		callsUnavailable,
		apps,
		close: () => closing ??= (async () => {
			await server.node.shutdown().catch(() => {});
			await mainline?.destroy().catch(() => {});
			await store.close();
		})()
	};
}
//#endregion
//#region src/host.ts
/** The longest request line the daemon reads (WISP 1100 § Framing). */
var MAX_LINE = 16777216;
/**
* How many of a chat's newest messages the start reads to see whether the events are in step with its history: the
* whole history of every chat and group, read at every start, took a daemon's start and its memory with every message
* the profile ever stored (1 s and 70 MB at 100,000).
*/
var BASELINE_NEWEST = 100;
/**
* Runs a profile in this process: takes its lock, starts the engine, and derives events from it. A daemon then
* serves the socket (`serve`); a one-shot command calls the API directly and closes. A one-shot for one chat passes
* `deferGroups`: the groups' sessions would spend the relays' budget its message needs.
*/
async function openHost(paths, mode, version, options = {}) {
	const release = acquireLock(paths);
	let runtime;
	try {
		runtime = await startRuntime(paths, options);
	} catch (error) {
		release();
		throw error;
	}
	const hub = new EventHub(paths.events);
	let calls;
	try {
		await hub.open();
		const node = runtime.server.node;
		const now = node.getState();
		const mark = runtime.server.historyMark;
		const histories = /* @__PURE__ */ new Map(), newest = /* @__PURE__ */ new Map();
		const whole = (id) => id.startsWith("group:") ? node.groupMessages({ groupId: id.slice(6) }) : node.getMessages(id);
		const closed = !runtime.store.recovered;
		for (const id of [...now.links.map((link) => link.id), ...now.groups.map((group) => `group:${group.id}`)]) {
			const page = closed && !runtime.server.historyChanged(id) ? await node.messagePage({
				linkId: id,
				limit: 100
			}) : null;
			if (page && !page.more) histories.set(id, page.messages);
			else if (page && hub.inStep(id, page.messages)) newest.set(id, page.messages);
			else histories.set(id, await whole(id));
		}
		hub.baseline(now, histories, {
			newest,
			whole
		});
		announceJoins(hub, node);
		calls = new CallManager({
			engine: node,
			emit: (type, id, fields) => hub.emit(type, id, fields),
			profileDir: paths.dir,
			answers: mode === "daemon"
		});
		const manager = calls;
		hub.onCallSignal((chat, signal) => manager.onSignal(chat, signal));
		reportAppFrames(hub, node, paths.dir);
		runtime.server.attach(hub.sink, {
			mark,
			ids: [...histories.keys(), ...newest.keys()]
		});
	} catch (error) {
		await runtime.close().catch(() => {});
		release();
		throw error;
	}
	const ctx = {
		runtime,
		hub,
		mode,
		version,
		calls
	};
	resumeHolds(ctx);
	let closing = null;
	return {
		ctx,
		close: () => closing ??= (async () => {
			await Promise.all([calls.stopAll(), flushCardUpdates(ctx)]).catch(() => {});
			runtime.server.detach(hub.sink);
			await runtime.close().catch(() => {});
			release();
		})()
	};
}
async function serve(host) {
	const { ctx } = host;
	const path = ctx.runtime.paths.socket;
	if (process.platform !== "win32") {
		if (dirname(path) !== ctx.runtime.paths.dir) privateFolder(dirname(path), "the daemon will not put its socket there");
		else ownFolder(ctx.runtime.paths.dir, "the daemon will not put its socket there");
	}
	if (existsSync(path)) rmSync(path, { force: true });
	const sockets = /* @__PURE__ */ new Set();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		connection(ctx, socket);
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		const umask = ownerOnlyUmask();
		try {
			server.listen(path, () => {
				server.off("error", reject);
				resolve();
			});
		} finally {
			umask?.();
		}
	});
	if (process.platform !== "win32") chmodSync(path, 384);
	let closing = null;
	return {
		server,
		close: () => closing ??= new Promise((resolve) => {
			server.close(() => resolve());
			for (const socket of sockets) socket.end();
			setTimeout(() => {
				for (const socket of sockets) socket.destroy();
			}, 500).unref();
		})
	};
}
var guarded = false;
/**
* A daemon says an error nobody caught (with its stack, on stderr: the daemon's log when detached) and keeps serving:
* one request gone wrong must not take the profile offline. One-shot commands do not call this; they still fail loudly.
*
* `outputs`: what it writes to. A write there that fails (a pipe whose reader is gone: the process that started the
* daemon died) is dropped, not an error nobody caught: saying it would be one more failed write, and the next, with
* no turn left for anything else (a full core, and no stop on SIGTERM).
*/
function keepServing(proc = process, write = (text) => {
	process.stderr.write(text);
}, outputs = proc === process ? [process.stdout, process.stderr] : []) {
	if (proc === process) {
		if (guarded) return;
		guarded = true;
	}
	const log = (what) => (error) => {
		try {
			write(`ghostly: ${what}, the daemon keeps serving: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		} catch {}
	};
	for (const output of outputs) output.on("error", () => {});
	proc.on("unhandledRejection", log("unhandled rejection"));
	proc.on("uncaughtException", log("uncaught exception"));
}
/** Sets a 077 umask; the function it returns puts the old one back. Null where there is none (Windows, a worker). */
function ownerOnlyUmask() {
	if (process.platform === "win32") return null;
	try {
		const old = process.umask(63);
		return () => {
			process.umask(old);
		};
	} catch {
		return null;
	}
}
function connection(ctx, socket) {
	const unsubscribes = [];
	const write = (value) => {
		if (!socket.destroyed) socket.write(JSON.stringify(value) + "\n");
	};
	socket.on("close", () => {
		for (const off of unsubscribes) off();
	});
	socket.on("error", () => {});
	const lines = createInterface({
		input: socket,
		crlfDelay: Infinity
	});
	let buffered = 0;
	socket.on("data", (chunk) => {
		buffered += chunk.length;
		if (buffered > 16777216) socket.destroy();
	});
	lines.on("line", (line) => {
		buffered = 0;
		if (!line.trim()) return;
		let request;
		try {
			request = JSON.parse(line);
		} catch {
			write({
				id: null,
				error: new CliError("bad_request", "Not JSON").toJSON()
			});
			return;
		}
		const id = typeof request.id === "number" || typeof request.id === "string" ? request.id : null;
		if (typeof request.method !== "string") {
			write({
				id,
				error: new CliError("bad_request", "method is required").toJSON()
			});
			return;
		}
		if (request.method === "events.subscribe") {
			const params = request.params ?? {};
			const since = typeof params.since === "number" ? params.since : ctx.hub.lastSeq;
			let replay;
			try {
				replay = ctx.hub.replay(since);
			} catch (error) {
				write({
					id,
					error: asCliError(error).toJSON()
				});
				return;
			}
			const queued = [];
			let replaying = true;
			unsubscribes.push(ctx.hub.onEvent((event) => {
				if (replaying) queued.push(event);
				else write({ event });
			}));
			write({
				id,
				result: {
					subscribed: true,
					lastSeq: ctx.hub.lastSeq
				}
			});
			let last = since;
			for (const event of replay) {
				write({ event });
				last = event.seq;
			}
			replaying = false;
			for (const event of queued) if (event.seq > last) write({ event });
			return;
		}
		callApi(ctx, request.method, request.params ?? {}).then((result) => write({
			id,
			result: result ?? null
		}), (error) => write({
			id,
			error: asCliError(error).toJSON()
		}));
	});
}
//#endregion
export { BASELINE_NEWEST, MAX_LINE, keepServing, openHost, serve };

//# sourceMappingURL=host-B9EoE0qS.js.map