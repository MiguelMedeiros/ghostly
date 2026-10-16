import { $i as identityStatement, Ca as parseVoiceMeta, Cl as sanitizeAvatar, Da as readImageMeta, Dc as ownInviteRefusal, Dl as toBase64Url, El as randomBytes$1, Go as GhostlyHttpError, Gr as TYPING_REFRESH_MS, S as isAppUrl, Sl as MAX_AVATAR_LENGTH, Tc as inviteLink, Wr as TYPING_KINDS, Yo as LIMITS, _ as APP_PERMISSIONS, _a as sanitizeFileName, ao as checkStatusCard, ba as VOICE_LIMITS, bo as isAppRef, ct as groupName, di as APP_DATA_MAX_BYTES, eo as STATUS_CARD_LIMITS, go as appRef, nr as GROUP_FILE_LIMITS, qr as sanitizeTypingStatus, ro as cardLine, to as appCardId, va as sanitizeMime, wa as voicePeaksOf, xa as baseMime, ya as PLAYABLE_AUDIO, zo as AWAITING_PEER_MS } from "./src-dfGE33hw.js";
import { l as fileStore } from "./idb-BuyRKmBx.js";
import { O as waitingGroupFile, T as removeStored, U as iceServerProblem, W as iceServerSetting, i as groupOfFile, l as replyRef, n as groupFileId, v as paymentNetwork } from "./groupFiles-Mii-eKSf.js";
import { f as FILE_BYTES_STEP, o as fileBytes, s as fileBytesOf } from "./fileBytes-BLAQx_nv.js";
import { t as IDENTITY_PROVIDERS } from "./registry-B6ICWeJm.js";
import { a as waitForEdit, c as findSecret, i as pressable, n as buttonsCard, o as waitForGroupFrame, s as waitForMessage, t as BUTTON_METHODS } from "./buttons-CpT1VIOt.js";
import { i as ENGINE_READS, n as withStoredIds, r as ENGINE_METHODS } from "./turnRefs-aJfhdKIb.js";
import { t as CliError } from "./errors-B-zMxbcd.js";
import { _ as str, a as findChat, c as groupOf, d as messageOf, f as node, g as state, h as sentAt, i as chatOrGroup, l as inviteTaken, m as oneOf, n as bool, o as findChatOrGroup, p as num, r as chatOf, s as findGroup, u as list, v as waitForState } from "./apiKit-BeSsbld5.js";
import { a as checkShownName } from "./profiles-CI6Z0_ww.js";
import { t as BACKUP_METHODS } from "./backup-B2HfdNO7.js";
import { o as checkedBundle } from "./apps-5iqJvG2e.js";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { openAsBlob, readFileSync, renameSync, writeFileSync } from "node:fs";
import { access, constants as constants$1, open, readFile, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
//#region src/typing.ts
/**
* `typing --for` and `group typing --for`: a `start` holds 6 s on the other side (WISP 401 § Typing, WISP 902 · Group
* Mesh § Typing), so the daemon says it again until the time is up, a message goes to that chat or group, or a
* `--stop`. The engine sends a `start` at most once per refresh, counted from when the last one went: asking every half
* refresh missed the tick at 3 s by a millisecond about half the time, so a start went every 4.5 s, 1.5 s inside the
* contact's 6 s, and a busy machine flickered the contact's indicator off and on. Asking every half second sends one
* at most 3.5 s after the last, and soon again when the send limit held one back.
*/
var KEEP_EVERY_MS = TYPING_REFRESH_MS / 6;
var keepers = /* @__PURE__ */ new WeakMap();
function keepersOf(ctx) {
	let map = keepers.get(ctx);
	if (!map) keepers.set(ctx, map = /* @__PURE__ */ new Map());
	return map;
}
var keyOf = (target) => "groupId" in target ? `group:${target.groupId}` : target.linkId;
/** Says it once: this side is typing (with its word), or stopped. */
function sayTyping(ctx, target, typing, word = {}) {
	const said = typing ? word : {};
	if ("groupId" in target) node(ctx).setGroupTyping({
		groupId: target.groupId,
		typing,
		...said
	});
	else node(ctx).setTyping({
		linkId: target.linkId,
		typing,
		...said
	});
}
/**
* Says this side is typing in the chat or group for `ms`, with the kind and status it gave (`--kind`, `--status`) each
* time; resolves when that ends, whichever way.
*/
function keepTyping(ctx, target, ms, word = {}) {
	endTyping(ctx, target, false);
	const map = keepersOf(ctx), key = keyOf(target);
	return new Promise((resolve) => {
		const end = () => {
			clearInterval(again);
			clearTimeout(until);
			off();
			if (map.get(key) === end) map.delete(key);
			resolve();
		};
		const again = setInterval(() => sayTyping(ctx, target, true, word), KEEP_EVERY_MS);
		const until = setTimeout(() => {
			end();
			sayTyping(ctx, target, false);
		}, ms);
		const off = ctx.hub.onEvent((event) => {
			if ("groupId" in target ? event.type === "group.sent" && event.group === target.groupId : event.type === "message.sent" && event.chat === target.linkId) end();
		});
		map.set(key, end);
	});
}
/** How long a one-shot's `--for` waits for its chat or group to be live: a fresh one-shot connects first. */
var ONE_SHOT_LIVE_GRACE_MS = 15e3;
/**
* A one-shot's `--for` (it holds the profile while it runs): kept the whole time once the chat or group is live, as a
* daemon keeps it; ended when it is not live within `ONE_SHOT_LIVE_GRACE_MS`, since nobody would see it, and `--stop`
* or a send from another shell could not end it.
*/
async function keepOneShot(ctx, target, kept, live) {
	let stop = () => {};
	const cameLive = new Promise((resolve) => {
		if (live(state(ctx))) return resolve(true);
		const timer = setTimeout(() => {
			off();
			resolve(false);
		}, ONE_SHOT_LIVE_GRACE_MS);
		const off = ctx.hub.onState((next) => {
			if (live(next)) {
				clearTimeout(timer);
				off();
				resolve(true);
			}
		});
		stop = () => {
			clearTimeout(timer);
			off();
			resolve(true);
		};
	});
	if (await Promise.race([kept.then(() => true), cameLive])) {
		stop();
		await kept;
		return;
	}
	endTyping(ctx, target, false);
}
/** Ends a kept `--for` in the chat or group; `tell`: and says this side stopped. Whether one was kept. */
function endTyping(ctx, target, tell) {
	const end = keepersOf(ctx).get(keyOf(target));
	if (!end) return false;
	end();
	if (tell) sayTyping(ctx, target, false);
	return true;
}
//#endregion
//#region src/voicePeaks.ts
/** Longer than any voice note (15 minutes) with room: a file past it is not decoded into memory. */
var MAX_BYTES = 268435456;
var FFMPEG_TIMEOUT_MS = 12e4;
/** The waveform and length of the sound in `path`, or why they could not be read. */
async function measureVoice(path) {
	let sound;
	try {
		sound = await decodeSound(path);
	} catch (error) {
		return { problem: error instanceof Error ? error.message : String(error) };
	}
	if (sound.mono.length === 0) return { problem: "no sound in it" };
	return { voice: {
		duration: Math.round(sound.mono.length / sound.sampleRate * 1e3),
		peaks: voicePeaksOf(sound.mono, sound.sampleRate)
	} };
}
async function decodeSound(path) {
	const bytes = await readFile(path);
	if (bytes.length > MAX_BYTES) throw new Error("too large to decode");
	let own;
	try {
		const sound = await decodeBytes(bytes);
		if (sound) return sound;
	} catch (error) {
		own = error instanceof Error ? error : new Error(String(error));
	}
	try {
		return await decodeWithFfmpeg(path);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(own ? `${own.message}; ${reason}` : reason, { cause: error });
	}
}
/** The sound in a file this module decodes itself, or null for a kind it leaves to ffmpeg. */
async function decodeBytes(bytes) {
	if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return decodeWav(bytes);
	if (bytes[0] === 26 && bytes[1] === 69 && bytes[2] === 223 && bytes[3] === 163) {
		const opus = demuxWebm(bytes);
		return opus ? decodeOpus(opus) : null;
	}
	if (ascii(bytes, 0, 4) === "OggS") {
		const opus = demuxOgg(bytes);
		return opus ? decodeOpus(opus) : null;
	}
	if (ascii(bytes, 0, 3) === "ID3" || bytes[0] === 255 && (bytes[1] & 224) === 224) return decodeMp3(bytes);
	return null;
}
function ascii(bytes, at, length) {
	return String.fromCharCode(...bytes.subarray(at, at + length));
}
function mix(channels, length) {
	if (channels.length === 1) return channels[0].subarray(0, length);
	const mono = new Float32Array(length);
	for (const channel of channels) for (let i = 0; i < length; i++) mono[i] += channel[i] / channels.length;
	return mono;
}
/** PCM (8, 16, 24 or 32 bit) or float (32 or 64 bit) WAV. A data chunk whose size is unknown (a pipe) runs to the end. */
function decodeWav(bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let format = 0, channels = 0, sampleRate = 0, bits = 0;
	let at = 12;
	while (at + 8 <= bytes.length) {
		const id = ascii(bytes, at, 4);
		const size = view.getUint32(at + 4, true);
		const body = at + 8;
		if (id === "fmt ") {
			format = view.getUint16(body, true);
			channels = view.getUint16(body + 2, true);
			sampleRate = view.getUint32(body + 4, true);
			bits = view.getUint16(body + 14, true);
			if (format === 65534 && size >= 26) format = view.getUint16(body + 24, true);
		} else if (id === "data") {
			if (!channels || !sampleRate || !bits) throw new Error("a WAV without its format");
			return {
				mono: wavSamples(view, body, size === 0 || size === 4294967295 || body + size > bytes.length ? bytes.length : body + size, format, channels, bits),
				sampleRate
			};
		}
		at = body + size + (size & 1);
	}
	throw new Error("a WAV without sound");
}
function wavSamples(view, from, to, format, channels, bits) {
	const width = bits / 8;
	const read = format === 1 && bits === 8 ? (at) => (view.getUint8(at) - 128) / 128 : format === 1 && bits === 16 ? (at) => view.getInt16(at, true) / 32768 : format === 1 && bits === 24 ? (at) => (view.getInt8(at + 2) << 16 | view.getUint8(at + 1) << 8 | view.getUint8(at)) / 8388608 : format === 1 && bits === 32 ? (at) => view.getInt32(at, true) / 2147483648 : format === 3 && bits === 32 ? (at) => view.getFloat32(at, true) : format === 3 && bits === 64 ? (at) => view.getFloat64(at, true) : void 0;
	if (!read) throw new Error(`a WAV in a format not read here (${format}, ${bits} bit)`);
	const frames = Math.floor((to - from) / (width * channels));
	const mono = new Float32Array(frames);
	for (let frame = 0; frame < frames; frame++) {
		let sum = 0;
		for (let c = 0; c < channels; c++) sum += read(from + (frame * channels + c) * width);
		mono[frame] = sum / channels;
	}
	return mono;
}
/** A variable-length number in EBML: its length in bytes and value (the marker bit kept for ids, dropped for sizes). */
function vint(bytes, at, keepMarker) {
	const first = bytes[at];
	if (first === void 0 || first === 0) return null;
	const length = Math.clz32(first) - 23;
	if (at + length > bytes.length) return null;
	let value = keepMarker ? first : first & 255 >> length;
	let allOnes = value === 255 >> length;
	for (let i = 1; i < length; i++) {
		value = value * 256 + bytes[at + i];
		if (bytes[at + i] !== 255) allOnes = false;
	}
	return {
		length,
		value,
		unknown: !keepMarker && allOnes
	};
}
/** Elements whose children are read: EBML Segment, Tracks, TrackEntry, Audio, Cluster, BlockGroup. */
var WEBM_PARENTS = /* @__PURE__ */ new Set([
	408125543,
	374648427,
	174,
	225,
	524531317,
	160
]);
/**
* The Opus track of a WebM (Matroska) file. It reads the file in order, stepping into the elements that hold what it
* needs rather than jumping by their sizes: MediaRecorder writes the Segment and every Cluster with an unknown size.
*/
function demuxWebm(bytes) {
	const tracks = [];
	const blocks = [];
	let at = 0;
	while (at < bytes.length) {
		const id = vint(bytes, at, true);
		if (!id) break;
		const size = vint(bytes, at + id.length, false);
		if (!size) break;
		const body = at + id.length + size.length;
		if (WEBM_PARENTS.has(id.value)) {
			if (id.value === 174) tracks.push({
				number: 0,
				codec: "",
				head: null,
				channels: 0
			});
			at = body;
			continue;
		}
		if (size.unknown) break;
		const end = Math.min(bytes.length, body + size.value);
		const data = bytes.subarray(body, end);
		const track = tracks.at(-1);
		if (id.value === 215 && track) track.number = uint(data);
		else if (id.value === 134 && track) track.codec = ascii(data, 0, data.length);
		else if (id.value === 25506 && track) track.head = data;
		else if (id.value === 159 && track) track.channels = uint(data);
		else if (id.value === 163 || id.value === 161) {
			const number = vint(data, 0, false);
			if (number) for (const frame of laced(data, number.length)) blocks.push({
				track: number.value,
				data: frame
			});
		}
		at = end;
	}
	const opus = tracks.find((t) => t.codec === "A_OPUS");
	if (!opus) return null;
	return {
		head: opus.head,
		channels: opus.channels || 1,
		frames: blocks.filter((b) => b.track === opus.number).map((b) => b.data)
	};
}
function uint(data) {
	let value = 0;
	for (const byte of data) value = value * 256 + byte;
	return value;
}
/** The frames in a (Simple)Block after its track number: one, or several laced (Xiph, fixed-size or EBML). */
function laced(data, at) {
	const flags = data[at + 2];
	let pos = at + 3;
	const lacing = flags >> 1 & 3;
	if (lacing === 0) return [data.subarray(pos)];
	const count = data[pos++] + 1;
	const sizes = [];
	if (lacing === 1) for (let i = 0; i < count - 1; i++) {
		let size = 0;
		for (let byte = 255; byte === 255; size += byte) byte = data[pos++];
		sizes.push(size);
	}
	else if (lacing === 3) {
		const first = vint(data, pos, false);
		pos += first.length;
		sizes.push(first.value);
		for (let i = 1; i < count - 1; i++) {
			const delta = vint(data, pos, false);
			pos += delta.length;
			sizes.push(sizes[i - 1] + delta.value - (2 ** (7 * delta.length - 1) - 1));
		}
	} else {
		const each = Math.floor((data.length - pos) / count);
		for (let i = 0; i < count - 1; i++) sizes.push(each);
	}
	sizes.push(data.length - pos - sizes.reduce((a, b) => a + b, 0));
	const frames = [];
	for (const size of sizes) {
		frames.push(data.subarray(pos, pos + size));
		pos += size;
	}
	return frames;
}
/** The first Opus stream of an Ogg file: its packets put back together from the pages' segments. */
function demuxOgg(bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let serial;
	let head = null;
	const frames = [];
	let packet = [];
	let endGranule;
	let at = 0;
	while (at + 27 <= bytes.length && ascii(bytes, at, 4) === "OggS") {
		const segments = bytes[at + 26];
		const table = bytes.subarray(at + 27, at + 27 + segments);
		let pos = at + 27 + segments;
		const pageSerial = view.getUint32(at + 14, true);
		const granule = Number(view.getBigInt64(at + 6, true));
		if (serial === void 0 ? ascii(bytes, pos, 8) === "OpusHead" : pageSerial === serial) {
			serial = pageSerial;
			if (granule >= 0) endGranule = granule;
			for (const size of table) {
				packet.push(bytes.subarray(pos, pos + size));
				pos += size;
				if (size < 255) {
					const whole = packet.length === 1 ? packet[0] : Buffer.concat(packet);
					packet = [];
					if (!head) head = whole;
					else if (ascii(whole, 0, 8) !== "OpusTags") frames.push(whole);
				}
			}
		} else pos += table.reduce((a, b) => a + b, 0);
		at = pos;
	}
	if (!head) return null;
	return {
		head,
		channels: head[9] ?? 1,
		frames,
		endGranule
	};
}
async function decodeOpus(stream) {
	const { OpusDecoder } = await import("opus-decoder");
	const head = stream.head && ascii(stream.head, 0, 8) === "OpusHead" ? stream.head : null;
	const channels = head ? head[9] : Math.max(1, stream.channels);
	const preSkip = head ? head[10] | head[11] << 8 : 0;
	const decoder = new OpusDecoder({
		channels,
		preSkip,
		...(head ? head[18] : 0) !== 0 && head ? {
			streamCount: head[19],
			coupledStreamCount: head[20],
			channelMappingTable: [...head.subarray(21, 21 + channels)]
		} : {
			streamCount: 1,
			coupledStreamCount: channels - 1,
			channelMappingTable: channels === 1 ? [0] : [0, 1]
		}
	});
	await decoder.ready;
	try {
		const decoded = decoder.decodeFrames(stream.frames);
		let length = decoded.samplesDecoded;
		if (stream.endGranule !== void 0 && stream.endGranule > preSkip) length = Math.min(length, stream.endGranule - preSkip);
		return {
			mono: mix(decoded.channelData, length),
			sampleRate: decoded.sampleRate
		};
	} finally {
		decoder.free();
	}
}
async function decodeMp3(bytes) {
	const { MPEGDecoder } = await import("mpg123-decoder");
	const decoder = new MPEGDecoder();
	await decoder.ready;
	try {
		const decoded = decoder.decode(bytes);
		if (!decoded.samplesDecoded) throw new Error("no MP3 frames in it");
		return {
			mono: mix(decoded.channelData, decoded.samplesDecoded),
			sampleRate: decoded.sampleRate
		};
	} finally {
		decoder.free();
	}
}
/** Anything ffmpeg reads, as a float WAV on its output (the channels kept, so they are averaged as above). */
function decodeWithFfmpeg(path, command = process.env.GHOSTLY_FFMPEG || "ffmpeg") {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [
			"-v",
			"error",
			"-nostdin",
			"-i",
			path,
			"-vn",
			"-f",
			"wav",
			"-c:a",
			"pcm_f32le",
			"-"
		], { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		const chunks = [];
		let size = 0, errors = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), FFMPEG_TIMEOUT_MS);
		child.stdout.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BYTES * 2) child.kill("SIGKILL");
			else chunks.push(chunk);
		});
		child.stderr.on("data", (chunk) => {
			if (errors.length < 2e3) errors += chunk.toString();
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(/* @__PURE__ */ new Error(error.code === "ENOENT" ? "no decoder here for this kind of audio (install ffmpeg to read it)" : `ffmpeg: ${error.message}`));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(/* @__PURE__ */ new Error(`ffmpeg could not read it${errors.trim() ? `: ${errors.trim().split("\n")[0]}` : ""}`));
				return;
			}
			try {
				resolve(decodeWav(Buffer.concat(chunks)));
			} catch (error) {
				reject(error);
			}
		});
	});
}
//#endregion
//#region src/files.ts
/**
* Files and voice notes in a chat (WISP 1100, phase 3), as the app's composer sends them (packages/browser
* platform/services.ts `sendFile`): the bytes go into the profile's file store first, then the engine offers them.
* Large files follow files/3: the receiving side's person (here, a command) accepts or declines each offer.
*
* In a group (WISP 503 · Group Files) the file is announced as a group message, and each member's app fetches the
* bytes from whoever holds them: by itself up to the automatic limits, on `file accept` past them.
*/
var TYPES$1 = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".pdf": "application/pdf",
	".txt": "text/plain",
	".md": "text/markdown",
	".json": "application/json",
	".csv": "text/csv",
	".zip": "application/zip",
	".mp3": "audio/mpeg",
	".m4a": "audio/mp4",
	".ogg": "audio/ogg",
	".opus": "audio/ogg",
	".wav": "audio/wav",
	".webm": "audio/webm",
	".mp4": "video/mp4",
	".mov": "video/quicktime"
};
function mimeOf(path, given) {
	return sanitizeMime(given ?? TYPES$1[extname(path).toLowerCase()] ?? "application/octet-stream");
}
/** A chat's files as the timeline shows them, with where each transfer stands (`transferOf`, by file id). */
function filesOf(messages, transferOf) {
	return messages.filter((m) => m.file).map((m) => ({
		messageId: m.id,
		from: m.sender,
		timestamp: m.timestamp,
		file: {
			id: m.file.id,
			name: m.file.name,
			size: m.file.size,
			mime: m.file.mime,
			...m.file.voice ? { voice: m.file.voice } : {},
			...m.file.image ? { image: m.file.image } : {}
		},
		transfer: transferOf(m.file.id) ?? null
	}));
}
/** The chat or the group a file command names (`findChatOrGroup`). */
var chatOrGroupOf = (ctx, params) => findChatOrGroup(state(ctx).links, state(ctx).groups, str(params, "chat", true));
/**
* The chat or group a file belongs to: a file id starts with its chat's id (a group's file with `group-<id>-`), so it
* may be left out; given, it must be the file's own. `where` is what the answer names it by.
*/
function fileChat(ctx, params, fileId) {
	const groupId = groupOfFile(fileId, state(ctx).groups.map((g) => g.id));
	if (groupId) {
		const named = params.chat === void 0 ? void 0 : chatOrGroupOf(ctx, params);
		if (named && !("group" in named && named.group.id === groupId)) throw new CliError("not_found", `No file ${fileId} in this ${"group" in named ? "group" : "chat"}`);
		return {
			linkId: `group:${groupId}`,
			where: { group: groupId }
		};
	}
	const link = params.chat === void 0 ? state(ctx).links.find((l) => fileId.startsWith(`${l.id}-in-`) || fileId.startsWith(`${l.id}-out-`)) : chatOf(ctx, params);
	if (!link) throw new CliError("not_found", `No file ${fileId}`);
	if (!fileId.startsWith(`${link.id}-`)) throw new CliError("not_found", `No file ${fileId} in this chat`);
	return {
		linkId: link.id,
		where: { chat: link.id }
	};
}
var VOICE_ONLY = "A voice note is audio (webm, ogg, mp4, mpeg, aac, m4a or wav) of at most 15 minutes, with peaks from 0 to 255";
/** `--voice [ms] [--peaks …]`: the voice description, its length and waveform measured from the sound when not given. */
async function voiceOf(params, path, mime) {
	if (params.voice === void 0) return {};
	if (!PLAYABLE_AUDIO.test(baseMime(mime))) throw new CliError("bad_request", VOICE_ONLY);
	let duration = params.voice === true ? void 0 : num(params, "voice", 0, { min: 1 });
	let peaks = list(params, "peaks").map(Number);
	let warning;
	if (duration === void 0 || !peaks.length) {
		const measured = await measureVoice(path);
		if ("voice" in measured) {
			duration ??= measured.voice.duration;
			if (!peaks.length) peaks = measured.voice.peaks;
		} else if (duration === void 0) throw new CliError("bad_request", `Could not measure the voice note (${measured.problem}): give its length as --voice <ms>`);
		else warning = `Sent without a waveform: could not read the sound (${measured.problem})`;
	}
	const voice = parseVoiceMeta({
		duration,
		peaks: peaks.length ? peaks : new Array(VOICE_LIMITS.bars).fill(0)
	}, mime);
	if (!voice) throw new CliError("bad_request", VOICE_ONLY);
	return {
		voice,
		...warning ? { warning } : {}
	};
}
/**
* A file announced in a group (WISP 503): its bytes staged under a group file id with their digest, as a chat's are, then
* the announcement. This device is its first holder and serves the members who ask.
*/
async function sendToGroup(ctx, params, group, path, size) {
	if (size > GROUP_FILE_LIMITS.maxBytes) throw new CliError("refused", `Too large for a group (at most ${GROUP_FILE_LIMITS.maxBytes} bytes)`);
	if (!size) throw new CliError("refused", "An empty file cannot go to a group");
	const mime = mimeOf(path, str(params, "mime"));
	const replyTo = str(params, "reply");
	if (replyTo) {
		if (!(await node(ctx).groupMessages({ groupId: group.id })).some((m) => m.id === replyTo || replyRef(m) === replyTo)) throw new CliError("not_found", "That message is not in this group, or cannot be replied to");
	}
	const check = await node(ctx).groupFileCheck({ groupId: group.id });
	if (check.error) throw check.refused ? new CliError("refused", check.error) : groupSendRefused(check.error);
	const { voice, warning } = await voiceOf(params, path, mime);
	const source = await openAsBlob(path, { type: mime });
	const image = voice ? void 0 : await readImageMeta(source, mime);
	const fileId = groupFileId(group.id, "out");
	const file = {
		id: fileId,
		name: sanitizeFileName(str(params, "name") ?? basename(path)),
		size,
		mime,
		...voice ? { voice } : {},
		...image ? { image } : {}
	};
	const timestamp = Date.now();
	const bytes = await fileBytes();
	const digest = await bytes.stage(fileId, source);
	await fileStore.put({
		id: fileId,
		linkId: `group:${group.id}`,
		bytes: bytes.kind,
		digest,
		createdAt: timestamp,
		direction: "out",
		metadata: {
			name: file.name,
			size,
			mime,
			timestamp,
			...voice ? { voice } : {},
			...image ? { image } : {}
		},
		transfer: {
			state: "transferring",
			transferred: 0,
			size
		}
	});
	endTyping(ctx, { groupId: group.id }, false);
	const result = await node(ctx).sendGroupFile({
		groupId: group.id,
		file,
		...replyTo ? { replyTo } : {}
	});
	if (result.error) {
		await removeStored(fileId).catch(() => {});
		throw result.refused ? new CliError("refused", result.error) : groupSendRefused(result.error);
	}
	return {
		group: group.id,
		messageId: result.messageId ?? null,
		file: {
			id: fileId,
			name: file.name,
			size,
			mime,
			...voice ? { voice: true } : {},
			...image ? { image } : {}
		},
		...warning ? { warning } : {}
	};
}
/** Bytes a file system takes in one name: 255 on ext4, btrfs, APFS (NTFS counts 255 UTF-16 units, within this too). */
var NAME_BYTES = 255;
/**
* `name` as an entry of a folder: an app's name may have 200 characters, which in UTF-8 can be 800 bytes. The end of
* its stem goes until it fits, its extension stays (as `sanitizeFileName` shortens it), so "文…文.txt" is saved as a text.
*/
function fitName(name) {
	const fits = (candidate) => Buffer.byteLength(candidate) <= NAME_BYTES;
	if (fits(name)) return name;
	const extension = /\.[^.\s]{1,15}$/u.exec(name)?.[0] ?? "";
	const stem = [...name.slice(0, name.length - extension.length)];
	while (stem.length && !fits(stem.join("").trimEnd() + extension)) stem.pop();
	return (stem.join("").trimEnd() || "file") + extension;
}
/**
* The name `file save --dir` writes a file under. Its sender chose it, and the folder is one scripts and people run
* tools in: a name that starts with a dash is an option to the tool a `*` hands it to ("-rf", "--checkpoint-action=…"),
* so it gets a `_` first, as a Windows device name does in `sanitizeFileName`.
*/
function saveName(name) {
	const clean = sanitizeFileName(name);
	return fitName(clean.startsWith("-") ? `_${clean}` : clean);
}
var ACTIONS = [
	"accept",
	"decline",
	"pause",
	"resume",
	"cancel",
	"resend",
	"request"
];
var FILE_METHODS = {
	async "file.send"(ctx, params) {
		const target = chatOrGroupOf(ctx, params);
		const path = resolve(str(params, "path", true));
		let info;
		try {
			info = await stat(path);
		} catch {
			throw new CliError("not_found", `No file ${path}`);
		}
		if (!info.isFile()) throw new CliError("bad_request", `${path} is not a file`);
		await access(path, constants$1.R_OK);
		if ("group" in target) return sendToGroup(ctx, params, target.group, path, info.size);
		const { link } = target;
		if (link.profile && link.dataLink === "open" && !link.capabilities?.files) throw new CliError("unavailable", "The contact's app takes no files");
		if (!link.capabilities?.largeFiles && info.size > LIMITS.maxFileBytes) throw new CliError("refused", `Too large for the contact's app (at most ${LIMITS.maxFileBytes} bytes)`);
		if (typeof link.peerFileRoom === "number" && info.size > link.peerFileRoom) throw new CliError("refused", `Not enough space on the contact's device (${link.peerFileRoom} bytes free)`);
		const mime = mimeOf(path, str(params, "mime"));
		const replyTo = str(params, "reply");
		if (replyTo) {
			if (!(await node(ctx).getMessages(link.id)).some((m) => m.id === replyTo || replyRef(m) === replyTo)) throw new CliError("not_found", "That message is not in this chat, or cannot be replied to");
		}
		const { voice, warning } = await voiceOf(params, path, mime);
		const source = await openAsBlob(path, { type: mime });
		const image = voice ? void 0 : await readImageMeta(source, mime);
		const wireId = toBase64Url(randomBytes$1(12));
		const file = {
			id: `${link.id}-out-${wireId}`,
			name: sanitizeFileName(str(params, "name") ?? basename(path)),
			size: info.size,
			mime,
			...voice ? { voice } : {},
			...image ? { image } : {}
		};
		const timestamp = sentAt();
		const bytes = await fileBytes();
		const digest = await bytes.stage(file.id, source);
		await fileStore.put({
			id: file.id,
			linkId: link.id,
			bytes: bytes.kind,
			digest,
			createdAt: timestamp,
			direction: "out",
			wireId,
			metadata: {
				name: file.name,
				size: file.size,
				mime: file.mime,
				timestamp,
				...voice ? { voice } : {},
				...image ? { image } : {}
			},
			transfer: {
				state: "transferring",
				transferred: 0,
				size: file.size
			}
		});
		endTyping(ctx, { linkId: link.id }, true);
		try {
			await node(ctx).sendFile({
				linkId: link.id,
				file,
				timestamp,
				...replyTo ? { replyTo } : {}
			});
		} catch (error) {
			await removeStored(file.id).catch(() => {});
			throw new CliError("refused", error instanceof Error ? error.message : String(error));
		}
		return {
			chat: link.id,
			file: {
				id: file.id,
				name: file.name,
				size: file.size,
				mime: file.mime,
				...voice ? { voice: true } : {},
				...image ? { image } : {}
			},
			...warning ? { warning } : {}
		};
	},
	async "file.list"(ctx, params) {
		const target = chatOrGroupOf(ctx, params);
		const views = state(ctx).transfers;
		const keptOf = async (linkId) => new Map((await fileStore.listForLink(linkId).catch(() => [])).flatMap((f) => {
			const kept = f.transfer?.state === "done" ? {
				...f.transfer,
				direction: f.direction
			} : waitingGroupFile(f);
			return kept ? [[f.id, kept]] : [];
		}));
		if ("group" in target) {
			const kept = await keptOf(`group:${target.group.id}`);
			return {
				group: target.group.id,
				files: filesOf(await node(ctx).groupMessages({ groupId: target.group.id }), (id) => views[id] ?? kept.get(id))
			};
		}
		const kept = await keptOf(target.link.id);
		return {
			chat: target.link.id,
			files: filesOf(await node(ctx).getMessages(target.link.id), (id) => views[id] ?? kept.get(id))
		};
	},
	/**
	* files/3: answer an offer, or pause, resume or cancel a transfer, either way; `resend` a file sent from here that
	* stopped moving (or failed), `request` again one that stopped arriving. Without a chat, the file's id names it.
	* A group's file (WISP 503) takes `accept` (download one this device did not fetch by itself), `request`, and `cancel`,
	* `decline`, `pause` and `resume` for one that is coming.
	*/
	async "file.action"(ctx, params) {
		const fileId = str(params, "file", true);
		const { linkId, where } = fileChat(ctx, params, fileId);
		const action = oneOf(params, "action", ACTIONS, "accept");
		const refuseAllHere = async () => {
			if ((state(ctx).transfers[fileId] ?? (await fileStore.get(fileId).catch(() => void 0))?.transfer)?.state === "done") throw new CliError("refused", action === "accept" || action === "request" || action === "resume" ? "Nothing to ask for: the file is all here" : "Nothing to stop: the file is all here");
		};
		if ("group" in where) {
			if (action === "resend") throw new CliError("bad_request", "A group's file is downloaded (file accept) or asked for again (file request)");
			await refuseAllHere();
			try {
				await node(ctx).fileAction({
					linkId,
					fileId,
					action
				});
			} catch (error) {
				throw new CliError("refused", error instanceof Error ? error.message : String(error));
			}
			return {
				...where,
				file: fileId,
				action,
				transfer: state(ctx).transfers[fileId] ?? null
			};
		}
		if (action === "resend" || action === "request") {
			const outgoing = fileId.startsWith(`${linkId}-out-`);
			if (outgoing !== (action === "resend")) throw new CliError("bad_request", outgoing ? "A file sent from here is sent again: file resend" : "A received file is asked for again: file request");
			const transfer = state(ctx).transfers[fileId];
			if (!transfer || transfer.state === "done") throw new CliError("refused", outgoing ? "Nothing to send again: it arrived whole" : "Nothing to ask for: the file is all here");
			if (transfer.state === "failed" && (!outgoing || !transfer.retry)) throw new CliError("refused", `It ended: ${transfer.error ?? "failed"}`);
		} else await refuseAllHere();
		await node(ctx).fileAction({
			linkId,
			fileId,
			action
		});
		return {
			...where,
			file: fileId,
			action,
			transfer: state(ctx).transfers[fileId] ?? null
		};
	},
	/**
	* Until a transfer ends: done answers, failed is an `engine` error with the transfer's words (and whether `file
	* resend` can go on). A file whose transfer this run has not seen answers from the file store.
	*/
	async "file.wait"(ctx, params) {
		const fileId = str(params, "file", true);
		const { where } = fileChat(ctx, params, fileId);
		const stored = await fileStore.get(fileId);
		if (!stored && !state(ctx).transfers[fileId]) throw new CliError("not_found", `No file ${fileId}`);
		const ms = num(params, "timeout", 300, {
			min: 1,
			max: 86400
		}) * 1e3;
		const transfer = await waitForState(ctx, (s) => {
			const now = s.transfers[fileId] ?? stored?.transfer;
			return now && (now.state === "done" || now.state === "failed") ? now : void 0;
		}, ms, `file ${fileId} to arrive`).catch((error) => {
			const now = state(ctx).transfers[fileId];
			if (error instanceof CliError && error.code === "timeout" && now) throw new CliError("timeout", `${error.message} (${now.transferred} of ${now.size} bytes${now.stage ? `, ${now.stage}` : ""})`, {
				file: fileId,
				transferred: now.transferred,
				size: now.size,
				stage: now.stage ?? null
			});
			throw error;
		});
		if (transfer.state === "failed") throw new CliError("engine", transfer.error ?? "The transfer failed", {
			file: fileId,
			...where,
			retry: !!transfer.retry
		});
		return {
			...where,
			file: fileId,
			state: "done",
			size: transfer.size
		};
	},
	/** Writes a received (or sent) file to disk: into `dir` under its own name (`saveName`), or to `path`. Never over a file unless `force`. */
	async "file.save"(ctx, params) {
		const fileId = str(params, "file", true);
		if (params.chat !== void 0) fileChat(ctx, params, fileId);
		if (bool(params, "wait")) await FILE_METHODS["file.wait"](ctx, {
			file: fileId,
			timeout: params.timeout
		});
		const stored = await fileStore.get(fileId);
		if (!stored?.metadata) throw new CliError("not_found", `No file ${fileId}`);
		if (stored.leftOut) throw new CliError("not_found", "Not in this backup: the light backup this profile was restored from left the file out");
		const transfer = stored.direction === "out" ? void 0 : state(ctx).transfers[fileId] ?? stored.transfer;
		if (transfer && transfer.state !== "done") throw new CliError("unavailable", `The file is not all here yet (${transfer.transferred} of ${transfer.size} bytes)`);
		const target = str(params, "path") ? resolve(str(params, "path", true)) : join(resolve(str(params, "dir") ?? "."), saveName(stored.metadata.name));
		const flags = bool(params, "force") ? "w" : "wx";
		let out;
		try {
			out = await open(target, flags, 384);
		} catch (error) {
			const code = error.code;
			if ((code === "EEXIST" || code === "EISDIR") && (await stat(target).catch(() => void 0))?.isDirectory()) throw new CliError("bad_request", `${target} is a folder: name a file, or use dir (--dir ${target})`);
			if (code === "EEXIST") throw new CliError("confirm", `${target} exists: pass force (--force) to replace it`);
			throw error;
		}
		let written = 0, complete = false;
		try {
			const backend = stored.bytes ? await fileBytesOf(stored.bytes) : null;
			if (backend) {
				const size = await backend.size(fileId);
				if (size === null) throw new CliError("not_found", "The file's bytes are not on this device");
				for (let offset = 0; offset < size; offset += FILE_BYTES_STEP) {
					const chunk = await backend.read(fileId, offset, FILE_BYTES_STEP);
					await out.write(chunk);
					written += chunk.length;
				}
			} else if (stored.blob) {
				const chunk = new Uint8Array(await stored.blob.arrayBuffer());
				await out.write(chunk);
				written = chunk.length;
			} else throw new CliError("not_found", "The file's bytes are not on this device");
			complete = true;
		} finally {
			await out.close();
			if (!complete) await rm(target, { force: true });
		}
		return {
			file: fileId,
			path: target,
			size: written,
			name: stored.metadata.name,
			mime: stored.metadata.mime
		};
	}
};
//#endregion
//#region src/statusCards.ts
/** A card's updates go at most this often: the rest merge into the next, so a chatty bot spends few edits. */
var CARD_UPDATE_GAP_MS = 2500;
var paces = /* @__PURE__ */ new WeakMap();
function paceOf(ctx, key) {
	let map = paces.get(ctx);
	if (!map) paces.set(ctx, map = /* @__PURE__ */ new Map());
	let pace = map.get(key);
	if (!pace) map.set(key, pace = { last: 0 });
	return pace;
}
var isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** The fields a command gave: an object, or a usage error that says so. */
function fieldsOf(params) {
	const fields = params.card ?? {};
	if (!isObject(fields)) throw new CliError("bad_request", "card must be an object of the card's fields");
	return fields;
}
/**
* An update merged over a card: fields given replace those there, `pr` field by field, and a field given as null goes
* (`--json '{"step":null}'`). The kind and the id never change.
*/
function mergeCard(base, patch) {
	const out = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (key === "kind" || key === "id") continue;
		if (value === null) {
			delete out[key];
			continue;
		}
		if (key === "pr" && isObject(value) && isObject(base.pr)) {
			const pr = { ...base.pr };
			for (const [k, v] of Object.entries(value)) if (v === null) delete pr[k];
			else pr[k] = v;
			out.pr = pr;
			continue;
		}
		out[key] = value;
	}
	return out;
}
/**
* A routine's run from the command (`run: {result, summary?}`), as its last run and the first of its recent runs,
* `STATUS_CARD_LIMITS.runs` kept. Undefined when the command names none.
*/
function withRun(fields, params, now = Date.now()) {
	const run = params.run;
	if (run === void 0) return fields;
	if (!isObject(run) || typeof run.result !== "string") throw new CliError("bad_request", "run is {result: ok|failed|skipped, summary?}");
	const lastRun = {
		at: now,
		result: run.result,
		...typeof run.summary === "string" && run.summary ? { summary: run.summary } : {}
	};
	const before = Array.isArray(fields.runs) ? fields.runs : [];
	return {
		...fields,
		lastRun,
		runs: [lastRun, ...before].slice(0, STATUS_CARD_LIMITS.runs)
	};
}
/** A card checked by the sender's rule, or a `bad_request` that says what is wrong. */
function checked(card) {
	const result = checkStatusCard(card);
	if ("error" in result) throw new CliError("bad_request", `Status card: ${result.error}`, { card });
	return result.card;
}
/** Every text in a card's fields (title, step, items, runs, links…), as the contact's app may show it. */
function cardTexts(value, out = []) {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) cardTexts(item, out);
	else if (isObject(value)) for (const item of Object.values(value)) cardTexts(item, out);
	return out;
}
/**
* The secret guard `send` has (docs/CLI.md § Safety): a card whose text looks like a seed, a private key or a Cashu
* token goes only with `--force`. `fields` are what this command gives (an update's own, not the card it merges over).
* A card's text is read as given and as the card carries it (`cardLine`): a line loses its invisible characters on the
* way, so a key one of them broke in two is whole again on the card. The fallback text goes as it is, as `send`'s.
*/
function guardSecrets(fields, params, verb) {
	if (bool(params, "force")) return;
	const check = (text) => {
		const secret = findSecret(text);
		if (secret) throw new CliError("confirm", `The card's text looks like ${secret.kind === "cashu" ? "a Cashu token (money anyone who reads it can take)" : "a secret (a seed or a private key)"}; ${verb} it with --force if you mean to`, { kind: secret.kind });
	};
	for (const text of cardTexts([fields, params.run])) {
		check(text);
		check(cardLine(text, Infinity) ?? "");
	}
	if (typeof params.text === "string") check(params.text);
}
/** Per card (its chat or group, its kind and its id): the message of mine that carries it, as this process last saw it. */
var carriers = /* @__PURE__ */ new WeakMap();
var carrierKey = (linkId, kind, id) => `${linkId}\n${kind}\n${id}`;
function carriersOf(ctx) {
	let map = carriers.get(ctx);
	if (map) return map;
	carriers.set(ctx, map = /* @__PURE__ */ new Map());
	const cards = map;
	ctx.hub.onEvent((event) => {
		if (event.type !== "message.sent" && event.type !== "group.sent") return;
		const message = event.message;
		const card = message?.card;
		if (typeof message?.id !== "string" || typeof card?.id !== "string" || card.kind !== "task" && card.kind !== "routine" && card.kind !== "usage") return;
		carried(cards, carrierKey(event.type === "group.sent" ? `group:${String(event.group)}` : String(event.chat), card.kind, card.id), message.id);
	});
	return map;
}
function carried(cards, key, messageId) {
	cards.delete(key);
	cards.set(key, messageId);
	if (cards.size > 1e3) cards.delete(cards.keys().next().value);
}
/**
* The latest message of mine in this chat or group with a card of this kind and id: the one an update edits. A card
* this process sent or found before is read by its message's key, so its updates cost the same in a long chat as in a
* short one; only a card not seen yet (the first update after a start, a one-shot) is looked for in the whole history.
*/
async function cardMessage(ctx, target, kind, id) {
	const cards = carriersOf(ctx), key = carrierKey(target.linkId, kind, id);
	const carries = (message) => message?.sender === "me" && message.card?.kind === kind && message.card.id === id;
	const known = cards.get(key);
	if (known !== void 0) {
		const message = await node(ctx).getMessage(target.linkId, known);
		if (carries(message)) return message;
		cards.delete(key);
	}
	const messages = target.group ? await node(ctx).groupMessages({ groupId: target.id }) : await node(ctx).getMessages(target.linkId);
	if (cards.has(key)) return cardMessage(ctx, target, kind, id);
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!carries(message)) continue;
		carried(cards, key, message.id);
		return message;
	}
	throw new CliError("not_found", `No ${kind} ${JSON.stringify(id)} of yours in this ${target.group ? "group" : "chat"}: send it first with ghostly ${kind} send`);
}
function answer(target, kind, id, messageId, extra) {
	return {
		[target.group ? "group" : "chat"]: target.id,
		[kind]: id,
		messageId,
		...extra
	};
}
/**
* A task's parent is another task of mine in the same chat or group (WISP 405 · Status Cards § A task): one that is
* not there is refused here, with its name, rather than sent to stand alone on every board (a reader keeps the field
* and shows the task ungrouped). Send the parent first.
*/
async function parentThere(ctx, target, card) {
	if (card.kind !== "task" || !card.parent) return;
	const parent = card.parent;
	await cardMessage(ctx, target, "task", parent).catch(() => {
		throw new CliError("not_found", `--parent: no task ${JSON.stringify(parent)} of yours in this ${target.group ? "group" : "chat"}: send the parent first`);
	});
}
/** A new card: a message whose text is written from it, in a chat or a group. */
async function sendCard(ctx, params, kind) {
	const target = chatOrGroup(ctx, str(params, "chat", true));
	const fields = fieldsOf(params);
	guardSecrets(fields, params, "send");
	const now = Date.now();
	const id = typeof fields.id === "string" && fields.id ? fields.id : `${kind}-${toBase64Url(randomBytes$1(6))}`;
	const card = checked(withRun({
		...kind === "task" ? {
			status: "running",
			startedAt: now,
			updatedAt: now
		} : kind === "routine" ? { state: "active" } : {},
		...fields,
		kind,
		id
	}, params, now));
	await parentThere(ctx, target, card);
	const text = str(params, "text") ?? "";
	const wait = oneOf(params, "wait", target.group ? ["none", "sent"] : [
		"none",
		"sent",
		"delivered"
	], "none");
	const ms = num(params, "timeout", 30, {
		min: 1,
		max: 3600
	}) * 1e3;
	if (target.group) {
		const result = await node(ctx).sendGroupMessage({
			groupId: target.id,
			text,
			card
		});
		if (result.error || !result.messageId) throw new CliError(result.refused ? "refused" : "unavailable", result.error ?? "Nothing to send");
		carried(carriersOf(ctx), carrierKey(target.linkId, kind, id), result.messageId);
		const edges = wait === "sent" ? await waitForGroupFrame(ctx, target.id, result.messageId, void 0, ms) : void 0;
		return answer(target, kind, id, result.messageId, {
			card,
			...edges !== void 0 && { edges }
		});
	}
	const result = await node(ctx).sendMessage({
		linkId: target.linkId,
		text,
		card
	});
	if (result.error) throw new CliError(result.refused ? "refused" : "unavailable", result.error);
	if (!result.messageId) throw new CliError("bad_request", "Nothing to send");
	carried(carriersOf(ctx), carrierKey(target.linkId, kind, id), result.messageId);
	let message = await node(ctx).getMessage(target.linkId, result.messageId);
	if (wait !== "none") message = await waitForMessage(ctx, target.linkId, result.messageId, wait, ms);
	return answer(target, kind, id, result.messageId, {
		card,
		delivery: message?.delivery ?? null
	});
}
/** Edits the card's message with its merged card, now. */
async function editCard(ctx, target, messageId, card, text) {
	const result = await node(ctx).editMessage({
		linkId: target.linkId,
		messageId,
		text,
		card
	});
	if (result.error) throw new CliError(result.refused ? "refused" : "unavailable", result.error);
}
/**
* An update of a card of mine: the fields given, merged over its latest state (what waits to go included). It goes at
* once when the card's last update is `CARD_UPDATE_GAP_MS` old; otherwise it waits for that, merged with any update
* that comes meanwhile (`queued: true`). A one-shot command waits the time out itself: it has no daemon to wait in.
*/
async function updateCard(ctx, params, kind) {
	const target = chatOrGroup(ctx, str(params, "chat", true));
	const id = str(params, kind, true);
	const patch = fieldsOf(params);
	guardSecrets(patch, params, "update");
	const message = await cardMessage(ctx, target, kind, id);
	if ((message.edit?.seq ?? 0) >= STATUS_CARD_LIMITS.edits) throw new CliError("refused", `This ${kind}'s message took ${STATUS_CARD_LIMITS.edits} updates, the most one takes: start a new card with ghostly ${kind} send (a new --id, or the same one: the newest card of an id stands for it)`, {
		messageId: message.id,
		edits: message.edit.seq
	});
	const pace = paceOf(ctx, `${target.linkId}\n${message.id}`);
	const card = checked(withRun(mergeCard(pace.next ?? message.card, {
		...patch,
		...kind === "task" && { updatedAt: Date.now() }
	}), params));
	if (isObject(patch) && patch.parent !== void 0) await parentThere(ctx, target, card);
	const text = str(params, "text") ?? "";
	const wait = oneOf(params, "wait", target.group ? ["none", "sent"] : ["none", "confirmed"], "none");
	const ms = num(params, "timeout", 30, {
		min: 1,
		max: 3600
	}) * 1e3;
	const due = Math.max(pace.last, message.edit?.at ?? message.timestamp) + CARD_UPDATE_GAP_MS - Date.now();
	let queued = false;
	if (due > 0 && ctx.mode === "daemon") {
		pace.next = card;
		queued = true;
		if (!pace.timer) pace.flushed = new Promise((resolve) => {
			const send = () => {
				const next = pace.next;
				clearTimeout(pace.timer);
				pace.timer = void 0;
				pace.next = void 0;
				pace.flush = void 0;
				pace.last = Date.now();
				(next ? editCard(ctx, target, message.id, next, text) : Promise.resolve()).catch(() => {}).finally(resolve);
			};
			pace.flush = send;
			pace.timer = setTimeout(send, due);
		});
		if (wait !== "none") await pace.flushed;
	} else {
		if (due > 0) await new Promise((resolve) => setTimeout(resolve, due));
		pace.last = Date.now();
		await editCard(ctx, target, message.id, card, text);
	}
	let edited = await node(ctx).getMessage(target.linkId, message.id);
	if (wait === "confirmed" && edited?.edit?.pending) edited = await waitForEdit(ctx, target.linkId, message.id, ms);
	const edges = wait === "sent" && edited?.edit ? await waitForGroupFrame(ctx, target.id, message.id, edited.edit.seq, ms) : void 0;
	return answer(target, kind, id, message.id, {
		card,
		queued,
		edits: edited?.edit?.seq ?? 0,
		...target.group ? { ...edges !== void 0 && { edges } } : { confirmed: (!queued || wait !== "none") && !!edited && !edited.edit?.pending }
	});
}
/**
* Sends now every update still waiting for its time: the daemon is stopping, and the update it answered `queued` for
* (often a task's last one, done or failed) would otherwise go with it, leaving the card running for good. Called
* while the engine can still store the edit; it goes to the contact as any edit does, now or once they are back.
*/
async function flushCardUpdates(ctx) {
	const waiting = [...paces.get(ctx)?.values() ?? []].filter((pace) => pace.flush);
	for (const pace of waiting) pace.flush();
	await Promise.all(waiting.map((pace) => pace.flushed));
}
/** A usage card's fields: all of them are said again by each report, so one not given goes from the card. */
var USAGE_FIELDS = [
	"left",
	"used",
	"limit",
	"label",
	"account",
	"window",
	"resetsAt",
	"updatedAt",
	"windows"
];
/** The id a bot's usage card goes by when it names none: one live card per chat. */
var USAGE_CARD_ID = "usage";
/**
* One chat's usage report (WISP 405 § Usage): the bot's usage card there, kept as one message. The first report sends
* it; every later one edits it in place (quiet: no sound, no unread, no move in the list), paced as a task's updates.
* A report is whole: what it does not say goes from the card. A card at its edits' cap gives way to a new message.
*/
async function reportUsage(ctx, ref, fields, params) {
	const target = chatOrGroup(ctx, ref);
	const id = typeof fields.id === "string" && fields.id ? fields.id : USAGE_CARD_ID;
	const report = {
		updatedAt: Date.now(),
		...fields,
		kind: "usage",
		id
	};
	checked(report);
	const sent = await cardMessage(ctx, target, "usage", id).catch(() => void 0);
	const wait = oneOf(params, "wait", ["none", "sent"], "none");
	if (!sent || (sent.edit?.seq ?? 0) >= STATUS_CARD_LIMITS.edits) return {
		...await sendCard(ctx, {
			...params,
			chat: ref,
			card: report,
			wait
		}, "usage"),
		updated: false
	};
	const patch = {};
	for (const key of USAGE_FIELDS) patch[key] = report[key] ?? null;
	return {
		...await updateCard(ctx, {
			...params,
			chat: ref,
			usage: id,
			card: patch,
			wait: wait === "none" ? "none" : target.group ? "sent" : "confirmed"
		}, "usage"),
		updated: true
	};
}
/** `usage send`: one chat or group, or (`all`) every 1:1 chat with a contact; a chat that refuses is said, not fatal. */
async function sendUsage(ctx, params) {
	const fields = fieldsOf(params);
	if (!bool(params, "all")) return reportUsage(ctx, str(params, "chat", true), fields, params);
	if (str(params, "chat")) throw new CliError("bad_request", "Name a chat or --all, not both");
	checked({
		updatedAt: Date.now(),
		...fields,
		kind: "usage",
		id: typeof fields.id === "string" && fields.id ? fields.id : USAGE_CARD_ID
	});
	const chats = state(ctx).links.filter((link) => link.profile && link.peerPubKeyZ32);
	const results = [];
	for (const link of chats) try {
		results.push(await reportUsage(ctx, link.id, fields, params));
	} catch (error) {
		results.push({
			chat: link.id,
			error: error instanceof Error ? error.message : String(error)
		});
	}
	return { chats: results };
}
var STATUS_CARD_METHODS = {
	/** WISP 405 · Status Cards: a task card in a chat or a group; the answer names the task's id and its message. */
	"task.send": (ctx, params) => sendCard(ctx, params, "task"),
	/** A task's update: the fields given, merged over its latest state, paced one per `CARD_UPDATE_GAP_MS`. */
	"task.update": (ctx, params) => updateCard(ctx, params, "task"),
	/** A routine card (its schedule, state, runs); `run` records one. */
	"routine.send": (ctx, params) => sendCard(ctx, params, "routine"),
	/** A routine's update, as a task's; `run` records a run as its last and the newest of its recent ones. */
	"routine.update": (ctx, params) => updateCard(ctx, params, "routine"),
	/** WISP 405 § Usage: how much of a quota the bot has left, kept as one card per chat; `all` for every 1:1 chat. */
	"usage.send": sendUsage
};
//#endregion
//#region src/holds.ts
/**
* `chat disconnect --hold <minutes>`: a chat kept off its direct link for a while. It is the chat's own "DHT only"
* choice (WISP 400: either side choosing it keeps both off the live link, so the contact's app does not redial),
* taken back when the time is up. Text still goes over the DHT (short texts), files wait. The holds are kept in
* the profile folder: a daemon that restarts takes back the ones whose time is up, and never a DHT only the chat had
* chosen before (that one is not a hold).
*/
var HOLD_MAX_MINUTES = 10080;
var timers = /* @__PURE__ */ new WeakMap();
function holdsFile(ctx) {
	return join(ctx.runtime.paths.dir, "holds.json");
}
function readHolds(ctx) {
	try {
		return JSON.parse(readFileSync(holdsFile(ctx), "utf8"));
	} catch {
		return {};
	}
}
function writeHolds(ctx, holds) {
	const file = holdsFile(ctx);
	writeFileSync(file + ".tmp", JSON.stringify(holds) + "\n", { mode: 384 });
	renameSync(file + ".tmp", file);
}
function timersOf(ctx) {
	let map = timers.get(ctx);
	if (!map) timers.set(ctx, map = /* @__PURE__ */ new Map());
	return map;
}
function schedule(ctx, linkId, until) {
	const map = timersOf(ctx);
	clearTimeout(map.get(linkId));
	const timer = setTimeout(() => {
		map.delete(linkId);
		releaseHold(ctx, linkId, "expired").catch((error) => process.stderr.write(`ghostly: the hold on ${linkId} could not end: ${error instanceof Error ? error.message : String(error)}\n`));
	}, Math.max(0, until - Date.now()));
	timer.unref?.();
	map.set(linkId, timer);
}
/** When the chat's hold ends, or null. */
function holdOf(ctx, linkId) {
	return readHolds(ctx)[linkId]?.until ?? null;
}
/** Keeps the chat off its direct link for `minutes` (again: from now). */
async function holdChat(ctx, link, minutes) {
	const holds = readHolds(ctx);
	if (link.deliveryMode === "dht" && !holds[link.id]) throw new CliError("refused", "This chat is on DHT only already, by its own choice: chat transport auto leaves it");
	if (!link.profile) throw new CliError("unavailable", "A chat of the older protocol has no DHT only");
	const until = Date.now() + minutes * 6e4;
	if (link.deliveryMode !== "dht") try {
		await node(ctx).setChatTransport({
			linkId: link.id,
			transport: "dht"
		});
	} catch (error) {
		throw new CliError("unavailable", error instanceof Error ? error.message : String(error));
	}
	holds[link.id] = {
		until,
		since: holds[link.id]?.since ?? Date.now()
	};
	writeHolds(ctx, holds);
	schedule(ctx, link.id, until);
	ctx.hub.emit("chat.held", `chat.held:${link.id}:${until}`, {
		chat: link.id,
		until
	});
	return until;
}
/**
* Ends a hold: the chat leaves DHT only, unless someone chose otherwise meanwhile. Whether there was one. `reason`:
* expired, connect (`chat connect`) or lifted (`--hold 0`).
*/
async function releaseHold(ctx, linkId, reason) {
	const holds = readHolds(ctx);
	if (!holds[linkId]) return false;
	clearTimeout(timersOf(ctx).get(linkId));
	timersOf(ctx).delete(linkId);
	if (state(ctx).links.find((l) => l.id === linkId)?.deliveryMode === "dht") await node(ctx).setDeliveryMode({
		linkId,
		mode: "stream"
	});
	delete holds[linkId];
	writeHolds(ctx, holds);
	ctx.hub.emit("chat.released", `chat.released:${linkId}:${Date.now()}`, {
		chat: linkId,
		reason
	});
	return true;
}
/** At start: holds whose time is up end now, the others are timed again. */
function resumeHolds(ctx) {
	for (const [linkId, hold] of Object.entries(readHolds(ctx))) schedule(ctx, linkId, hold.until);
}
//#endregion
//#region src/views.ts
/**
* A live session carries the chat now, in this run: its link is open and, on a paired chat, the session authenticated
* on a transport. The engine's own rule for a chat's connection line (`observeTransport`). `textDelivery` alone says
* how a text would go, and nothing the engine remembers from an earlier run (a chat that was live when the app last
* ran, WISP 100) counts: until the contact answers again the link is not open and the pairing is `connecting`.
*/
function isLive(link) {
	if (link.textDelivery !== "stream" || link.dataLink !== "open") return false;
	return !link.profile || link.pairing?.status === "ready" && !!link.pairing.transport;
}
function chatJson(link, showSecret) {
	const label = link.label?.trim() || null;
	const peerName = link.peerNick?.trim() || null;
	const live = isLive(link);
	return {
		id: link.id,
		name: label ?? peerName,
		label,
		peerName,
		peer: link.peerPubKeyZ32,
		createdAt: link.createdAt,
		lastMessageAt: link.lastMessageAt,
		live,
		transport: live ? link.pairing?.transport ?? link.pairingProgress?.transport ?? null : null,
		text: link.textDelivery ?? (link.profile ? "unavailable" : "dht"),
		pairing: link.pairing?.status ?? null,
		stage: link.pairingProgress?.stage ?? null,
		verified: !!link.peerVerified,
		invite: link.pairing?.status === "ready" || !link.inviteCode ? null : showSecret === true ? link.inviteCode : "<hidden>",
		compatibility: !link.profile,
		peerPicture: !!link.peerAvatar
	};
}
/** A chat's details: the summary plus what its connection panel shows. */
function chatDetailsJson(link, showSecret) {
	return {
		...chatJson(link, showSecret),
		progress: link.pairingProgress ?? null,
		transports: {
			mine: link.availableTransports ?? [],
			peer: link.peerTransports ?? [],
			preferred: link.preferredTransport ?? null,
			fallback: link.transportFallback ?? null,
			automatic: link.transportAutomatic ?? null,
			relayed: link.relayedTransports ?? []
		},
		wait: link.transportWait ?? null,
		lastAttempt: link.liveAttempt ?? null,
		liveSince: link.transportLive?.since ?? null,
		rttMs: link.transportRttMs ?? null,
		relays: link.transportRelayed?.relays ?? null,
		deliveryMode: link.deliveryMode ?? null,
		capabilities: link.capabilities ?? null,
		hold: link.hold ?? null,
		peerOnline: link.peerOnline,
		peerLastSeenAt: link.peerLastSeenAt || null,
		history: link.transportHistory ?? null,
		errors: link.transportErrors ?? null,
		comparisonCode: link.pairing?.code ?? null
	};
}
function messageJson(message) {
	return {
		id: message.id,
		chat: message.linkId,
		from: message.event ? "system" : message.sender,
		text: message.text,
		timestamp: message.timestamp,
		...message.sentAt !== void 0 ? { sentAt: message.sentAt } : {},
		delivery: message.delivery ?? (message.sender === "peer" ? null : "sent"),
		deliveryError: message.deliveryError ?? null,
		via: message.via,
		nick: message.nick ?? null,
		...message.member ? { member: message.member } : {},
		...message.mentions?.length ? { mentions: message.mentions.map((m) => ({
			key: m.k,
			offset: m.o,
			length: m.l
		})) } : {},
		...message.mentioned ? { mentioned: true } : {},
		...message.file ? { file: fileJson(message.file) } : {},
		...message.paymentId ? { paymentId: message.paymentId } : {},
		...message.event ? { event: message.event } : {},
		...message.replyTo ? { replyTo: {
			id: message.replyTo.messageId ?? message.replyTo.id,
			snippet: message.replyTo.snippet,
			from: message.replyTo.from ?? null,
			...message.replyTo.member ? { member: message.replyTo.member } : {},
			found: !!message.replyTo.messageId,
			...message.replyTo.button ? { button: message.replyTo.button } : {}
		} } : {},
		...reactionsJson(message).length ? { reactions: reactionsJson(message) } : {},
		...message.edit ? {
			edits: message.edit.seq,
			editedAt: message.edit.at,
			...message.edit.pending ? { editPending: true } : {}
		} : {},
		...message.forwarded ? { forwarded: message.forwarded } : {},
		...message.card ? { card: message.card } : {},
		...message.press ? { press: {
			messageId: message.press.messageId,
			button: message.press.button,
			label: message.press.label,
			...message.press.inferred ? { inferred: true } : {}
		} } : {}
	};
}
/**
* A message's file; a voice note's length (ms) and loudness bars ride along (older releases said only `voice: true`),
* and a picture's size as it is shown when its sender sent it.
*/
function fileJson(file) {
	return {
		id: file.id,
		name: file.name,
		size: file.size,
		mime: file.mime,
		...file.voice ? { voice: {
			duration: file.voice.duration,
			...file.voice.peaks?.length ? { peaks: [...file.voice.peaks] } : {}
		} } : {},
		...file.image ? { image: {
			width: file.image.width,
			height: file.image.height
		} } : {}
	};
}
/** A message's reactions shown now (taken-back ones left out), oldest first. */
function reactionsJson(message) {
	return Object.entries(message.reactions ?? {}).filter(([, r]) => r.e).sort(([, a], [, b]) => a.at - b.at).map(([by, r]) => ({
		by,
		emoji: r.e,
		at: r.at
	}));
}
/**
* A 1:1 chat's message with its author named: the engine keeps a contact's message without a name (the name rides on
* the chat), so the name the contact gave fills `nick`, as a group's roster does. Mine keep null. Before, `nick` was
* always null in a 1:1 chat, and so was an agent turn's `untrusted.name`.
*/
function chatMessageJson(message, link) {
	const json = messageJson(message);
	if (json.nick || message.sender !== "peer") return json;
	const nick = link?.peerNick?.trim();
	return nick ? {
		...json,
		nick
	} : json;
}
/**
* A group's message with its author named: mesh and community messages are kept with the member's key only (the
* name rides on the edge or the roster), so the roster fills `nick` when the message has none, and for an author no
* longer in it (removed, or back with a new member key) the name the group knew them by.
*/
function groupMessageJson(message, group) {
	const json = messageJson(message);
	if (json.nick || !message.member) return json;
	const nick = group?.members.find((m) => m.key === message.member)?.nick ?? group?.formerNames?.[message.member];
	return nick ? {
		...json,
		nick
	} : json;
}
/**
* A group as the CLI prints it. The entry link lets anyone who reads it join, so it is `<hidden>` unless asked for
* (`--show-secret`, or `group link`); null when the group has none.
*/
function groupJson(group, showSecret = false) {
	return {
		id: group.id,
		name: group.name,
		profile: group.profile,
		status: group.status ?? (group.invitation ? "invited" : null),
		statusReason: group.statusReason ?? null,
		admin: group.isAdmin,
		me: group.myKey ?? null,
		canSend: group.canSend,
		link: group.entryLink ? showSecret ? group.entryLink : "<hidden>" : null,
		lastMessageAt: group.lastMessageAt,
		members: group.members.map((m) => ({
			key: m.key,
			name: m.nick ?? null,
			role: m.role,
			me: m.me,
			online: m.online,
			...m.hub ? { hub: true } : {},
			...m.viaHub ? { viaHub: true } : {},
			...m.hubRole ? { hubRole: m.hubRole } : {}
		})),
		...group.hubs ? { hubs: group.hubs } : {},
		invitation: group.invitation ? {
			chat: group.invitation.linkId,
			accepted: group.invitation.accepted,
			viaLink: !!group.invitation.viaLink,
			stage: group.invitation.stage ?? null
		} : null,
		community: group.community ?? null,
		picture: !!group.picture
	};
}
//#endregion
//#region src/groupAdmin.ts
/**
* Group administration and pictures (WISP 1100, phase 3): what the app's group menu and profile screen do. The
* engine enforces who may do what (the admin); these check the arguments and name members.
*/
/**
* A member by key, unique key prefix or name; never this profile itself. A whole key is that member, whatever another
* member calls itself; a prefix and a name stand side by side (two members is an error, not a guess).
*/
function findMember(group, ref) {
	const lower = ref.toLowerCase();
	const others = group.members.filter((m) => !m.me);
	const byKey = others.filter((m) => m.key === ref);
	const matches = byKey.length ? byKey : others.filter((m) => m.key.startsWith(ref) || m.nick?.trim().toLowerCase() === lower);
	if (matches.length === 1) return matches[0];
	throw new CliError(matches.length ? "bad_request" : "not_found", matches.length ? `${JSON.stringify(ref)} names more than one member` : `No member ${JSON.stringify(ref)} in ${group.name}`);
}
/**
* A picture as Ghostly sends it: a square JPEG data URL, checked as a contact would check it. The app scales and
* crops any image to 128×128; here the file must already be a JPEG within the bounds (no image library on Node).
*/
async function pictureFrom(path) {
	let bytes;
	try {
		bytes = await readFile(resolve(path));
	} catch {
		throw new CliError("not_found", `No file ${path}`);
	}
	const url = `data:image/jpeg;base64,${bytes.toString("base64")}`;
	const checked = sanitizeAvatar(url);
	if (!checked) throw new CliError("bad_request", `A picture is a JPEG of at most 512×512 px and about ${Math.floor(MAX_AVATAR_LENGTH * .74 / 1e3)} KB (128×128 is what the app sends): resize it first`);
	return checked;
}
async function picture(params) {
	if (bool(params, "clear")) return null;
	return pictureFrom(str(params, "path", true));
}
var view = (ctx, id, params) => groupJson(state(ctx).groups.find((g) => g.id === id) ?? groupOf(ctx, { group: id }), bool(params, "showSecret"));
var GROUP_ADMIN_METHODS = {
	async "group.invite"(ctx, params) {
		const group = groupOf(ctx, params);
		const link = chatOf(ctx, params);
		await node(ctx).inviteToGroup({
			groupId: group.id,
			linkId: link.id
		});
		return view(ctx, group.id, params);
	},
	async "group.remove"(ctx, params) {
		const group = groupOf(ctx, params);
		await node(ctx).removeGroupMember({
			groupId: group.id,
			key: findMember(group, str(params, "member", true)).key
		});
		return view(ctx, group.id, params);
	},
	async "group.admin"(ctx, params) {
		const group = groupOf(ctx, params);
		await node(ctx).makeGroupAdmin({
			groupId: group.id,
			key: findMember(group, str(params, "member", true)).key
		});
		return view(ctx, group.id, params);
	},
	async "group.hub"(ctx, params) {
		const group = groupOf(ctx, params);
		const role = str(params, "role") ?? "auto";
		if (![
			"pin",
			"exclude",
			"auto"
		].includes(role)) throw new CliError("bad_request", "role is pin, exclude or auto");
		await node(ctx).setGroupHub({
			groupId: group.id,
			key: findMember(group, str(params, "member", true)).key,
			role: role === "auto" ? null : role
		});
		return view(ctx, group.id, params);
	},
	async "group.rename"(ctx, params) {
		const group = groupOf(ctx, params);
		const name = groupName(str(params, "name", true));
		if (!name) throw new CliError("bad_request", `A group's name is 1 to 64 characters on one line`);
		await node(ctx).renameGroup({
			groupId: group.id,
			name
		});
		return view(ctx, group.id, params);
	},
	async "group.rotate"(ctx, params) {
		const group = groupOf(ctx, params);
		await node(ctx).rotateGroup({ groupId: group.id });
		return view(ctx, group.id, params);
	},
	async "group.link"(ctx, params) {
		const group = groupOf(ctx, params);
		if (params.on === false) {
			await node(ctx).disableGroupLink({ groupId: group.id });
			return {
				group: group.id,
				link: null
			};
		}
		const { link } = await node(ctx).enableGroupLink({
			groupId: group.id,
			...bool(params, "reset") ? { reset: true } : {}
		});
		return {
			group: group.id,
			link
		};
	},
	async "group.picture"(ctx, params) {
		const group = groupOf(ctx, params);
		await node(ctx).setGroupPicture({
			groupId: group.id,
			picture: await picture(params)
		});
		return {
			group: group.id,
			picture: !bool(params, "clear")
		};
	},
	async "profile.picture"(ctx, params) {
		const avatar = await picture(params);
		await node(ctx).updateSettings({ settings: { avatar: avatar ?? "" } });
		return { picture: avatar !== null };
	}
};
//#endregion
//#region src/identities.ts
/** Drafts per daemon: a proof made in two steps needs the same process for both. */
var drafts = /* @__PURE__ */ new Map();
var DRAFT_TTL_MS = 36e5;
function provider(id) {
	const found = IDENTITY_PROVIDERS.find((p) => p.id === id);
	if (!found) throw new CliError("not_found", `No identity provider ${id} (ghostly identity providers)`);
	return found;
}
/**
* A signer that runs in this process: not a browser sign-in, and not one that says it cannot run here (a NIP-07
* extension, an AT Protocol sign-in window: neither exists outside the app's page).
*/
function headless(s) {
	if (s.kind === "redirect") return false;
	try {
		return s.available?.() ?? true;
	} catch {
		return false;
	}
}
function signerOf(p, id) {
	const usable = p.signers.filter(headless);
	const found = id ? p.signers.find((s) => s.id === id) : usable[0];
	if (!found) throw new CliError(id ? "not_found" : "unavailable", id ? `${p.label} has no signer ${id}` : `${p.label} proofs need a browser window: make them in the app`);
	if (!headless(found)) {
		const instead = usable.length ? ` (here: --signer ${usable.map((s) => s.id).join(" or ")})` : "";
		throw new CliError("unavailable", `${found.label} needs a browser window: make this proof in the app${instead}`);
	}
	return found;
}
function instructionsJson(i) {
	return {
		steps: i.steps.map((s) => ({
			text: s.text,
			...s.copy ? { copy: s.copy } : {}
		})),
		...i.paste ? { paste: i.paste.label } : {}
	};
}
function proofJson(p) {
	return {
		id: p.id,
		provider: p.provider,
		subject: p.subject,
		verified: p.verified,
		issuedAt: p.issuedAt,
		expiresAt: p.expiresAt,
		sharedWith: p.sharedWith,
		...p.publicUri ? { publicUri: p.publicUri } : {}
	};
}
function pruneDrafts(now = Date.now()) {
	for (const [id, draft] of drafts) if (now - draft.createdAt > DRAFT_TTL_MS) drafts.delete(id);
}
async function begin(ctx, p, subject, params) {
	let normalized;
	try {
		normalized = p.subject?.normalize ? p.subject.normalize(subject) : subject;
	} catch (error) {
		throw new CliError("bad_request", error instanceof Error ? error.message : String(error));
	}
	if (!normalized) throw new CliError("bad_request", `Not a ${p.subject?.label ?? "subject"} ${p.label} takes`);
	const days = params.days === void 0 ? void 0 : num(params, "days", 0, {
		min: 1,
		max: p.validity.maxDays
	});
	return node(ctx).beginIdentityProof({
		provider: p.id,
		subject: normalized,
		...days ? { validityDays: days } : {}
	});
}
var IDENTITY_METHODS = {
	async "identity.providers"() {
		return { providers: IDENTITY_PROVIDERS.map((p) => ({
			id: p.id,
			label: p.label,
			category: p.category,
			subject: p.subject ? {
				label: p.subject.label,
				placeholder: p.subject.placeholder ?? null
			} : null,
			signers: p.signers.map((s) => ({
				id: s.id,
				kind: s.kind,
				label: s.label,
				headless: headless(s),
				...s.kind === "in-app" && s.fields ? { fields: s.fields.map((f) => ({
					name: f.name,
					label: f.label,
					kind: f.kind,
					optional: !!f.optional
				})) } : {}
			}))
		})) };
	},
	async "identity.list"(ctx) {
		return { proofs: state(ctx).identityProofs.map(proofJson) };
	},
	/** Starts a proof. In-app signers finish it here; the others return the statement and what to do with it. */
	async "identity.add"(ctx, params) {
		pruneDrafts();
		const p = provider(str(params, "provider", true));
		const signer = signerOf(p, str(params, "signer"));
		if (signer.kind === "in-app") {
			const values = params.fields ?? {};
			if (typeof values !== "object" || Array.isArray(values) || Object.values(values).some((v) => typeof v !== "string")) throw new CliError("bad_request", "fields must be an object of strings");
			for (const field of signer.fields ?? []) if (!field.optional && !values[field.name]) throw new CliError("bad_request", `${signer.label} needs ${field.name} (${field.label})`);
			const signal = AbortSignal.timeout(num(params, "timeout", 300, {
				min: 5,
				max: 3600
			}) * 1e3);
			return {
				done: true,
				proof: proofJson(await signer.run({
					values,
					signal,
					onAuthUrl: (url) => {
						ctx.hub.emit("identity.approval", `identity.approval:${Date.now()}`, {
							provider: p.id,
							url
						});
					},
					onProgress: (message) => {
						ctx.hub.emit("identity.progress", `identity.progress:${Date.now()}`, {
							provider: p.id,
							message
						});
					},
					onApproval: (request) => {
						if (request) ctx.hub.emit("identity.approval", `identity.approval:${Date.now()}`, {
							provider: p.id,
							...request.qr ? {
								qr: request.qr.value,
								label: request.qr.label
							} : {},
							notes: request.notes ?? []
						});
					}
				}, async (session) => {
					const { draftId, binding } = await begin(ctx, p, await session.subject(), params);
					try {
						return await node(ctx).completeIdentityProof({
							draftId,
							evidence: await session.sign(identityStatement(binding))
						});
					} catch (error) {
						try {
							await node(ctx).cancelIdentityProof({ draftId });
						} catch {}
						throw error;
					}
				}))
			};
		}
		if (signer.kind === "redirect") throw new CliError("unavailable", `${signer.label} needs a browser window: make this proof in the app`);
		const { draftId, binding } = await begin(ctx, p, str(params, "subject", true), params);
		const statement = identityStatement(binding);
		drafts.set(draftId, {
			draftId,
			provider: p.id,
			signer: signer.id,
			binding,
			createdAt: Date.now()
		});
		return {
			done: false,
			draft: draftId,
			provider: p.id,
			signer: signer.id,
			statement: statement.text,
			instructions: instructionsJson(signer.instructions(statement)),
			expiresInSeconds: DRAFT_TTL_MS / 1e3
		};
	},
	/** Finishes a two-step proof: what the tool printed (external-tool), or nothing (publish: the engine looks it up). */
	async "identity.complete"(ctx, params) {
		const draft = drafts.get(str(params, "draft", true));
		if (!draft) throw new CliError("not_found", "No such draft here: it is kept by the daemon that made it, for an hour");
		const signer = signerOf(provider(draft.provider), draft.signer);
		const statement = identityStatement(draft.binding);
		let evidence;
		try {
			if (signer.kind === "external-tool") evidence = await signer.parse(str(params, "evidence", true), statement);
			else if (signer.kind === "publish") evidence = await signer.evidence(statement);
			else throw new CliError("bad_request", "This draft needs no completion");
		} catch (error) {
			if (error instanceof CliError) throw error;
			throw new CliError("bad_request", error instanceof Error ? error.message : String(error));
		}
		const proof = await node(ctx).completeIdentityProof({
			draftId: draft.draftId,
			evidence
		});
		drafts.delete(draft.draftId);
		return {
			done: true,
			proof: proofJson(proof)
		};
	},
	async "identity.cancel"(ctx, params) {
		const draftId = str(params, "draft", true);
		if (!drafts.delete(draftId)) throw new CliError("not_found", "No such draft here: it is kept by the daemon that made it, for an hour");
		await node(ctx).cancelIdentityProof({ draftId });
		return { cancelled: draftId };
	},
	async "identity.remove"(ctx, params) {
		const id = str(params, "id", true);
		if (!state(ctx).identityProofs.some((p) => p.id === id)) throw new CliError("not_found", `No identity proof ${JSON.stringify(id)} (ghostly identity list)`);
		await node(ctx).removeIdentityProof({ id });
		return { removed: id };
	},
	async "identity.share"(ctx, params) {
		const link = chatOf(ctx, params);
		const id = str(params, "id", true);
		if (!state(ctx).identityProofs.some((p) => p.id === id)) throw new CliError("not_found", `No identity proof ${JSON.stringify(id)} (ghostly identity list)`);
		await node(ctx).shareIdentityProof({
			linkId: link.id,
			id
		});
		return {
			chat: link.id,
			shared: id
		};
	},
	async "identity.withdraw"(ctx, params) {
		const link = chatOf(ctx, params);
		const id = str(params, "id", true);
		if (!link.identities?.shared.some((s) => s.id === id)) throw new CliError("not_found", `No identity proof ${JSON.stringify(id)} shared in this chat (ghostly identity contact ${link.id})`);
		await node(ctx).withdrawIdentityProof({
			linkId: link.id,
			id
		});
		return {
			chat: link.id,
			withdrawn: id
		};
	},
	/** What a contact shared in a chat, as this device checked it, and what this side shares there. */
	async "identity.contact"(ctx, params) {
		const link = chatOf(ctx, params);
		const view = link.identities;
		return {
			chat: link.id,
			support: view?.support ?? false,
			received: (view?.received ?? []).map((r) => ({
				id: r.id,
				provider: r.provider,
				subject: r.subject,
				status: r.status,
				verified: r.verified,
				verifiedAt: r.verifiedAt,
				checkedAt: r.checkedAt,
				expiresAt: r.expiresAt,
				error: r.error ?? null,
				recheckDue: r.recheckDue,
				...r.publicProfile ? { publicProfile: r.publicProfile } : {}
			})),
			shared: view?.shared ?? []
		};
	},
	async "identity.recheck"(ctx, params) {
		const link = chatOf(ctx, params);
		const id = str(params, "id", true);
		if (!link.identities?.received.some((r) => r.id === id)) throw new CliError("not_found", `No identity proof ${JSON.stringify(id)} from this contact (ghostly identity contact ${link.id})`);
		await node(ctx).recheckIdentityProof({
			linkId: link.id,
			id
		});
		return IDENTITY_METHODS["identity.contact"](ctx, { chat: link.id });
	}
};
//#endregion
//#region src/x401.ts
/**
* x401 credentials (WISP 3xx): the holder keys and issued credentials a bot keeps to show a website who stands behind
* it. Here only keeping them: `x401 fetch`, which presents one, comes later. Claim values are printed only with
* `--show-secret`; the credential itself and the holder keys never leave the profile.
*/
/** The engine's refusals (a credential that does not read, expired, bound to another key) are the caller's to fix. */
async function engine$1(work) {
	try {
		return await work();
	} catch (error) {
		throw new CliError("bad_request", error instanceof Error ? error.message : String(error));
	}
}
var X401_METHODS = {
	/** `dropped`: the oldest key still waiting, gone for this one (a profile keeps the 8 newest waiting). */
	async "x401.key.new"(ctx) {
		const { id, jwk, dropped } = await node(ctx).newX401HolderKey();
		return {
			key: id,
			jwk,
			...dropped ? { dropped } : {}
		};
	},
	async "x401.credential.add"(ctx, params) {
		const label = str(params, "label");
		return { credential: await engine$1(() => node(ctx).addX401Credential({
			credential: str(params, "credential", true),
			...label ? { label } : {}
		})) };
	},
	async "x401.credential.list"(ctx, params) {
		return { credentials: await node(ctx).x401Credentials({ values: bool(params, "showSecret") }) };
	},
	async "x401.credential.remove"(ctx, params) {
		const id = str(params, "id", true);
		if (!await node(ctx).removeX401Credential({ id })) throw new CliError("not_found", `No x401 credential ${JSON.stringify(id)} (ghostly x401 credential list)`);
		return { removed: id };
	}
};
//#endregion
//#region src/services.ts
/**
* Shared services (WISP 700/701, WISP 1100 phase 3b): a web app on this machine a contact may open over the chat's live
* link, and a contact's app opened here on a loopback port. As on the Desktop: only loopback is reached, redirects are
* handed back rather than followed, and a service is shared with each contact by name, never by default.
*/
var LOOPBACK = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]",
	"::1"
]);
/** The engine's way to reach a shared app: loopback only, no redirect followed, no cookies (Node sends none). */
var nodeLocalFetch = async (request) => {
	const url = new URL(request.url);
	if (!["http:", "https:"].includes(url.protocol) || !(LOOPBACK.has(url.hostname) || /^127\.\d+\.\d+\.\d+$/.test(url.hostname))) throw new Error("Shared services are reached on this machine only");
	const response = await fetch(url, {
		method: request.method,
		headers: request.headers,
		body: request.body,
		signal: request.signal,
		redirect: "manual",
		...request.body ? { duplex: "half" } : {}
	});
	const headers = [];
	response.headers.forEach((value, name) => headers.push([name, value]));
	return {
		status: response.status,
		headers,
		body: response.body ? (async function* () {
			const reader = response.body.getReader();
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) return;
					if (value?.length) yield value;
				}
			} finally {
				reader.cancel().catch(() => {});
			}
		})() : null
	};
};
/** Contact services open on loopback ports, by `<peer>/<service>`, while this process runs. */
var open$1 = /* @__PURE__ */ new Map();
var MAX_RESPONSE_BYTES = 33554432;
/** Cookie names an opened service may set and have passed back (browsers keep about 180 per host). */
var MAX_COOKIE_NAMES = 256;
/**
* The cookie that shows a browser was given this service's link here. It is this machine's, never the contact's:
* it is not passed on to the contact, and a `Set-Cookie` from the contact by that name is dropped.
*/
var OPEN_COOKIE = "ghostly_open";
/** The link `service open` prints: it sets `OPEN_COOKIE` and sends the browser on to `/`. */
var OPEN_PATH = "/.ghostly-open/";
/**
* Only the cookies this service set itself (by name, from its own `Set-Cookie`) go on to the contact; any other a
* browser sends (one set for localhost by another app here, this machine's `OPEN_COOKIE`) stays here.
*/
function ownCookies(header, names) {
	const kept = header.split(";").map((pair) => pair.trim()).filter((pair) => {
		const at = pair.indexOf("=");
		const name = at > 0 ? pair.slice(0, at).trim() : "";
		return !!name && name !== "ghostly_open" && names.has(name);
	});
	return kept.length ? kept.join("; ") : null;
}
/** The cookie a `Set-Cookie` sets, by name. */
function setCookieName(value) {
	const at = value.indexOf("="), end = value.indexOf(";");
	if (at <= 0 || end !== -1 && end < at) return null;
	return value.slice(0, at).trim() || null;
}
/**
* A contact's `Set-Cookie` as this machine passes it to the browser: without `Domain`, so the cookie stays on the
* service's own host name (not every *.localhost). Null for one this machine does not take (`OPEN_COOKIE`, no name).
*/
function hostOnlyCookie(value) {
	const name = setCookieName(value);
	if (!name || name === "ghostly_open") return null;
	return value.split(";").filter((part, i) => i === 0 || !/^\s*domain\s*(=|$)/i.test(part)).join(";");
}
/** A cookie's values in a `Cookie` header, by name (a page may set another by the same name on a narrower path). */
function cookieValues(header, name) {
	return (header ?? "").split(";").flatMap((pair) => {
		const at = pair.indexOf("=");
		return at > 0 && pair.slice(0, at).trim() === name ? [pair.slice(at + 1).trim()] : [];
	});
}
function sameSecret(a, b) {
	return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function plain(response, status, text, headers = {}) {
	response.writeHead(status, {
		"content-type": "text/plain; charset=utf-8",
		"cache-control": "no-store",
		...headers
	});
	response.end(text);
}
/**
* A contact's app on a loopback port of this machine, under a host name of its own (`<random>.localhost`): its
* cookies and storage are its own, apart from any other app on 127.0.0.1 or localhost, and a name that merely
* resolves here (DNS rebinding) is not it. Only a browser given the link (which sets `OPEN_COOKIE`) is served; anyone
* else on this machine who finds the port gets 404. The body streams through, bounded by `MAX_RESPONSE_BYTES`.
*/
async function openServiceServer(send, port = 0) {
	const name = `${randomBytes(16).toString("hex")}.localhost`;
	const token = randomBytes(32).toString("hex");
	const cookies = /* @__PURE__ */ new Set();
	let host = "";
	const server = createServer((request, response) => {
		if (request.headers.host?.toLowerCase() !== host) return plain(response, 404, "Not found");
		const path = request.url ?? "/";
		if (path.startsWith(OPEN_PATH)) {
			if (!sameSecret(path.slice(15), token)) return plain(response, 404, "Not found");
			return plain(response, 303, "", {
				location: "/",
				"referrer-policy": "no-referrer",
				"set-cookie": `${OPEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`
			});
		}
		if (!cookieValues(request.headers.cookie, "ghostly_open").some((value) => sameSecret(value, token))) return plain(response, 404, "Not found");
		const chunks = [];
		let size = 0, refused = false;
		request.on("data", (chunk) => {
			if (refused) return;
			size += chunk.length;
			if (size > LIMITS.maxRequestBodyBytes) {
				refused = true;
				chunks.length = 0;
				plain(response, 413, "The request body is too large", { connection: "close" });
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			if (!refused) proxy(request, response, chunks, send, cookies);
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	host = `${name}:${server.address().port}`;
	return {
		server,
		host,
		url: `http://${host}${OPEN_PATH}${token}`
	};
}
async function proxy(request, response, chunks, send, cookies) {
	const stop = new AbortController();
	response.on("close", () => {
		if (!response.writableFinished) stop.abort();
	});
	try {
		const headers = Object.entries(request.headers).flatMap(([name, value]) => Array.isArray(value) ? value.map((v) => [name, v]) : value === void 0 ? [] : [[name, value]]).flatMap(([name, value]) => {
			if (name.toLowerCase() !== "cookie") return [[name, value]];
			const own = ownCookies(value, cookies);
			return own ? [[name, own]] : [];
		});
		const answer = await send({
			method: request.method ?? "GET",
			path: request.url ?? "/",
			headers,
			body: chunks.length ? new Uint8Array(Buffer.concat(chunks)) : null,
			maxResponseBytes: MAX_RESPONSE_BYTES,
			signal: stop.signal
		});
		const out = {};
		for (const [name, value] of answer.headers) {
			const lower = name.toLowerCase();
			if (lower === "transfer-encoding" || lower === "connection") continue;
			if (lower === "set-cookie") {
				const cookie = hostOnlyCookie(value);
				if (!cookie) continue;
				if (cookies.size < MAX_COOKIE_NAMES) cookies.add(setCookieName(cookie));
				out[lower] = [...out[lower] ?? [], cookie];
			} else out[lower] = value;
		}
		response.writeHead(answer.status, out);
		await pipeline(Readable.from(answer.body, { objectMode: false }), response);
	} catch (error) {
		if (response.headersSent) {
			response.destroy();
			return;
		}
		const gone = error instanceof GhostlyHttpError && [
			"unreachable",
			"timeout",
			"closed",
			"offline"
		].includes(error.code);
		plain(response, gone ? 503 : 502, gone ? "This service is not reachable. Services exist while their ghost is online." : `The request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
/**
* The service a command names, by its id: one of this profile's. The engine changes nothing for an id it does not
* know and says nothing, so a mistyped id read as done ("shared": true, with a contact).
*/
function serviceOf(ctx, params) {
	const serviceId = str(params, "service", true);
	if (!state(ctx).services.some((s) => s.id === serviceId)) throw new CliError("not_found", `No service ${JSON.stringify(serviceId)} (ghostly service list)`);
	return serviceId;
}
var SERVICE_METHODS = {
	async "service.list"(ctx) {
		return { services: state(ctx).services.map((s) => ({
			id: s.id,
			name: s.name,
			target: s.target,
			enabled: s.enabled,
			sharedWith: s.sharedWith ?? [],
			requests: s.requests
		})) };
	},
	async "service.add"(ctx, params) {
		const target = str(params, "target", true);
		let url;
		try {
			url = new URL(target);
		} catch {
			throw new CliError("bad_request", `Not a URL: ${target}`);
		}
		if (!(LOOPBACK.has(url.hostname) || /^127\.\d+\.\d+\.\d+$/.test(url.hostname))) throw new CliError("refused", "Only a web app on this machine (127.0.0.1, localhost) can be shared");
		return node(ctx).addService({
			name: str(params, "name", true),
			target
		});
	},
	async "service.remove"(ctx, params) {
		const serviceId = serviceOf(ctx, params);
		await node(ctx).removeService({ serviceId });
		return { removed: serviceId };
	},
	async "service.enable"(ctx, params) {
		const serviceId = serviceOf(ctx, params);
		await node(ctx).setServiceEnabled({
			serviceId,
			enabled: !bool(params, "off")
		});
		return {
			service: serviceId,
			enabled: !bool(params, "off")
		};
	},
	async "service.share"(ctx, params) {
		const link = chatOf(ctx, params);
		const shared = !bool(params, "off");
		const serviceId = serviceOf(ctx, params);
		await node(ctx).setServiceShared({
			serviceId,
			peerPubKeyZ32: link.peerPubKeyZ32,
			shared
		});
		return {
			service: serviceId,
			chat: link.id,
			shared
		};
	},
	/** What a contact shares with this profile (while its app is live). */
	async "service.peer"(ctx, params) {
		const link = chatOf(ctx, params);
		return {
			chat: link.id,
			live: isLive(link),
			services: link.peerServices ?? []
		};
	},
	/** A contact's shared app on a loopback port of this machine, as the Desktop opens it in a window. */
	async "service.open"(ctx, params) {
		if (ctx.mode !== "daemon") throw new CliError("unavailable", "An opened service lives in the daemon: start `ghostly daemon --detach` first");
		const link = chatOf(ctx, params);
		const service = str(params, "service", true);
		const key = `${link.peerPubKeyZ32}/${service}`;
		const already = open$1.get(key);
		if (already) return {
			chat: link.id,
			service,
			url: already.url
		};
		if (!link.peerServices?.some((s) => s.id === service)) throw new CliError("not_found", `The contact shares no service ${service} (or is not live)`);
		const peer = link.peerPubKeyZ32;
		const opened = await openServiceServer((request) => node(ctx).request(peer, service, request), num(params, "port", 0, {
			min: 0,
			max: 65535
		}));
		open$1.set(key, opened);
		return {
			chat: link.id,
			service,
			url: opened.url
		};
	},
	async "service.close"(ctx, params) {
		const key = `${chatOf(ctx, params).peerPubKeyZ32}/${str(params, "service", true)}`;
		const entry = open$1.get(key);
		if (!entry) throw new CliError("not_found", "That service is not open here");
		open$1.delete(key);
		await new Promise((resolve) => entry.server.close(() => resolve()));
		return { closed: key };
	}
};
//#endregion
//#region src/calls/api.ts
/** Voice calls (WISP 1100 § Calls): the API methods. The audio itself goes over each call's own socket. */
var CALL_METHODS = {
	async "call.start"(ctx, params) {
		return ctx.calls.start(str(params, "chat", true), { rate: params.rate });
	},
	async "call.answer"(ctx, params) {
		return ctx.calls.answer(str(params, "call"), { rate: params.rate });
	},
	async "call.hangup"(ctx, params) {
		return ctx.calls.hangup(str(params, "call"));
	},
	async "call.list"(ctx) {
		return {
			calls: ctx.calls.list(),
			autoAnswer: ctx.calls.getAuto(),
			available: ctx.runtime.callsUnavailable === null,
			...ctx.runtime.callsUnavailable ? { unavailable: ctx.runtime.callsUnavailable } : {}
		};
	},
	async "call.get"(ctx, params) {
		return ctx.calls.get(str(params, "call"));
	},
	async "call.flush"(ctx, params) {
		return ctx.calls.flush(str(params, "call"));
	},
	async "call.auto"(ctx, params) {
		if (params.on === void 0) return { autoAnswer: ctx.calls.getAuto() };
		return { autoAnswer: ctx.calls.setAuto({
			on: bool(params, "on"),
			from: list(params, "from"),
			rate: params.rate
		}) };
	}
};
//#endregion
//#region src/appServe.ts
/** The permissions a bot can be granted: `internet` is a page's, and no page runs here. */
var GRANTABLE = ["chat", "name"];
var servedFile = (dir) => join(dir, "apps.json");
/** The apps a profile serves, by its folder: none when the file is missing or not a list of them. */
function servedApps(dir) {
	try {
		const read = JSON.parse(readFileSync(servedFile(dir), "utf8"));
		return Array.isArray(read) ? read.filter((app) => !!app && typeof app === "object" && isAppRef(app.ref)) : [];
	} catch {
		return [];
	}
}
function writeServed(dir, apps) {
	const file = servedFile(dir);
	writeFileSync(file + ".tmp", JSON.stringify(apps, null, 2) + "\n", { mode: 384 });
	renameSync(file + ".tmp", file);
}
/** A served app by its reference or, when only one has it, its name. */
function servedApp(apps, ref) {
	const matches = apps.filter((a) => a.ref === ref || a.ref.split("/")[1] === ref);
	if (matches.length !== 1) throw new CliError(matches.length ? "bad_request" : "not_found", matches.length ? `${JSON.stringify(ref)} names more than one served app: give its whole reference` : `No served app ${JSON.stringify(ref)}: app serve its bundle first`);
	return matches[0];
}
/** Whether this engine offers apps/1 now: it read the list when it started, so the first app served waits for a restart. */
var offered = (ctx, apps) => ({
	offered: ctx.runtime.apps,
	...apps.length > 0 && !ctx.runtime.apps && { restart: true }
});
var APP_SERVE_METHODS = {
	async "app.serve"(ctx, params) {
		const source = str(params, "bundle", true);
		const grant = list(params, "grant");
		const unknown = grant.filter((p) => !APP_PERMISSIONS.includes(p));
		if (unknown.length) throw new CliError("bad_request", `grant takes ${GRANTABLE.join(" or ")}, not ${unknown.map((p) => JSON.stringify(p)).join(", ")}`);
		if (grant.includes("internet")) throw new CliError("refused", "internet cannot be granted here: no app's page runs on the CLI, and a bot reaches the network as its own program");
		const given = str(params, "url");
		if (given !== void 0 && !isAppUrl(given)) throw new CliError("bad_request", "url is where a contact's app reads the bundle: https only, no user or password, jsDelivr only at a full commit");
		const { bundle, url } = await checkedBundle(source);
		const m = bundle.manifest;
		if (!m.permissions.includes("chat")) throw new CliError("refused", `${m.title} does not ask for chat: it talks to no contact, so a bot has nothing to speak for it`);
		const extra = grant.filter((p) => !m.permissions.includes(p));
		if (extra.length) throw new CliError("bad_request", `${m.title} does not ask for ${extra.join(" or ")}: grant only what its manifest asks (${m.permissions.join(", ")})`);
		const missing = m.permissions.filter((p) => GRANTABLE.includes(p) && !grant.includes(p));
		if (missing.length) throw new CliError("confirm", `${m.title} asks for ${missing.join(" and ")}: serve it with ${missing.map((p) => `--grant ${p}`).join(" ")} to allow that`, {
			asks: m.permissions,
			missing
		});
		const ref = appRef(m.publisher, m.name);
		const cardUrl = given ?? url ?? m.sources?.[0];
		const app = {
			ref,
			title: m.title,
			version: m.version,
			sequence: m.sequence,
			digest: bundle.digest,
			...cardUrl !== void 0 && { url: cardUrl },
			permissions: m.permissions,
			granted: m.permissions.filter((p) => grant.includes(p)),
			servedAt: Date.now()
		};
		const apps = servedApps(ctx.runtime.paths.dir);
		const held = apps.find((a) => a.ref === ref);
		if (held && app.sequence < held.sequence) throw new CliError("refused", `${m.title} ${held.version} (sequence ${held.sequence}) is served: ${m.version} is older (sequence ${app.sequence}); app unserve it first to go back`);
		if (held && app.sequence === held.sequence && app.digest !== held.digest) throw new CliError("refused", `Another ${m.title} with sequence ${app.sequence} is served (two different versions ${app.sequence} exist); app unserve it first to take this one`);
		const next = [...apps.filter((a) => a.ref !== ref), app].sort((a, b) => a.ref < b.ref ? -1 : 1);
		writeServed(ctx.runtime.paths.dir, next);
		return {
			served: app,
			...offered(ctx, next)
		};
	},
	async "app.served"(ctx) {
		const apps = servedApps(ctx.runtime.paths.dir);
		return {
			apps,
			...offered(ctx, apps)
		};
	},
	async "app.unserve"(ctx, params) {
		const ref = str(params, "ref", true);
		const apps = servedApps(ctx.runtime.paths.dir);
		const app = servedApp(apps, ref);
		const next = apps.filter((a) => a !== app);
		writeServed(ctx.runtime.paths.dir, next);
		return {
			unserved: app.ref,
			apps: next.length,
			...offered(ctx, next)
		};
	}
};
//#endregion
//#region src/appEvents.ts
/** Per hub: what the contacts have open now, `<chat> <reference>` to the version they said. */
var peers = /* @__PURE__ */ new WeakMap();
/** The version of a served app the contact has open in a chat on this session, or undefined. */
function peerVersion(hub, chat, ref) {
	return peers.get(hub)?.get(`${chat} ${ref}`);
}
function reportAppFrames(hub, node, profileDir) {
	const open = /* @__PURE__ */ new Map();
	peers.set(hub, open);
	/** Per chat: chat app id to reference, of the apps served when the contact last opened one there. */
	const known = /* @__PURE__ */ new Map();
	let count = 0;
	const learn = (chat) => {
		const ids = /* @__PURE__ */ new Map();
		for (const { ref } of servedApps(profileDir)) try {
			ids.set(node.appId({
				linkId: chat,
				ref
			}).app, ref);
		} catch {}
		known.set(chat, ids);
		return ids;
	};
	return hub.onAppFrame((chat, frame) => {
		const app = ("o" in frame && frame.o === "open" ? learn(chat) : known.get(chat) ?? learn(chat)).get(frame.app);
		if (!app) return;
		const id = `${chat}:${app}:${Date.now()}-${++count}`;
		if ("o" in frame) {
			if (frame.o === "open") open.set(`${chat} ${app}`, frame.v);
			else open.delete(`${chat} ${app}`);
		}
		if (!("o" in frame)) hub.emit("app.message", `app.message:${id}`, {
			chat,
			app,
			data: frame.d
		});
		else if (frame.o === "open") hub.emit("app.opened", `app.opened:${id}`, {
			chat,
			app,
			version: frame.v
		});
		else hub.emit("app.closed", `app.closed:${id}`, {
			chat,
			app,
			...frame.offline && { offline: true }
		});
	});
}
//#endregion
//#region src/appChat.ts
/** The chat and the served app a command names, on an engine that speaks apps/1. */
function target(ctx, params) {
	const app = servedApp(servedApps(ctx.runtime.paths.dir), str(params, "ref", true));
	if (ctx.mode !== "daemon") throw new CliError("unavailable", "An app is open only while a daemon runs: start one (ghostly daemon start) and open it there");
	if (!ctx.runtime.apps) throw new CliError("unavailable", "This daemon started before an app was served, so it offers no apps/1 yet: ghostly daemon restart");
	const link = chatOf(ctx, params);
	return {
		chat: link.id,
		live: isLive(link),
		app
	};
}
/** The engine's own words for a call it refused (a chat not paired yet, a group), as `refused`. */
async function engine(run) {
	try {
		return await run();
	} catch (error) {
		throw new CliError("refused", error instanceof Error ? error.message : String(error));
	}
}
var APP_CHAT_METHODS = {
	async "app.open"(ctx, params) {
		const { chat, live, app } = target(ctx, params);
		const peer = peerVersion(ctx.hub, chat, app.ref) ?? null;
		await engine(() => node(ctx).appOpen({
			linkId: chat,
			ref: app.ref,
			version: app.version
		}));
		let card = null;
		if (!bool(params, "noCard") && peer === null) {
			const sent = {
				kind: "app",
				id: appCardId(app.ref),
				ref: app.ref,
				digest: app.digest,
				sequence: app.sequence,
				title: app.title,
				version: app.version,
				...app.url !== void 0 && { url: app.url },
				opened: true
			};
			const result = await node(ctx).sendMessage({
				linkId: chat,
				text: "",
				card: sent
			});
			if (result.error || !result.messageId) {
				await engine(() => node(ctx).appClose({
					linkId: chat,
					ref: app.ref
				}));
				throw new CliError(result.refused ? "refused" : "unavailable", result.error ?? "The app's card could not be sent");
			}
			card = result.messageId;
		}
		return {
			chat,
			app: app.ref,
			version: app.version,
			card,
			peer,
			live
		};
	},
	async "app.close"(ctx, params) {
		const { chat, app } = target(ctx, params);
		await engine(() => node(ctx).appClose({
			linkId: chat,
			ref: app.ref
		}));
		return {
			chat,
			app: app.ref,
			closed: true
		};
	},
	async "app.send"(ctx, params) {
		const { chat, app } = target(ctx, params);
		if (!("data" in params) || params.data === void 0) throw new CliError("bad_request", "data is required: the app's message, any JSON value");
		const { error } = await engine(() => node(ctx).appSend({
			linkId: chat,
			ref: app.ref,
			data: params.data
		}));
		if (error) throw new CliError(NOT_SENT[error].code, NOT_SENT[error].message, { reason: error });
		return {
			chat,
			app: app.ref,
			sent: true
		};
	}
};
/** Why a frame did not go (WISP 1200 § In a chat), in `details.reason`. Nothing is kept to send later. */
var NOT_SENT = {
	"not-open": {
		code: "refused",
		message: "The app is not open in this chat on this side: app open it first"
	},
	"too-large": {
		code: "bad_request",
		message: `The message is over ${APP_DATA_MAX_BYTES} bytes of JSON, the most an app's frame carries`
	},
	offline: {
		code: "unavailable",
		message: "The chat is not live: an app's frames go on the live session only, and none is kept for later"
	},
	"peer-closed": {
		code: "unavailable",
		message: "The contact's app is not open in this chat (or their Ghostly runs no apps): wait for app.opened"
	},
	"too-fast": {
		code: "refused",
		message: `More than 48 frames in a second, or the connection is still sending earlier ones: slow down and send it again`
	}
};
//#endregion
//#region src/wallets.ts
/**
* Wallets and payments (WISP 1100, phase 2): the app's wallet deck and a chat's payment sheet, as methods. Test
* networks move nothing real. On Mainnet every spend passes `confirmedReal`, which the engine requires, only when the
* call says `confirmReal: true` (the CLI's `--confirm-real`): no flag, no spend.
*/
var NETWORKS = ["mainnet", "testnet"];
var TYPES = [
	"cashu",
	"lightning",
	"arkade",
	"bark",
	"spark",
	"bitcoin",
	"fedimint",
	"usdt"
];
var METHODS$1 = [
	"cashu",
	"arkade",
	"usdt",
	"bark",
	"bitcoin",
	"fedimint",
	"spark"
];
var CHAT_METHODS = [
	"cashu",
	"lightning",
	...METHODS$1.filter((m) => m !== "cashu")
];
/**
* What the app has and a headless Ghostly cannot run yet, and why (WISP 1100 § Wallet SDKs on Node). New offers
* them as unavailable; creating one is refused before the engine is asked.
*/
var NODE_GAPS = { bark: "Bark's SDK ships a browser build only: its WebAssembly needs a browser window. Use it from the app." };
/** Sources the engine lists that live in a browser page (`window.webln`): a headless Ghostly never offers them. */
var BROWSER_SOURCES = /* @__PURE__ */ new Set(["webln"]);
/** The sources of an offer a headless Ghostly can connect. */
var nodeSources = (offer) => offer?.providers?.filter((p) => !BROWSER_SOURCES.has(p.id));
/**
* What `wallet create` was given checked against the offer's own form, before the engine is asked: a source, a field
* or a flag left out, or one the wallet does not take, is the person's value, said naming the flag. Before, the engine
* refused it in the app's words ("Enter connection uri", "Nothing was saved; try again") as `engine`, or the flag was
* dropped without a word.
*/
function createChecked(type, n, offer, provider, values, params) {
	if (type !== "lightning" && type !== "bitcoin") {
		if (provider || Object.keys(values).length) throw new CliError("usage", `--provider and --value name a lightning or bitcoin source: not with ${type}`);
		if (offer?.needs === "invite" && !str(params, "invite")?.trim()) throw new CliError("bad_request", `${type} needs --invite <fed11…>`);
		if (offer?.needs === "apiKey" && !str(params, "apiKey")?.trim()) throw new CliError("bad_request", `${type} on ${n} needs --api-key <key> (or api-key=… on --stdin)`);
		return;
	}
	const sources = nodeSources(offer);
	if (!sources?.length) return;
	if (!provider) throw new CliError("bad_request", `${type} needs --provider: one of ${sources.map((p) => p.id).join(", ")} (ghostly wallet list)`);
	const source = sources.find((p) => p.id === provider);
	if (!source) throw new CliError("bad_request", `No ${type} source ${JSON.stringify(provider)} on ${n} (ghostly wallet list)`);
	const unknown = Object.keys(values).find((name) => !source.fields.some((f) => f.name === name));
	if (unknown) throw new CliError("bad_request", `${provider} takes no --value ${unknown}: ${source.fields.length ? `its fields are ${source.fields.map((f) => f.name).join(", ")}` : "it has no fields"}`);
	const missing = source.fields.find((f) => !f.optional && !f.defaults?.[n] && !values[f.name]?.trim());
	if (missing) throw new CliError("bad_request", `${provider} needs --value ${missing.name}=<${missing.options?.map((o) => o.value).join("|") ?? missing.placeholder ?? missing.label.toLowerCase()}>`);
}
var network = (params, fallback = "testnet") => oneOf(params, "network", NETWORKS, fallback);
/** `confirmedReal` for the engine: only when the caller confirmed real money, and only then. */
var real = (params) => bool(params, "confirmReal") ? { confirmedReal: true } : {};
function netView(s, n) {
	return s.wallet.networks?.[n];
}
/** A Lightning card named by `card` on the network asked: one that is not there is not_found, before the engine is asked. */
function lightningCard(ctx, params) {
	const n = network(params), card = str(params, "card", true);
	if (!netView(state(ctx), n)?.lightnings?.some((c) => c.card === card)) throw new CliError("not_found", `No Lightning card ${JSON.stringify(card)} on ${n} (ghostly wallet list)`);
}
/**
* The Lightning card `card` names, checked before the engine is asked: given with another type of wallet it is a usage
* error, and one not on the network is not_found. Before, the engine dropped it for every type but Lightning, so a card
* that named nothing removed the whole wallet of that type and the answer echoed the card as removed.
*/
function cardOf(ctx, params, type) {
	const card = str(params, "card");
	if (card === void 0) return void 0;
	if (type !== "lightning") throw new CliError("usage", `--card names a Lightning card: not with ${type}`);
	lightningCard(ctx, params);
	return card;
}
/**
* The engine opens the federations joined before in the background as it starts. A daemon has long done so when a call
* comes; a one-shot command waits for them (at most 30 s) before its balances are read or money moves through one.
*/
async function federationsOpen(ctx, ms = 3e4) {
	if (ctx.mode !== "one-shot") return;
	const until = Date.now() + ms;
	const connecting = () => NETWORKS.some((n) => (netView(state(ctx), n)?.fedimint?.federations ?? []).some((f) => f.status === "connecting"));
	while (connecting() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 250));
}
/** One wallet of the deck with its balance, in its own unit. Never a key, a phrase or a token. */
function walletJson(instance, s) {
	const view = netView(s, instance.network);
	let balance = null, unit = "sat", address = null, status = null, error = null;
	switch (instance.type) {
		case "cashu":
			balance = view?.balance ?? null;
			break;
		case "lightning": {
			const card = view?.lightnings?.find((c) => c.card === instance.card);
			balance = card?.balance ?? null;
			status = card?.status ?? null;
			error = card?.error ?? null;
			break;
		}
		case "arkade":
			balance = view?.ark?.balance ?? null;
			address = view?.ark?.address ?? null;
			error = view?.ark?.error ?? null;
			break;
		case "bark":
			balance = view?.bark?.balance ?? null;
			error = view?.bark?.error ?? null;
			break;
		case "spark":
			balance = view?.spark?.balance ?? null;
			address = view?.spark?.address ?? null;
			error = view?.spark?.error ?? null;
			break;
		case "bitcoin":
			balance = view?.bitcoin?.balance ?? null;
			address = view?.bitcoin?.address ?? null;
			status = view?.bitcoin?.status ?? null;
			error = view?.bitcoin?.error ?? null;
			break;
		case "fedimint":
			balance = view?.fedimint?.balance ?? null;
			error = view?.fedimint?.error ?? null;
			break;
		case "usdt":
			balance = view?.usdt?.balance ?? null;
			unit = "token-base";
			address = view?.usdt?.address ?? null;
			error = view?.usdt?.error ?? null;
	}
	return {
		id: instance.id,
		type: instance.type,
		network: instance.network,
		...instance.card ? {
			card: instance.card,
			name: instance.name ?? null,
			receive: !!instance.receive
		} : {},
		balance,
		unit,
		address,
		status,
		error,
		config: instance.config
	};
}
function paymentJson(p) {
	return {
		id: p.id,
		chat: p.linkId,
		kind: p.kind,
		direction: p.direction,
		amount: p.amount,
		unit: p.unit,
		memo: p.memo ?? null,
		state: p.state,
		error: p.error ?? null,
		network: paymentNetwork(p),
		method: p.target?.method ?? (p.invoice ? "lightning" : p.mint || p.mints ? "cashu" : null),
		createdAt: p.createdAt,
		...p.group ? { group: p.group } : {},
		...p.closed ? { closed: true } : {},
		...p.txid ? { txid: p.txid } : {}
	};
}
var isInvoice = (text) => /^(lightning:)?ln(bc|tb|tbs|sb|bcrt)[0-9a-z]+$/i.test(text.trim());
var isLnurl = (text) => /^(lightning:)?lnurl[0-9a-z]+$/i.test(text.trim()) || /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(text.trim());
/**
* The engine refusing the mint URL the person typed (not a URL, or not https): their value, so `bad_request`, as
* `service add` says; before, it was `engine` (exit 1), which a bot reads as the engine failing and may retry. Read by
* its shape: the engine's `EngineError` carries `engineCode`.
*/
function badMintUrl(error) {
	const code = error instanceof Error ? error.engineCode : void 0;
	return code === "invalidMintUrl" || code === "mintNotHttps";
}
/**
* The engine's wallet refusals about what the person asked, by the words it writes (they carry no `engineCode`): a
* wallet or card that is not there, a token or invoice that is not one, a wallet already made, no mint or source to do
* it with. Before, each was `engine` (exit 1), which a bot reads as the engine failing and may retry.
*/
var WALLET_REFUSALS = [
	[/^There is no .+ to remove$/, "not_found"],
	[/^That Lightning card is gone\b/, "not_found"],
	[/^That is not a (valid ecash token|Lightning invoice)$/, "bad_request"],
	[/^You already have a .+ wallet$/, "refused"],
	[/^No mint could create an invoice: No mint configured$/, "unavailable"],
	[/^No Bitcoin source is set up$/, "unavailable"],
	[/^The faucet did not pay: This wallet has no test mint\b/, "unavailable"],
	[/^Ghostly cannot ask this wallet's faucet by itself\b/, "unavailable"]
];
function walletRefusal(error) {
	if (!(error instanceof Error) || error instanceof CliError) return error;
	const code = WALLET_REFUSALS.find(([pattern]) => pattern.test(error.message))?.[1];
	return code ? new CliError(code, error.message) : error;
}
var WALLET_METHODS = Object.fromEntries(Object.entries({
	async "wallet.list"(ctx, params) {
		await federationsOpen(ctx);
		const s = state(ctx);
		const only = params.network === void 0 ? null : network(params);
		return {
			wallets: (s.wallet.wallets ?? []).filter((w) => !only || w.network === only).map((w) => walletJson(w, s)),
			offers: (s.wallet.offers ?? []).filter((o) => !only || o.network === only).map((o) => {
				const gap = NODE_GAPS[o.type];
				return {
					type: o.type,
					network: o.network,
					available: o.available && !gap,
					reason: gap ?? o.reason ?? null,
					exists: !!o.exists,
					several: !!o.several,
					needs: o.needs ?? null,
					...o.providers ? { providers: nodeSources(o).map((p) => ({
						id: p.id,
						label: p.label,
						fields: p.fields.map((f) => ({
							name: f.name,
							label: f.label,
							kind: f.kind,
							optional: !!f.optional
						}))
					})) } : {}
				};
			})
		};
	},
	async "wallet.create"(ctx, params) {
		const type = oneOf(params, "type", TYPES, "cashu");
		const n = network(params);
		const gap = NODE_GAPS[type];
		if (gap) throw new CliError("unavailable", gap);
		await federationsOpen(ctx);
		const values = {};
		const raw = params.values ?? {};
		if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.values(raw).some((v) => typeof v !== "string")) throw new CliError("bad_request", "values must be an object of strings");
		Object.assign(values, raw);
		const provider = str(params, "provider") ?? (type === "bitcoin" ? "bdk" : void 0);
		if (type === "bitcoin" && provider === "bdk" && !values.mnemonic) values.mnemonic = generateMnemonic(wordlist, 128);
		createChecked(type, n, state(ctx).wallet.offers?.find((o) => o.type === type && o.network === n), provider, values, params);
		return walletJson(await node(ctx).walletCreate({
			type,
			network: n,
			...provider ? { providerId: provider } : {},
			...Object.keys(values).length ? { values } : {},
			...str(params, "invite") ? { invite: str(params, "invite") } : {},
			...str(params, "apiKey") ? { apiKey: str(params, "apiKey") } : {}
		}), state(ctx));
	},
	async "wallet.remove"(ctx, params) {
		const type = oneOf(params, "type", TYPES, "cashu");
		const n = network(params);
		const card = cardOf(ctx, params, type);
		try {
			await node(ctx).walletRemove({
				type,
				network: n,
				...card ? { card } : {},
				...bool(params, "acceptLoss") ? { acceptLoss: true } : {}
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!bool(params, "acceptLoss") && /hold|still|awaiting|lose|backup/i.test(message)) throw new CliError("confirm", `${message} (pass acceptLoss, --accept-loss, only if that is intended)`);
			throw error;
		}
		return { removed: {
			type,
			network: n,
			card: card ?? null
		} };
	},
	async "wallet.faucet"(ctx, params) {
		const type = oneOf(params, "type", TYPES, "cashu");
		if (network(params) !== "testnet") throw new CliError("refused", "Test coins are for Testnet wallets only");
		const card = cardOf(ctx, params, type);
		return node(ctx).walletTestCoins({
			type,
			network: "testnet",
			...card ? { card } : {}
		});
	},
	async "wallet.history"(ctx, params) {
		const n = network(params);
		const limit = num(params, "limit", 50, {
			min: 1,
			max: 1e4,
			whole: true
		});
		await federationsOpen(ctx);
		return {
			network: n,
			history: (netView(state(ctx), n)?.history ?? []).slice(0, limit)
		};
	},
	async "wallet.receive"(ctx, params) {
		const amount = num(params, "amount", 0, { min: 1 });
		if (!amount) throw new CliError("bad_request", "amount is required");
		const n = network(params);
		await federationsOpen(ctx);
		const card = cardOf(ctx, params, "lightning");
		const invoice = await node(ctx).walletReceiveLightning({
			amount,
			network: n,
			...card ? { card } : {}
		});
		return {
			network: n,
			amount,
			invoice: invoice.invoice,
			expiresAt: invoice.expiresAt,
			paymentHash: invoice.paymentHash ?? null,
			source: invoice.source
		};
	},
	async "wallet.address"(ctx, params) {
		const type = oneOf(params, "type", [
			"bitcoin",
			"arkade",
			"spark",
			"usdt"
		], "bitcoin");
		const n = network(params);
		if (type === "bitcoin") return {
			type,
			network: n,
			address: await node(ctx).bitcoinReceiveAddress({ network: n })
		};
		const view = netView(state(ctx), n);
		const address = type === "arkade" ? view?.ark?.address : type === "spark" ? view?.spark?.address : view?.usdt?.address;
		if (!address) throw new CliError("unavailable", `No ${type} wallet with an address on ${n}`);
		return {
			type,
			network: n,
			address
		};
	},
	async "wallet.redeem"(ctx, params) {
		return node(ctx).walletReceiveToken({ token: str(params, "token", true).trim() });
	},
	async "wallet.mint.add"(ctx, params) {
		return node(ctx).walletAddMint({
			url: str(params, "url", true),
			...bool(params, "primary") ? { primary: true } : {}
		}).catch((error) => {
			throw badMintUrl(error) ? new CliError("bad_request", error.message) : error;
		});
	},
	async "lightning.default"(ctx, params) {
		lightningCard(ctx, params);
		await node(ctx).lightningSetReceive({
			network: network(params),
			card: str(params, "card", true)
		});
		return {
			network: network(params),
			receive: str(params, "card", true)
		};
	},
	async "lightning.rename"(ctx, params) {
		lightningCard(ctx, params);
		await node(ctx).lightningRename({
			network: network(params),
			card: str(params, "card", true),
			name: str(params, "name", true)
		});
		return {
			network: network(params),
			card: str(params, "card", true),
			name: str(params, "name", true)
		};
	},
	/** An invoice, a Lightning address or an LNURL, from the network's Lightning (a card of it, or its default). */
	async "pay"(ctx, params) {
		const text = str(params, "target", true).trim();
		const card = str(params, "card");
		let invoice = text.replace(/^lightning:/i, "");
		let n;
		let note;
		if (isInvoice(text)) n = network(params);
		else if (isLnurl(text)) {
			n = network(params);
			const amount = num(params, "amount", 0, { min: 1 });
			if (!amount) throw new CliError("bad_request", "amount is required to pay a Lightning address or LNURL");
			const view = await node(ctx).lnurlResolve({
				text,
				network: n
			});
			if (amount < view.minSat || amount > view.maxSat) throw new CliError("refused", `${view.domain} takes from ${view.minSat} to ${view.maxSat} sats`);
			const got = await node(ctx).lnurlInvoice({
				id: view.id,
				amount,
				...str(params, "comment") ? { comment: str(params, "comment") } : {},
				network: n
			});
			invoice = got.invoice;
			note = got.note;
		} else throw new CliError("bad_request", "Not a Lightning invoice, Lightning address or LNURL");
		if (n === "mainnet" && !bool(params, "confirmReal")) throw new CliError("confirm", "This pays real money (Mainnet): pass --confirm-real to confirm this payment");
		await federationsOpen(ctx);
		const quote = await node(ctx).walletQuoteInvoice({
			invoice,
			network: n,
			...card ? { card } : {}
		});
		const maxFee = params.maxFee === void 0 ? null : num(params, "maxFee", 0);
		if (maxFee !== null && quote.feeReserve > maxFee) throw new CliError("refused", `The fee may reach ${quote.feeReserve} sats, more than the ${maxFee} allowed`);
		const paid = await node(ctx).walletPayQuote({
			quote: quote.quote,
			mint: quote.mint,
			...note ? { note } : {},
			...real(params)
		});
		return {
			network: n,
			amount: quote.amount,
			feeReserve: quote.feeReserve,
			source: quote.source ?? quote.mint,
			paid: paid.paid
		};
	},
	/** Ecash to a contact in a chat (the payment sheet's Pay). */
	async "chat.pay"(ctx, params) {
		const link = chatOf(ctx, params);
		inviteTaken(link);
		const amount = num(params, "amount", 0, { min: 1 });
		if (!amount) throw new CliError("bad_request", "amount is required");
		const n = network(params);
		if (n === "mainnet" && !bool(params, "confirmReal")) throw new CliError("confirm", "This pays real money (Mainnet): pass --confirm-real to confirm this payment");
		await federationsOpen(ctx);
		const { paymentId } = await node(ctx).sendPayment({
			linkId: link.id,
			amount,
			timestamp: sentAt(),
			network: n,
			...str(params, "memo") ? { memo: str(params, "memo") } : {},
			...real(params)
		});
		return {
			chat: link.id,
			paymentId
		};
	},
	/** A request in a chat (the payment sheet's Request): the contact's app pays it. */
	async "chat.request"(ctx, params) {
		const link = chatOf(ctx, params);
		const amount = num(params, "amount", 0, { min: 1 });
		if (!amount) throw new CliError("bad_request", "amount is required");
		const method = params.method === void 0 ? void 0 : oneOf(params, "method", METHODS$1, "cashu");
		const rail = params.rail === void 0 ? void 0 : oneOf(params, "rail", ["cashu", "lightning"], "cashu");
		await federationsOpen(ctx);
		const { paymentId } = await node(ctx).requestPayment({
			linkId: link.id,
			amount,
			timestamp: sentAt(),
			network: network(params),
			...str(params, "memo") ? { memo: str(params, "memo") } : {},
			...method ? { method } : {},
			...rail ? { rail } : {},
			...str(params, "card") ? { card: str(params, "card") } : {}
		});
		return {
			chat: link.id,
			paymentId
		};
	},
	/** Pays a request the contact made in a chat. */
	async "chat.payRequest"(ctx, params) {
		const link = chatOf(ctx, params);
		const paymentId = str(params, "payment", true);
		const request = state(ctx).payments[paymentId];
		if (!request || request.linkId !== link.id || request.kind !== "request") throw new CliError("not_found", `No request ${paymentId} in this chat`);
		const n = paymentNetwork(request);
		if (n === "mainnet" && !bool(params, "confirmReal")) throw new CliError("confirm", "This request is for real money (Mainnet): pass --confirm-real to confirm this payment", { network: n });
		const via = params.via === void 0 ? void 0 : oneOf(params, "via", ["lightning"], "lightning");
		await federationsOpen(ctx);
		await node(ctx).payRequest({
			linkId: link.id,
			paymentId,
			network: n,
			...via ? { via } : {},
			...params.maxFee !== void 0 ? { maxFee: num(params, "maxFee", 0) } : {},
			...str(params, "card") ? { card: str(params, "card") } : {},
			...real(params)
		});
		return paymentJson(state(ctx).payments[paymentId] ?? request);
	},
	/** Which ways of paying this chat takes, per network (the chat's Accept switches). */
	async "chat.accept"(ctx, params) {
		const link = chatOf(ctx, params);
		const method = oneOf(params, "method", CHAT_METHODS, "cashu");
		const on = bool(params, "on");
		const nets = params.networks === void 0 ? void 0 : (() => {
			const value = params.networks;
			if (!Array.isArray(value) || !value.every((v) => v === "mainnet" || v === "testnet")) throw new CliError("bad_request", "networks must list mainnet and/or testnet");
			return value;
		})();
		await node(ctx).setChatPaymentMethods({
			linkId: link.id,
			methods: { [method]: on },
			...nets ? { networks: { [method]: nets } } : {}
		});
		const now = state(ctx).links.find((l) => l.id === link.id);
		return {
			chat: link.id,
			methods: now?.paymentMethods ?? null,
			networks: now?.paymentNetworks ?? null
		};
	},
	async "payment.list"(ctx, params) {
		const chat = params.chat === void 0 ? null : chatOf(ctx, params).id;
		return { payments: Object.values(state(ctx).payments).filter((p) => !chat || p.linkId === chat).sort((a, b) => b.createdAt - a.createdAt).map(paymentJson) };
	},
	async "payment.check"(ctx, params) {
		const link = chatOf(ctx, params);
		if (state(ctx).payments[str(params, "payment", true)]?.linkId !== link.id) throw new CliError("not_found", `No payment ${JSON.stringify(str(params, "payment", true))} in this chat (ghostly payment list --chat ${link.id})`);
		await node(ctx).checkPayment({
			linkId: link.id,
			paymentId: str(params, "payment", true)
		});
		return {
			chat: link.id,
			paymentId: str(params, "payment", true)
		};
	},
	async "payment.reclaim"(ctx, params) {
		if (!state(ctx).payments[str(params, "payment", true)]) throw new CliError("not_found", `No payment ${JSON.stringify(str(params, "payment", true))} (ghostly payment list)`);
		await node(ctx).reclaimPayment({ paymentId: str(params, "payment", true) });
		const p = state(ctx).payments[str(params, "payment", true)];
		return p ? paymentJson(p) : { paymentId: str(params, "payment", true) };
	}
}).map(([name, method]) => [name, (ctx, params) => method(ctx, params).catch((error) => {
	throw walletRefusal(error);
})]));
//#endregion
//#region src/api.ts
/**
* A text past what a chat or a group carries (16 KiB of UTF-8, as the engine counts it: trimmed) is refused before the
* engine is asked, with a code that says it never goes as it is, not "unavailable", which reads as "try later".
*/
function checkTextSize(text) {
	const bytes = new TextEncoder().encode(text.trim()).length;
	if (bytes > LIMITS.maxChatMessageBytes) throw new CliError("bad_request", `Message exceeds ${LIMITS.maxChatMessageBytes} UTF-8 bytes (${bytes}): shorten it, or send it as a file`, {
		bytes,
		max: LIMITS.maxChatMessageBytes
	});
}
/**
* The engine's state as `engine getState` prints it without `--show-secret`: the settings' credentials, a group's
* entry link (anyone who reads it can join) and a pending chat's invite code (whoever reads it can take the chat)
* are `<hidden>`.
*/
function hideStateSecrets(state) {
	return {
		...state,
		settings: redactSettings(state.settings),
		...state.groups ? { groups: state.groups.map((g) => g.entryLink ? {
			...g,
			entryLink: "<hidden>"
		} : g) } : {},
		...state.links ? { links: state.links.map((l) => l.inviteCode ? {
			...l,
			inviteCode: "<hidden>"
		} : l) } : {}
	};
}
/** Settings as a bot may read them: storage credentials and other secrets masked unless asked for. */
function redactSettings(settings, showSecret = false) {
	if (showSecret) return settings;
	const mask = (value, key = "") => {
		if (value && typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v, k)]));
		if (Array.isArray(value)) return value.map((item) => mask(item, key));
		if (typeof value === "string" && (/secret|password|token|credential|privatekey|nsec|bunker/i.test(key) || key === "auth" || key === "space")) return "<hidden>";
		return value;
	};
	const { avatar, wake, ...rest } = settings;
	return {
		...mask(rest),
		...avatar ? { avatar: "<set>" } : {},
		...wake ? { wake: "<set>" } : {}
	};
}
/** Settings a command may change; the rest are the app's to manage. */
var SETTABLE = {
	relays: "strings",
	irohRelays: "strings",
	hyperdhtRelay: "string",
	readRelays: "boolean",
	iceServers: "ice",
	publicProfiles: "boolean",
	online: "boolean",
	shareProfile: "boolean",
	sendTyping: "boolean",
	nick: "string",
	autoDownloads: "boolean",
	serveFiles: "boolean"
};
/**
* A relay address the engine refuses (node.ts `updateSettings`, irohWeb.ts, hyperdhtRelay.ts): the person's value, so
* `bad_request` named by its key, in a terminal's words ("give", not the app's "Enter"). Before, `engine` (exit 1). A
* wrong scheme ("Use an https:// relay address") too.
*/
function relayRefused(error, patch) {
	if (!(error instanceof Error) || !/^(?:Enter (?:at least one|a) relay address|Not a relay address|Use an? \S+ relay address)\b/.test(error.message)) return error;
	const keys = [
		"relays",
		"irohRelays",
		"hyperdhtRelay"
	].filter((key) => Object.hasOwn(patch, key));
	return new CliError("bad_request", `${keys.join(", ") || "relays"}: ${error.message.replace(/^Enter /, "give ").replace(/^(Not|Use) /, (word) => word.toLowerCase())}`);
}
var TRANSPORT_NAMES = {
	auto: "auto",
	dht: "dht",
	webrtc: "webrtc/1",
	iroh: "iroh/1",
	hyperdht: "hyperdht/1",
	"webrtc/1": "webrtc/1",
	"iroh/1": "iroh/1",
	"hyperdht/1": "hyperdht/1"
};
/** Code points before `index` (UTF-16) in `text`: mentions count code points (WISP 902 § Mentions). */
var codePoints = (text, index) => [...text.slice(0, index)].length;
/**
* Mentions for a group message: each ref (a member key, a unique prefix of one, a member's name, or `everyone`) must
* be written in the text as `@<name>` (or `@<key prefix>`, `@everyone`); the first such place is the mention.
*/
function mentionsFor(text, refs, group) {
	const out = [];
	for (const ref of refs) {
		let key, spelled;
		if (ref === "everyone" || ref === "*") {
			key = "*";
			spelled = ["everyone", "all"];
		} else {
			const lower = ref.toLowerCase();
			const byKey = group.members.filter((m) => !m.me && m.key === ref);
			const matches = byKey.length ? byKey : group.members.filter((m) => !m.me && (m.key.startsWith(ref) || m.nick?.trim().toLowerCase() === lower));
			if (matches.length !== 1) throw new CliError(matches.length ? "bad_request" : "not_found", matches.length ? `${JSON.stringify(ref)} names more than one member` : `No member ${JSON.stringify(ref)} in ${group.name}`);
			key = matches[0].key;
			spelled = [
				matches[0].nick?.trim(),
				ref,
				key.slice(0, 8)
			].filter((s) => !!s);
		}
		const found = spelled.map((name) => ({
			name,
			index: text.toLowerCase().indexOf("@" + name.toLowerCase())
		})).find((f) => f.index >= 0);
		if (!found) throw new CliError("bad_request", `Write @${spelled[0]} in the text to mention ${ref}`);
		out.push({
			k: key,
			o: codePoints(text, found.index),
			l: [..."@" + found.name].length
		});
	}
	return out;
}
/** Per host: stops watching the invite it marked as the chat on screen. */
var inviteShown = /* @__PURE__ */ new WeakMap();
/**
* Marks a new invite as the chat on screen (native listeners, the quick pace) only until it is paired: a paired chat
* keeps its listeners anyway, and a daemon nobody looks at reads an away contact at the background pace, as its
* other chats and the same chat after a restart do. Nor past its wait for a peer (`AWAITING_PEER_MS`): an invite
* nobody joined is then read at the background pace like the daemon's other ones, which it no longer holds back.
*/
function showUntilPaired(ctx, linkId) {
	inviteShown.get(ctx)?.();
	node(ctx).setActiveLink({ linkId });
	let seen = false;
	const done = (s) => {
		const link = s.links.find((l) => l.id === linkId);
		if (link) seen = true;
		return link ? !!link.peerParticipationKey : seen;
	};
	const stop = () => {
		off();
		clearTimeout(timer);
		if (inviteShown.get(ctx) === stop) inviteShown.delete(ctx);
	};
	const hide = () => {
		stop();
		node(ctx).setActiveLink({ linkId: null });
	};
	const timer = setTimeout(hide, AWAITING_PEER_MS);
	timer.unref?.();
	const off = ctx.hub.onState((s) => {
		if (done(s)) hide();
	});
	inviteShown.set(ctx, stop);
}
var METHODS = {
	...WALLET_METHODS,
	...FILE_METHODS,
	...STATUS_CARD_METHODS,
	...BUTTON_METHODS,
	...GROUP_ADMIN_METHODS,
	...IDENTITY_METHODS,
	...X401_METHODS,
	...SERVICE_METHODS,
	...BACKUP_METHODS,
	...CALL_METHODS,
	...APP_SERVE_METHODS,
	...APP_CHAT_METHODS,
	async status(ctx) {
		const s = state(ctx);
		return {
			version: ctx.version,
			profile: ctx.runtime.paths.name,
			mode: ctx.mode,
			pid: process.pid,
			online: s.settings.online,
			name: s.settings.nick || null,
			webrtc: ctx.runtime.webrtc,
			calls: ctx.runtime.callsUnavailable === null,
			chats: s.links.length,
			live: s.links.filter(isLive).length,
			groups: s.groups.length,
			discovery: {
				protocol: s.transport.protocol,
				relays: s.transport.relays
			},
			events: { lastSeq: ctx.hub.lastSeq }
		};
	},
	async "profile.get"(ctx) {
		const { settings } = state(ctx);
		return {
			profile: ctx.runtime.paths.name,
			name: settings.nick || null,
			shareProfile: settings.shareProfile !== false,
			picture: !!settings.avatar,
			online: settings.online
		};
	},
	async "profile.set"(ctx, params) {
		const patch = {};
		if (params.name !== void 0) patch.nick = checkShownName(params.name);
		if (params.shareProfile !== void 0) patch.shareProfile = bool(params, "shareProfile");
		await node(ctx).updateSettings({ settings: patch });
		return METHODS["profile.get"](ctx, {});
	},
	async "settings.get"(ctx, params) {
		return redactSettings(state(ctx).settings, bool(params, "showSecret"));
	},
	async "settings.set"(ctx, params) {
		const patch = {};
		let warning;
		for (const [key, value] of Object.entries(params)) {
			const kind = Object.hasOwn(SETTABLE, key) ? SETTABLE[key] : void 0;
			if (!kind) throw new CliError("bad_request", `${key} is not a setting the CLI changes (${Object.keys(SETTABLE).join(", ")})`);
			if (kind === "strings" && !(Array.isArray(value) && value.every((v) => typeof v === "string"))) throw new CliError("bad_request", `${key} must be a list of strings`);
			if (kind === "string" && typeof value !== "string") throw new CliError("bad_request", `${key} must be a string`);
			if (kind === "boolean" && typeof value !== "boolean") throw new CliError("bad_request", `${key} must be true or false`);
			if (key === "nick") {
				patch.nick = checkShownName(value, key);
				continue;
			}
			if (kind === "ice") {
				if (!(Array.isArray(value) && value.every((v) => v && typeof v === "object"))) throw new CliError("bad_request", `${key} must be a list of ICE servers`);
				const servers = value.map(iceServerSetting);
				for (const server of servers) {
					const problem = iceServerProblem(server);
					if (problem) throw new CliError("bad_request", `${key}: ${problem}`);
				}
				patch[key] = servers;
				const unused = servers.flatMap((server) => server.urls.split(/[\s,]+/)).filter((url) => /^turns:|\?transport=tcp$/i.test(url));
				if (unused.length) warning = `The CLI reaches TURN over UDP only: it does not use ${unused.join(", ")} (the apps do). Add a turn: server over UDP for the CLI`;
				continue;
			}
			patch[key] = value;
		}
		await node(ctx).updateSettings({ settings: patch }).catch((error) => {
			throw relayRefused(error, patch);
		});
		return {
			...redactSettings(state(ctx).settings),
			...warning ? { warning } : {}
		};
	},
	async "invite.create"(ctx, params) {
		const label = str(params, "label");
		const { linkId, inviteCode } = await node(ctx).createLink();
		if (label) await node(ctx).renameLink({
			linkId,
			label
		});
		showUntilPaired(ctx, linkId);
		const progressOf = (s) => s.links.find((l) => l.id === linkId)?.pairingProgress;
		const progress = await waitForState(ctx, (s) => {
			const p = progressOf(s);
			return p && (p.stage !== "publishing" || ctx.mode === "daemon" && p.relayWaitUntil) ? p : void 0;
		}, 2e4, "the invite to be published").catch(() => progressOf(state(ctx)));
		const published = !!progress && progress.stage !== "publishing" && progress.reason !== "publish";
		const waitUntil = published ? void 0 : progress?.relayWaitUntil;
		return {
			chat: linkId,
			invite: inviteCode,
			link: inviteLink(inviteCode),
			published,
			...waitUntil !== void 0 && { retryInMs: Math.max(0, waitUntil - Date.now()) }
		};
	},
	async "invite.join"(ctx, params) {
		let invite = str(params, "invite", true).trim();
		const hash = invite.indexOf("#");
		if (/^https?:\/\//i.test(invite) && hash !== -1) invite = invite.slice(hash + 1);
		let linkId;
		try {
			({linkId} = await node(ctx).joinLink({ inviteCode: invite }));
		} catch (error) {
			const own = ownInviteRefusal(error);
			if (own) throw new CliError("refused", "This is your own invite. Share it with a contact; they join with it.", own.linkId ? { chat: own.linkId } : void 0);
			const message = error instanceof Error ? error.message : String(error);
			if (/does not look like/i.test(message)) throw new CliError("bad_request", message);
			throw error;
		}
		const label = str(params, "label");
		if (label) await node(ctx).renameLink({
			linkId,
			label
		});
		showUntilPaired(ctx, linkId);
		return { chat: linkId };
	},
	async "chat.list"(ctx, params) {
		const showSecret = bool(params, "showSecret");
		return { chats: state(ctx).links.map((link) => chatJson(link, showSecret)).sort((a, b) => b.lastMessageAt - a.lastMessageAt || b.createdAt - a.createdAt) };
	},
	async "chat.get"(ctx, params) {
		const link = chatNotGroup(ctx, params, "group show");
		return {
			...chatDetailsJson(link, bool(params, "showSecret")),
			heldUntil: holdOf(ctx, link.id)
		};
	},
	async "chat.history"(ctx, params) {
		const link = chatNotGroup(ctx, params, "group history");
		return historyOf(ctx, link.id, params, (m) => chatMessageJson(m, link));
	},
	async "chat.send"(ctx, params) {
		const link = chatNotGroup(ctx, params, "group send", "[text...]");
		const text = str(params, "text", true);
		checkTextSize(text);
		if (!bool(params, "force")) {
			const secret = findSecret(text);
			if (secret) throw new CliError("confirm", `The text looks like ${secret.kind === "cashu" ? "a Cashu token (money anyone who reads it can take)" : "a secret (a seed or a private key)"}; send it with --force if you mean to`, { kind: secret.kind });
		}
		const wait = oneOf(params, "wait", [
			"none",
			"sent",
			"delivered"
		], "none");
		const replyTo = str(params, "reply");
		const card = buttonsCard(params);
		endTyping(ctx, { linkId: link.id }, false);
		const result = await node(ctx).sendMessage({
			linkId: link.id,
			text,
			...replyTo ? { replyTo } : {},
			...card ? { card } : {}
		});
		if (result.error) throw /not in this chat|cannot be replied to/.test(result.error) ? new CliError("not_found", result.error) : new CliError(result.refused ? "refused" : "unavailable", result.error);
		if (!result.messageId) throw new CliError("bad_request", "Nothing to send");
		let message = await node(ctx).getMessage(link.id, result.messageId);
		if (wait !== "none") message = await waitForMessage(ctx, link.id, result.messageId, wait, num(params, "timeout", 30, {
			min: 1,
			max: 3600
		}) * 1e3);
		return {
			chat: link.id,
			messageId: result.messageId,
			delivery: message?.delivery ?? null,
			...card ? {
				buttons: card.id,
				card,
				pressable: pressable(link)
			} : {}
		};
	},
	/**
	* WISP 400 § Edits: the whole new text of one of my texts in a 1:1 chat. It shows here at once and reaches the contact
	* once the chat is live and both apps offer edit/1; `--wait confirmed` waits for the contact to confirm it.
	*/
	async "chat.edit"(ctx, params) {
		const link = chatNotGroup(ctx, params, "group edit", "<message> <text...>");
		const messageId = str(params, "message", true);
		const text = str(params, "text", true);
		if (!bool(params, "force")) {
			const secret = findSecret(text);
			if (secret) throw new CliError("confirm", `The text looks like ${secret.kind === "cashu" ? "a Cashu token (money anyone who reads it can take)" : "a secret (a seed or a private key)"}; edit with --force if you mean to`, { kind: secret.kind });
		}
		const wait = oneOf(params, "wait", ["none", "confirmed"], "none");
		const result = await node(ctx).editMessage({
			linkId: link.id,
			messageId,
			text
		});
		if (result.error) throw editRefused(await messageOf(ctx, link.id, messageId), messageId, "chat", result.error, result.refused);
		const id = result.messageId ?? messageId;
		let message = await node(ctx).getMessage(link.id, id);
		if (wait === "confirmed" && message?.edit?.pending) message = await waitForEdit(ctx, link.id, id, num(params, "timeout", 30, {
			min: 1,
			max: 3600
		}) * 1e3);
		return {
			chat: link.id,
			messageId: id,
			edits: message?.edit?.seq ?? 0,
			confirmed: !!message && !message.edit?.pending
		};
	},
	/**
	* WISP 401 § Typing: said on the live session only, and a start only while `sendTyping` is on; it holds 6 s there.
	* `kind` (typing, recording, thinking) and `status` (a short line, e.g. "Transcribing your audio…") say what this
	* side is doing; a new one reaches the contact at once.
	* `for`: kept that many seconds (a one-shot stays that long once the chat is live, and stops when it is not live
	* within `ONE_SHOT_LIVE_GRACE_MS`), until a message to the chat or a stop.
	*/
	async "chat.typing"(ctx, params) {
		const link = chatNotGroup(ctx, params, "group typing");
		const typing = !bool(params, "stop");
		const { kind, status } = typingWord(params, typing);
		const word = {
			...kind !== "typing" ? { kind } : {},
			...status ? { status } : {}
		};
		const seconds = params.for === void 0 ? 0 : num(params, "for", 0, {
			min: 1,
			max: 600
		});
		if (!typing && seconds) throw new CliError("bad_request", "for keeps typing on: not with stop");
		endTyping(ctx, { linkId: link.id }, false);
		node(ctx).setTyping({
			linkId: link.id,
			typing,
			...word
		});
		const until = seconds ? Date.now() + seconds * 1e3 : null;
		const kept = seconds ? keepTyping(ctx, { linkId: link.id }, seconds * 1e3, word) : null;
		const open = (s) => s.links.find((l) => l.id === link.id)?.dataLink === "open";
		if (kept && ctx.mode === "one-shot") await keepOneShot(ctx, { linkId: link.id }, kept, open);
		return {
			chat: link.id,
			typing,
			...typing ? { kind } : {},
			...status ? { status } : {},
			live: open(state(ctx)),
			sendTyping: state(ctx).settings.sendTyping !== false,
			...until ? { until } : {}
		};
	},
	/** WISP 400 § Reactions: one emoji per person per message, a new one replaces mine; `remove` takes mine back. */
	async "chat.react"(ctx, params) {
		const link = chatNotGroup(ctx, params, "group react", "<message> <emoji>");
		return {
			chat: link.id,
			...await react(ctx, link.id, params)
		};
	},
	/**
	* WISP 400 § Pinned message: one per chat or group, a new pin replaces it; `remove` unpins. In a community only the
	* admin pins. Answers the chat (or group) and the message now pinned (null once unpinned).
	*/
	async "chat.pin"(ctx, params) {
		const target = chatOrGroup(ctx, str(params, "chat", true));
		const remove = bool(params, "remove"), messageId = remove ? str(params, "message") : str(params, "message", true);
		const result = await node(ctx).pinMessage({
			linkId: target.linkId,
			...messageId && { messageId },
			remove
		});
		if (result.error) throw new CliError(/not in this chat|Nothing is pinned/.test(result.error) ? "not_found" : /Only the admin/.test(result.error) ? "refused" : "bad_request", result.error);
		return {
			[target.group ? "group" : "chat"]: target.id,
			messageId: remove ? null : messageId,
			removed: remove
		};
	},
	/**
	* WISP 400 § Forwards: messages of a chat or a group sent on to up to 5 chats and groups, each as a new message of mine
	* that says it was forwarded (one hop more) and nothing of who wrote it. A file goes from the bytes here, never
	* fetched again; a group takes texts only. `wait: sent`: each text until it is on its way (a group's until an edge
	* took it), each file until its transfer is done. What a chat refused comes back per chat; any refusal fails the call.
	*/
	async "chat.forward"(ctx, params) {
		const from = chatOrGroup(ctx, str(params, "chat", true));
		const messageIds = list(params, "messages");
		if (!messageIds.length) throw new CliError("bad_request", "Name the messages to forward (their ids, from history or an event)");
		const to = list(params, "to").map((ref) => chatOrGroup(ctx, ref));
		if (!to.length) throw new CliError("bad_request", "Forward to which chat? Name one or more with --to");
		const chosen = [];
		for (const id of messageIds) {
			const message = await node(ctx).getMessage(from.linkId, id);
			if (!message) throw new CliError("not_found", `No message ${id} in this ${from.group ? "group" : "chat"}`);
			chosen.push(message);
		}
		if (!bool(params, "force")) for (const message of chosen) {
			const secret = message.file ? null : findSecret(message.text);
			if (secret) throw new CliError("confirm", `A message looks like ${secret.kind === "cashu" ? "a Cashu token (money anyone who reads it can take)" : "a secret (a seed or a private key)"}; forward it with --force if you mean to`, {
				kind: secret.kind,
				messageId: message.id
			});
		}
		const wait = oneOf(params, "wait", ["none", "sent"], "none");
		let results;
		try {
			({results} = await node(ctx).forwardMessages({
				linkId: from.linkId,
				messageIds,
				to: to.map((t) => t.linkId)
			}));
		} catch (error) {
			throw new CliError("refused", error instanceof Error ? error.message : String(error));
		}
		const ms = num(params, "timeout", 30, {
			min: 1,
			max: 3600
		}) * 1e3;
		const out = results.map((result, i) => ({
			to: to[i].id,
			kind: to[i].group ? "group" : "chat",
			messageIds: result.messageIds,
			sent: result.sent,
			error: result.error
		}));
		if (wait === "sent") for (const [i, result] of out.entries()) for (const messageId of result.messageIds) {
			if (to[i].group) {
				await waitForGroupFrame(ctx, to[i].id, messageId, void 0, ms);
				continue;
			}
			const sent = await node(ctx).getMessage(to[i].id, messageId);
			if (sent?.file) await FILE_METHODS["file.wait"](ctx, {
				chat: to[i].id,
				file: sent.file.id,
				timeout: ms / 1e3
			});
			else await waitForMessage(ctx, to[i].id, messageId, "sent", ms);
		}
		const failed = out.filter((r) => r.error);
		if (failed.length) throw new CliError(failed.length === out.length ? "refused" : "engine", failed.map((r) => `${r.to}: ${r.error}`).join("; "), {
			from: from.id,
			results: out
		});
		return {
			from: from.id,
			results: out
		};
	},
	async "chat.retry"(ctx, params) {
		const link = chatOf(ctx, params);
		const messageId = str(params, "message", true);
		const message = await node(ctx).getMessage(link.id, messageId);
		if (!message) throw new CliError("not_found", `No message ${messageId} in this chat`);
		if (message.sender !== "me") throw new CliError("not_found", `No message ${messageId} of yours in this chat: only your own messages are sent again`);
		if (message.delivery === "delivered") throw new CliError("refused", "Nothing to send again: it was delivered");
		await node(ctx).retryMessage({
			linkId: link.id,
			messageId
		});
		return {
			chat: link.id,
			messageId
		};
	},
	async "chat.delete"(ctx, params) {
		const link = chatOf(ctx, params);
		const messageId = str(params, "message", true);
		if (!await node(ctx).getMessage(link.id, messageId)) throw new CliError("not_found", `No message ${messageId} in this chat`);
		await node(ctx).deleteMessage({
			linkId: link.id,
			messageId
		});
		return {
			chat: link.id,
			deleted: messageId
		};
	},
	async "chat.details"(ctx, params) {
		const link = chatOf(ctx, params);
		const details = await node(ctx).messageDetails({
			linkId: link.id,
			messageId: str(params, "message", true)
		});
		if (!details) throw new CliError("not_found", `No message ${String(params.message)} in this chat`);
		return details;
	},
	async "chat.rename"(ctx, params) {
		const link = chatNotGroup(ctx, params, "group rename", "<name...>");
		await node(ctx).renameLink({
			linkId: link.id,
			label: str(params, "name") ?? ""
		});
		return chatJson(findChat(state(ctx).links, link.id));
	},
	async "chat.remove"(ctx, params) {
		const link = chatNotGroup(ctx, params, "group forget", "--yes");
		if (!bool(params, "yes")) throw new CliError("confirm", "Removing a chat deletes its keys and history on this device; pass yes (--yes) to go on");
		await node(ctx).removeLink({ linkId: link.id });
		return { removed: link.id };
	},
	async "chat.transport"(ctx, params) {
		const link = chatOf(ctx, params);
		const name = str(params, "transport", true);
		const transport = Object.hasOwn(TRANSPORT_NAMES, name) ? TRANSPORT_NAMES[name] : void 0;
		if (!transport) throw new CliError("bad_request", `transport must be one of auto, dht, webrtc, iroh, hyperdht`);
		await node(ctx).setChatTransport({
			linkId: link.id,
			transport
		});
		return chatDetailsJson(findChat(state(ctx).links, link.id));
	},
	/** Reconnects now; a chat held off its direct link (`chat disconnect --hold`) leaves the hold first. */
	async "chat.connect"(ctx, params) {
		const link = chatOf(ctx, params);
		await releaseHold(ctx, link.id, "connect");
		inviteTaken(link);
		await node(ctx).connect({ linkId: link.id });
		return chatJson(findChat(state(ctx).links, link.id));
	},
	/**
	* Closes the live session; the contact's app may dial again at once. `hold` (minutes): the chat stays off its
	* direct link that long, on the DHT (its "DHT only" choice, taken back after); 0 ends a hold now.
	*/
	async "chat.disconnect"(ctx, params) {
		const link = chatOf(ctx, params);
		if (params.hold === void 0) {
			node(ctx).disconnect({ linkId: link.id });
			return chatJson(findChat(state(ctx).links, link.id));
		}
		const minutes = num(params, "hold", 0, {
			min: 0,
			max: HOLD_MAX_MINUTES
		});
		if (minutes === 0) await releaseHold(ctx, link.id, "lifted");
		else await holdChat(ctx, link, minutes);
		return {
			...chatJson(findChat(state(ctx).links, link.id)),
			heldUntil: holdOf(ctx, link.id)
		};
	},
	async "chat.verify"(ctx, params) {
		const link = chatOf(ctx, params);
		const code = str(params, "code", true).replace(/\s+/g, "").toLowerCase();
		const mine = link.pairing?.code?.replace(/\s+/g, "").toLowerCase();
		if (!mine) throw new CliError("unavailable", "This chat shows no comparison code yet (it needs a live session)");
		if (code !== mine) throw new CliError("refused", "The code does not match the one this side shows: do not trust this chat until you know why");
		await node(ctx).confirmPair({
			linkId: link.id,
			code: link.pairing.code
		});
		return chatJson(findChat(state(ctx).links, link.id));
	},
	async "chat.wait"(ctx, params) {
		const link = chatOf(ctx, params);
		const until = oneOf(params, "until", [
			"live",
			"text",
			"paired"
		], "live");
		const ms = num(params, "timeout", 60, {
			min: 1,
			max: 86400
		}) * 1e3;
		return chatJson(await waitForState(ctx, (s) => {
			const now = s.links.find((l) => l.id === link.id);
			if (!now) throw new CliError("not_found", `Chat ${link.id} was removed`);
			return (until === "live" ? isLive(now) : until === "text" ? now.textDelivery === "stream" || now.textDelivery === "dht" || now.textDelivery === "hold" : !!now.pairingProgress?.peerSeen || now.pairing?.status === "ready" || isLive(now)) ? now : void 0;
		}, ms, `chat ${link.id} to be ${until}`));
	},
	async "group.create"(ctx, params) {
		const name = groupName(str(params, "name", true));
		if (!name) throw new CliError("bad_request", `A group's name is 1 to 64 characters on one line`);
		const profile = oneOf(params, "profile", ["community", "mesh"], "community");
		const { groupId } = await node(ctx).createGroup({
			name,
			profile
		});
		let link = null;
		if (profile === "community") ({link} = await node(ctx).enableGroupLink({ groupId }));
		return {
			group: groupId,
			link
		};
	},
	async "group.join"(ctx, params) {
		let groupId;
		try {
			({groupId} = await node(ctx).joinGroupByLink({ link: str(params, "link", true) }));
		} catch (error) {
			if (error instanceof Error && error.message === "This is not a link to a group") throw new CliError("bad_request", error.message);
			throw error;
		}
		return { group: groupId };
	},
	async "group.list"(ctx, params) {
		const showSecret = bool(params, "showSecret");
		return { groups: state(ctx).groups.map((g) => groupJson(g, showSecret)).sort((a, b) => b.lastMessageAt - a.lastMessageAt) };
	},
	async "group.get"(ctx, params) {
		return groupJson(groupOf(ctx, params), bool(params, "showSecret"));
	},
	async "group.history"(ctx, params) {
		const group = groupOf(ctx, params);
		return historyOf(ctx, `group:${group.id}`, params, (m) => groupMessageJson(m, group));
	},
	async "group.send"(ctx, params) {
		const group = groupOf(ctx, params);
		const text = str(params, "text", true);
		checkTextSize(text);
		if (!bool(params, "force")) {
			const secret = findSecret(text);
			if (secret) throw new CliError("confirm", "The text looks like a secret or a Cashu token; send it with --force if you mean to", { kind: secret.kind });
		}
		const mentions = mentionsFor(text, list(params, "mentions"), group);
		const replyTo = str(params, "reply");
		const wait = oneOf(params, "wait", ["none", "sent"], "none");
		const card = buttonsCard(params);
		endTyping(ctx, { groupId: group.id }, false);
		const result = await node(ctx).sendGroupMessage({
			groupId: group.id,
			text,
			...mentions.length ? { mentions } : {},
			...replyTo ? { replyTo } : {},
			...card ? { card } : {}
		});
		if (result.error) throw result.refused ? new CliError("refused", result.error) : groupSendRefused(result.error);
		const messageId = result.messageId ?? null;
		const edges = messageId ? wait === "sent" ? await waitForGroupFrame(ctx, group.id, messageId, void 0, num(params, "timeout", 30, {
			min: 1,
			max: 3600
		}) * 1e3) : node(ctx).groupTaken({
			groupId: group.id,
			messageId
		}) : 0;
		return {
			group: group.id,
			messageId,
			sent: edges > 0,
			edges,
			...card ? {
				buttons: card.id,
				card
			} : {}
		};
	},
	/**
	* WISP 902 § Edits: the whole new text of one of my messages in a group. It shows here at once and goes to the members
	* (a private group's over the edges that are up, the others when theirs open; a community's through the group).
	* `mentions`: members the new text names beyond those the message named. `sent`: no longer waiting for the pace.
	*/
	async "group.edit"(ctx, params) {
		const group = groupOf(ctx, params);
		const messageId = str(params, "message", true);
		const text = str(params, "text", true);
		if (!bool(params, "force")) {
			const secret = findSecret(text);
			if (secret) throw new CliError("confirm", `The text looks like ${secret.kind === "cashu" ? "a Cashu token (money anyone who reads it can take)" : "a secret (a seed or a private key)"}; edit with --force if you mean to`, { kind: secret.kind });
		}
		const mentions = mentionsFor(text, list(params, "mentions"), group);
		const wait = oneOf(params, "wait", ["none", "sent"], "none");
		const linkId = `group:${group.id}`;
		const before = (await node(ctx).getMessage(linkId, messageId))?.edit?.seq ?? 0;
		const result = await node(ctx).editMessage({
			linkId,
			messageId,
			text,
			...mentions.length ? { mentions } : {}
		});
		if (result.error) throw editRefused(await messageOf(ctx, linkId, messageId), messageId, "group", result.error, result.refused);
		const message = await node(ctx).getMessage(linkId, messageId);
		const edits = message?.edit?.seq ?? 0;
		if (edits === before) return {
			group: group.id,
			messageId,
			edits,
			sent: false,
			edges: 0,
			unchanged: true
		};
		const edges = !edits ? 0 : wait === "sent" ? await waitForGroupFrame(ctx, group.id, messageId, edits, num(params, "timeout", 30, {
			min: 1,
			max: 3600
		}) * 1e3) : node(ctx).groupTaken({
			groupId: group.id,
			messageId,
			edit: edits
		});
		return {
			group: group.id,
			messageId,
			edits,
			sent: edges > 0 || !!message && !message.edit?.pending,
			edges
		};
	},
	async "group.react"(ctx, params) {
		const group = groupOf(ctx, params);
		return {
			group: group.id,
			...await react(ctx, `group:${group.id}`, params)
		};
	},
	/**
	* WISP 902 · Group Mesh § Typing: `chat.typing` in a private group, said on the edges that are open (`reached`: to
	* how many members), with the same kinds, status rules, 6 s hold and `for`. A community does not carry typing yet.
	*/
	async "group.typing"(ctx, params) {
		const group = groupOf(ctx, params);
		if (group.profile !== "mesh") throw new CliError("unavailable", "A community does not carry typing yet: only a private group does");
		const typing = !bool(params, "stop");
		const { kind, status } = typingWord(params, typing);
		const word = {
			...kind !== "typing" ? { kind } : {},
			...status ? { status } : {}
		};
		const seconds = params.for === void 0 ? 0 : num(params, "for", 0, {
			min: 1,
			max: 600
		});
		if (!typing && seconds) throw new CliError("bad_request", "for keeps typing on: not with stop");
		if (typing && group.status !== "active") throw new CliError("bad_request", "You are not in this group");
		const target = { groupId: group.id };
		endTyping(ctx, target, false);
		sayTyping(ctx, target, typing, word);
		const until = seconds ? Date.now() + seconds * 1e3 : null;
		const kept = seconds ? keepTyping(ctx, target, seconds * 1e3, word) : null;
		const reached = (s) => (s.groups.find((g) => g.id === group.id) ?? group).members.filter((m) => !m.me && m.online && !m.viaHub).length;
		if (kept && ctx.mode === "one-shot") await keepOneShot(ctx, target, kept, (s) => reached(s) > 0);
		return {
			group: group.id,
			typing,
			...typing ? { kind } : {},
			...status ? { status } : {},
			reached: reached(state(ctx)),
			sendTyping: state(ctx).settings.sendTyping !== false,
			...until ? { until } : {}
		};
	},
	async "group.leave"(ctx, params) {
		const group = groupOf(ctx, params);
		if (!bool(params, "yes")) throw new CliError("confirm", "Leaving a group deletes its history and files on this device; pass yes (--yes) to go on");
		const { admin } = await node(ctx).leaveGroup({ groupId: group.id });
		const next = admin ? group.members.find((m) => m.key === admin) : void 0;
		return {
			left: group.id,
			...admin ? { admin: {
				key: admin,
				name: next?.nick ?? null
			} } : {}
		};
	},
	async "group.forget"(ctx, params) {
		const group = groupOf(ctx, params);
		if (!bool(params, "yes")) throw new CliError("confirm", "Forgetting a group deletes its history on this device; pass yes (--yes) to go on");
		await node(ctx).forgetGroup({ groupId: group.id });
		return { forgotten: group.id };
	},
	async "group.accept"(ctx, params) {
		const group = groupOf(ctx, params);
		await node(ctx).acceptGroupInvitation({ groupId: group.id });
		return { group: group.id };
	},
	async "group.decline"(ctx, params) {
		const group = groupOf(ctx, params);
		await node(ctx).declineGroupInvitation({ groupId: group.id });
		return { group: group.id };
	},
	async "events.replay"(ctx, params) {
		return {
			events: ctx.hub.replay(num(params, "since", 0)),
			lastSeq: ctx.hub.lastSeq
		};
	},
	async "daemon.stop"(ctx) {
		if (ctx.mode !== "daemon" || !ctx.stop) throw new CliError("unavailable", "No daemon runs this profile");
		setTimeout(() => ctx.stop(), 10);
		return {
			stopping: true,
			pid: process.pid
		};
	},
	async "engine.call"(ctx, params) {
		const method = str(params, "method", true);
		if (!ENGINE_METHODS.includes(method) && !ENGINE_READS.includes(method)) throw new CliError("not_found", `The engine has no call ${method}`);
		const raw = params.params;
		if (raw !== void 0 && (raw === null || typeof raw !== "object" || Array.isArray(raw))) throw new CliError("bad_request", "params must be an object");
		let args = raw;
		if (args && "confirmedReal" in args && !bool(params, "confirmReal")) throw new CliError("confirm", `${method} spends real money: pass --confirm-real (confirmReal: true over the socket) to confirm it`);
		if (method === "getMessages") return node(ctx).getMessages(str(args ?? {}, "linkId", true));
		if (method === "getState") return state(ctx);
		if (method === "setActiveLink") inviteShown.get(ctx)?.();
		const target = node(ctx)[method];
		if (typeof target !== "function") throw new CliError("not_found", `The engine has no call ${method}`);
		if (args === void 0) args = void 0;
		return await target.call(node(ctx), args) ?? null;
	}
};
/** Reacts to a message of a chat or a group (`group:<id>`): `emoji`, or `remove` for "" (WISP 400 § Reactions). */
async function react(ctx, linkId, params) {
	const messageId = str(params, "message", true);
	const removed = bool(params, "remove");
	const emoji = removed ? "" : str(params, "emoji");
	if (!removed && !emoji) throw new CliError("usage", "Give one emoji, or --remove to take yours back");
	const result = await node(ctx).react({
		linkId,
		messageId,
		emoji: emoji ?? ""
	});
	if (result.error) throw new CliError(result.refused ? "refused" : /not in this chat|No reaction of yours/.test(result.error) ? "not_found" : "bad_request", result.error);
	return {
		messageId,
		emoji: emoji || null,
		removed
	};
}
/**
* What `typing` says: a kind, and a status a bot writes. The contact's app would cut a long status and drop one with
* a link; here that is an error instead, so the bot learns what the contact will (not) see.
*/
function typingWord(params, typing) {
	const kind = oneOf(params, "kind", TYPING_KINDS, "typing");
	const raw = str(params, "status");
	if (!typing && (params.kind !== void 0 || raw !== void 0)) throw new CliError("bad_request", "kind and status go with a start, not with stop");
	if (raw === void 0) return { kind };
	const oneLine = raw.replace(/\s+/g, " ").trim();
	if ([...oneLine].length > 40) throw new CliError("bad_request", `status: at most 40 characters`);
	const status = sanitizeTypingStatus(oneLine);
	if (!status) throw new CliError("bad_request", "status: plain text, with no link or markup");
	return {
		kind,
		status
	};
}
/**
* A group message the engine did not send, by what a bot can do about it: a `--reply` to a message this group does not
* have is `not_found` (exit 3), as `group react`, `group edit` and `pin` answer for one; out of the group (removed,
* left, a forked history) is `refused`: it will not go later either. Anything else may go on a later try
* (`unavailable`): the epoch's key is still on its way. All three were `unavailable` (exit 1) before.
*/
function groupSendRefused(error) {
	if (/not in this chat|cannot be replied to/.test(error)) return new CliError("not_found", error);
	if (/^You (were removed from|left|are no longer in) this group$|Membership changes are halted/.test(error)) return new CliError("refused", error);
	return new CliError("unavailable", error);
}
/**
* A chat command given a group's id, prefix or name: `not_found` that says it is a group, with the group command that
* takes it (`react` on a group, where `group react` is meant). A name no chat and no group has stays the chat's error.
*/
function notAGroup(ctx, params, chat, command, rest) {
	try {
		return chat();
	} catch (error) {
		if (!(error instanceof CliError) || error.code !== "not_found") throw error;
		const ref = str(params, "chat", true);
		let group;
		try {
			group = findGroup(state(ctx).groups, ref);
		} catch {
			throw error;
		}
		const shown = /^[\w.:-]+$/.test(ref) ? ref : JSON.stringify(ref);
		throw new CliError("not_found", `${JSON.stringify(ref)} is a group, not a chat: ghostly ${command} ${shown}${rest ? ` ${rest}` : ""}`, { group: group.id });
	}
}
/** The chat a chat command with a group twin names: a group's name says so, with `command`, the twin (see `notAGroup`). */
function chatNotGroup(ctx, params, command, rest = "") {
	return notAGroup(ctx, params, () => chatOf(ctx, params), command, rest);
}
/**
* An edit the engine refused. A message that is not in the chat or group at all is `not_found` (exit 3), naming the id
* to give, as `button update` and `task update` do; before, a mistyped or lost id read "Only your own text messages
* can be edited" (`refused`, exit 1), as if the message were someone else's.
*/
function editRefused(message, ref, where, error, refused) {
	if (refused && !message) return new CliError("not_found", `No message ${JSON.stringify(ref)} in this ${where}: give the messageId ${where === "group" ? "group send" : "send"} printed`);
	return new CliError(refused ? "refused" : "unavailable", error);
}
/**
* A page of a chat's or a group's history. Without `after` only that page is read from the store (the newest, or those
* before `before`), so a long chat's is as quick as a short one's; with `after` the whole history is read and cut.
*/
async function historyOf(ctx, chat, params, json = messageJson) {
	if (params.after !== void 0 && params.after !== null) return history(await node(ctx).getMessages(chat), params, json);
	const limit = num(params, "limit", 50, {
		min: 1,
		max: 1e4,
		whole: true
	});
	const before = params.before ?? void 0;
	if (before !== void 0 && typeof before !== "number" && typeof before !== "string") throw new CliError("bad_request", "before must be a timestamp or a message id");
	const page = await node(ctx).messagePage({
		linkId: chat,
		limit,
		before
	}).catch((error) => {
		throw error instanceof Error && error.message === `No message ${before}` ? new CliError("not_found", error.message) : error;
	});
	return {
		messages: page.messages.map((m) => json(m)),
		more: page.more
	};
}
function history(messages, params, json = messageJson) {
	const limit = num(params, "limit", 50, {
		min: 1,
		max: 1e4,
		whole: true
	});
	const before = params.before;
	const after = params.after;
	const sorted = messages.slice().sort((a, b) => a.timestamp - b.timestamp);
	const bound = (value, side) => {
		if (value === void 0 || value === null) return;
		if (typeof value === "number") return (m) => side === "before" ? m.timestamp < value : m.timestamp > value;
		if (typeof value !== "string") throw new CliError("bad_request", `${side} must be a timestamp or a message id`);
		const index = sorted.findIndex((m) => m.id === value);
		if (index === -1) throw new CliError("not_found", `No message ${value}`);
		return (_, at) => side === "before" ? at < index : at > index;
	};
	const bounds = [bound(before, "before"), bound(after, "after")].filter((b) => b !== void 0);
	const list = sorted.filter((m, at) => bounds.every((within) => within(m, at)));
	const more = after !== void 0 && after !== null ? list.length > limit : list.length > limit;
	return {
		messages: (after !== void 0 && after !== null ? list.slice(0, limit) : list.slice(-limit)).map((m) => json(m)),
		more
	};
}
var API_METHODS = Object.keys(METHODS);
/** Runs one method of the API: one the table lists itself (`constructor`, which every object has, is none). */
async function callApi(ctx, method, params = {}) {
	const run = Object.hasOwn(METHODS, method) ? METHODS[method] : void 0;
	if (!run) throw new CliError("not_found", `No method ${method}`);
	if (params === null || typeof params !== "object" || Array.isArray(params)) throw new CliError("bad_request", "params must be an object");
	return run(ctx, await withStoredIds(ctx, params));
}
//#endregion
export { flushCardUpdates as _, hideStateSecrets as a, paymentJson as c, nodeLocalFetch as d, chatJson as f, resumeHolds as g, groupMessageJson as h, groupSendRefused as i, reportAppFrames as l, groupJson as m, SETTABLE as n, mentionsFor as o, chatMessageJson as p, callApi as r, redactSettings as s, API_METHODS as t, servedApps as u };

//# sourceMappingURL=api-CnHy2xkB.js.map