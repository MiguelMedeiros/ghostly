import { Dl as toBase64Url, El as randomBytes, ao as checkStatusCard, eo as STATUS_CARD_LIMITS, hi as BUTTONS_CAPABILITY, no as buttonLabelClash } from "./src-dfGE33hw.js";
import { t as CliError } from "./errors-B-zMxbcd.js";
import { _ as str, d as messageOf, f as node, i as chatOrGroup, m as oneOf, n as bool, p as num } from "./apiKit-BeSsbld5.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { createBase58check } from "@scure/base";
import { wordlist } from "@scure/bip39/wordlists/english.js";
//#region ../../apps/ui/src/lib/parse/secrets.ts
var WORD_INDEX = new Map(wordlist.map((word, index) => [word, index]));
var MNEMONIC_LENGTHS = [
	12,
	15,
	18,
	21,
	24
];
/** Checksums tried per message at most: a 16 KiB run of seed words stays a few milliseconds. */
var CHECKSUM_BUDGET = 4096;
var NSEC = /\bnsec1[02-9ac-hj-np-z]{58}(?![02-9ac-hj-np-z])/i;
var EXTENDED_PRIVATE = /\b[xtyzuvYZUV]prv[1-9A-HJ-NP-Za-km-z]{100,}/;
var WIF = /\b[59KLc][1-9A-HJ-NP-Za-km-z]{50,51}\b/g;
var HEX_SECRET = /\b(?:0x)?(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{64})\b/g;
var SECRET_CONTEXT = /priv(?:ate)?[\s_-]*key|secret|seed|mnemonic|nsec|xprv|\bwif\b|recovery|passphrase/i;
/** How far from a 64-hex string a word like "seed" still counts as saying what it is. */
var CONTEXT_REACH = 48;
var CASHU_TOKEN = /\bcashu([AB])([A-Za-z0-9_\-+/]{20,}={0,2})/g;
/**
* Characters that take no room on screen: format characters (zero-width space, soft hyphen, word joiner, the joiners,
* direction marks), control characters that are not white space, variation selectors, the grapheme joiner and the
* Hangul fillers. A page, a PDF or a terminal puts some of them into long strings as places to break a line.
*/
var INVISIBLE = /(?![\t\n\v\f\r\x85])[\p{Cc}\p{Cf}]|\u034f|[\u115f\u1160\u3164\uffa0]|[\ufe00-\ufe0f]|[\u{e0100}-\u{e01ef}]/gu;
var base58check = createBase58check(sha256);
/**
* The first secret in `text`, keys and seeds before ecash; null for anything else. The text is read as it is and as
* it reads without its invisible characters: a key with one inside is whole again once the reader takes it out.
*/
function findSecret(text) {
	const visible = text.replace(INVISIBLE, "");
	const readings = visible === text ? [text] : [text, visible];
	if (readings.some(hasMnemonic)) return { kind: "mnemonic" };
	if (readings.some((reading) => NSEC.test(reading))) return { kind: "nsec" };
	if (readings.some((reading) => EXTENDED_PRIVATE.test(reading) || hasWif(reading))) return { kind: "bitcoin-key" };
	if (readings.some(hasHexSecret)) return { kind: "hex-key" };
	const tokens = readings.map(findCashu);
	return tokens.find((found) => found?.kind === "cashu" && found.amount !== null) ?? tokens.find((found) => found) ?? null;
}
/**
* 12 to 24 words in a row from the English BIP39 list whose checksum holds, anywhere in the text; or a message that
* is nothing but 12, 15, 18, 21 or 24 of those words (a seed with one word mistyped is still most of a seed). Prose
* breaks a run at once: "the", "a", "is", "to", "and", "of" and "I" are not on the list.
*
* One word said over and over is not a seed, though one in 16 such runs passes a 12-word checksum ("word" does): a
* window of a single word never counts, and a window mostly of one word ("abandon … about") counts only when that
* word does not go on past it on either side.
*/
function hasMnemonic(text) {
	const tokens = text.toLowerCase().match(/[a-z]+/g);
	if (!tokens || tokens.length < 12) return false;
	let budget = CHECKSUM_BUDGET;
	let run = [];
	const seedLike = (start, length) => {
		const window = run.slice(start, start + length);
		const counts = /* @__PURE__ */ new Map();
		for (const word of window) counts.set(word, (counts.get(word) ?? 0) + 1);
		if (counts.size === 1) return false;
		const [most, times] = [...counts].reduce((a, b) => b[1] > a[1] ? b : a);
		if (times > length / 2 && (run[start - 1] === most || run[start + length] === most)) return false;
		return checksumHolds(window);
	};
	const check = () => {
		if (run.length >= 12) {
			for (const length of MNEMONIC_LENGTHS) for (let start = 0; start + length <= run.length && budget > 0; start++, budget--) if (seedLike(start, length)) return true;
			if (run.length === tokens.length && MNEMONIC_LENGTHS.includes(run.length) && new Set(run).size > 1) return true;
		}
		run = [];
		return false;
	};
	for (const token of tokens) {
		const index = WORD_INDEX.get(token);
		if (index !== void 0) run.push(index);
		else if (check()) return true;
	}
	return check();
}
/** BIP39: the words' 11-bit indices are the entropy followed by the first bits of its SHA-256. */
function checksumHolds(indices) {
	const bits = indices.length * 11, checksumBits = bits / 33, entropyBytes = (bits - checksumBits) / 8;
	const bytes = new Uint8Array(Math.ceil(bits / 8));
	indices.forEach((index, i) => {
		for (let b = 0; b < 11; b++) if (index & 1 << 10 - b) {
			const at = i * 11 + b;
			bytes[at >> 3] |= 128 >> (at & 7);
		}
	});
	return sha256(bytes.subarray(0, entropyBytes))[0] >> 8 - checksumBits === bytes[entropyBytes] >> 8 - checksumBits;
}
/** A WIF private key: base58check with version 0x80 (mainnet) or 0xef (testnet), 32 bytes and an optional 0x01. */
function hasWif(text) {
	for (const [candidate] of text.matchAll(WIF)) try {
		const payload = base58check.decode(candidate);
		if ((payload[0] === 128 || payload[0] === 239) && (payload.length === 33 || payload.length === 34 && payload[33] === 1)) return true;
	} catch {}
	return false;
}
/** 64 or 128 hex digits with "private key", "secret", "seed" or the like close by. A bare hash is not asked about. */
function hasHexSecret(text) {
	for (const match of text.matchAll(HEX_SECRET)) {
		const before = text.slice(Math.max(0, match.index - CONTEXT_REACH), match.index);
		const after = text.slice(match.index + match[0].length, match.index + match[0].length + CONTEXT_REACH);
		if (SECRET_CONTEXT.test(before) || SECRET_CONTEXT.test(after)) return true;
	}
	return false;
}
/** Every Cashu token in the text, with their amounts added up when all of them decode and share one unit. */
function findCashu(text) {
	const tokens = [...text.matchAll(CASHU_TOKEN)].map(([, version, body]) => decodeCashu(version, body));
	if (!tokens.length) return null;
	const unit = tokens.find((token) => token)?.unit ?? "sat";
	return {
		kind: "cashu",
		amount: tokens.every((token) => token && token.unit === unit) ? tokens.reduce((sum, token) => sum + token.amount, 0) : null,
		unit
	};
}
/** What a Cashu token is worth, read from the token itself (NUT-00): nothing is asked of the mint. */
function decodeCashu(version, body) {
	try {
		const bytes = fromBase64(body);
		if (version === "A") {
			const token = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
			return total(token.token?.flatMap((entry) => entry.proofs ?? []).map((proof) => proof.amount), token.unit);
		}
		const token = decodeCbor(bytes);
		return total(token?.t?.flatMap((entry) => entry.p ?? []).map((proof) => proof.a), token?.u);
	} catch {
		return null;
	}
}
function total(amounts, unit) {
	if (!amounts?.length || !amounts.every((a) => Number.isSafeInteger(a) && a >= 0)) return null;
	const amount = amounts.reduce((sum, a) => sum + a, 0);
	return Number.isSafeInteger(amount) ? {
		amount,
		unit: typeof unit === "string" && unit ? unit : "sat"
	} : null;
}
function fromBase64(text) {
	const standard = text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
	const binary = atob(standard + "=".repeat((4 - standard.length % 4) % 4));
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
/** Enough CBOR (RFC 8949) for a cashuB token: definite lengths, integers, bytes, text, arrays, maps, tags, simple values. */
function decodeCbor(bytes) {
	let at = 0, depth = 0;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const length = (info) => {
		if (info < 24) return info;
		const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
		if (!size || at + size > bytes.length) throw new Error("cbor");
		let value = 0;
		for (let i = 0; i < size; i++) value = value * 256 + bytes[at + i];
		at += size;
		return value;
	};
	const item = () => {
		if (at >= bytes.length || ++depth > 32) throw new Error("cbor");
		const head = bytes[at++], major = head >> 5, info = head & 31;
		try {
			if (major === 7) {
				if (info === 20) return false;
				if (info === 21) return true;
				if (info === 22 || info === 23) return null;
				if (info === 25) {
					at += 2;
					return NaN;
				}
				if (info === 26) {
					at += 4;
					return view.getFloat32(at - 4);
				}
				if (info === 27) {
					at += 8;
					return view.getFloat64(at - 8);
				}
				throw new Error("cbor");
			}
			const n = length(info);
			switch (major) {
				case 0: return n;
				case 1: return -1 - n;
				case 2:
				case 3: {
					if (at + n > bytes.length) throw new Error("cbor");
					const slice = bytes.subarray(at, at += n);
					return major === 2 ? slice : new TextDecoder("utf-8", { fatal: true }).decode(slice);
				}
				case 4:
					if (n > bytes.length - at) throw new Error("cbor");
					return Array.from({ length: n }, item);
				case 5: {
					if (n > bytes.length - at) throw new Error("cbor");
					const map = Object.create(null);
					for (let i = 0; i < n; i++) {
						const key = item();
						map[String(key)] = item();
					}
					return map;
				}
				default: return item();
			}
		} finally {
			depth--;
		}
	};
	return item();
}
//#endregion
//#region src/waits.ts
var DELIVERY_RANK = {
	sending: 0,
	waiting: 1,
	queued: 1,
	held: 2,
	sent: 2,
	delivered: 3
};
/** Waits until the contact confirmed the latest edit of one of my messages (it is no longer pending). */
async function waitForEdit(ctx, chat, messageId, ms) {
	const until = Date.now() + ms;
	for (;;) {
		const message = await node(ctx).getMessage(chat, messageId);
		if (!message) throw new CliError("not_found", `No message ${messageId} in this chat`);
		if (!message.edit?.pending) return message;
		if (Date.now() >= until) throw new CliError("timeout", `Timed out after ${Math.round(ms / 1e3)} s: the contact has not confirmed the edit yet. It goes by itself once the chat is live and the contact's app shows edits, while this profile is online`, {
			messageId,
			edits: message.edit.seq
		});
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}
/**
* Waits until an edge took my group message, or its edit number `edit` (WISP 902: a group has no receipts, so this is
* as far as the author sees): a member's edge in a private group, an edge to one of my hubs in a community.
*/
async function waitForGroupFrame(ctx, groupId, messageId, edit, ms) {
	const until = Date.now() + ms;
	for (;;) {
		const taken = node(ctx).groupTaken({
			groupId,
			messageId,
			...edit ? { edit } : {}
		});
		if (taken > 0) return taken;
		if (Date.now() >= until) throw new CliError("timeout", `Timed out after ${Math.round(ms / 1e3)} s: no member's edge took it yet. It stays in the group and goes when one opens, while this profile is online`, {
			messageId,
			...edit ? { edits: edit } : {}
		});
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}
/** Waits until a message of mine reached `target` (`sent`: on its way to the contact; `delivered`: acknowledged). */
async function waitForMessage(ctx, chat, messageId, target, ms) {
	const want = DELIVERY_RANK[target];
	const look = (message) => {
		if (!message) return void 0;
		const delivery = message.delivery ?? "sent";
		if (delivery === "failed") throw new CliError("engine", message.deliveryError ?? "The message could not be sent", {
			messageId,
			delivery
		});
		return (DELIVERY_RANK[delivery] ?? 0) >= want ? message : void 0;
	};
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error, message) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			off();
			if (error) reject(error);
			else resolve(message);
		};
		const check = (last = false) => void node(ctx).getMessage(chat, messageId).then((message) => {
			try {
				const done = look(message);
				if (done) finish(null, done);
				else if (last) finish(new CliError("timeout", `Timed out after ${Math.round(ms / 1e3)} s: the message is ${message?.delivery ?? "not sent yet"} and still goes by itself while this profile is online`, {
					messageId,
					delivery: message?.delivery ?? null
				}));
			} catch (error) {
				finish(error);
			}
		}, finish);
		const timer = setTimeout(() => check(true), ms);
		const off = ctx.hub.onEvent((event) => {
			if (event.chat === chat && (event.messageId === messageId || event.message?.id === messageId)) check();
		});
		check();
	});
}
//#endregion
//#region src/buttons.ts
/**
* `--button id:Label` (again for each, 1 to 6), `--style id=primary|neutral|danger`, `--once` and `--id`, as the
* method's parameters: `buttons` and `buttonsId`. Nothing when no `--button` is given. The label may hold colons: the
* id ends at the first one. Two labels that read the same (ignoring case and spaces at the ends), or a label that is
* another button's id, are a usage error here; other bounds (ids, labels, how many) are the card's, checked when it is sent.
*/
function buttonsOf(options) {
	const given = Array.isArray(options.button) ? options.button : [];
	if (!given.length) {
		for (const flag of [
			"style",
			"once",
			"id"
		]) if (options[flag] !== void 0) throw new CliError("usage", `--${flag} goes with --button id:Label`);
		return;
	}
	const buttons = given.map((value) => {
		const colon = value.indexOf(":");
		if (colon < 1 || colon === value.length - 1) throw new CliError("usage", `--button takes id:Label, like yes:Yes, not ${JSON.stringify(value)}`);
		return {
			id: value.slice(0, colon),
			label: value.slice(colon + 1).trim()
		};
	});
	const clash = buttonLabelClash(buttons);
	if (clash) {
		const [at, other] = [JSON.stringify(given[clash.at]), JSON.stringify(given[clash.with])];
		throw new CliError("usage", clash.kind === "label" ? `--button ${at} repeats the label of --button ${other} (ignoring case and spaces): a typed answer could not tell them apart` : `--button ${at} has a label that is the id of --button ${other}: a typed answer could not tell them apart`);
	}
	for (const value of Array.isArray(options.style) ? options.style : []) {
		const eq = value.indexOf("=");
		const button = eq > 0 ? buttons.find((b) => b.id === value.slice(0, eq)) : void 0;
		if (!button) throw new CliError("usage", `--style takes id=primary|neutral|danger for one of the buttons, not ${JSON.stringify(value)}`);
		button.style = value.slice(eq + 1);
	}
	if (options.once === true) for (const button of buttons) button.once = true;
	return {
		buttons,
		...options.id !== void 0 && { buttonsId: String(options.id) }
	};
}
/** A buttons card checked by the sender's rule, or a `bad_request` that says what is wrong. */
function checked(card) {
	const result = checkStatusCard(card);
	if ("error" in result) throw new CliError("bad_request", `Buttons: ${result.error}`, { card });
	return result.card;
}
/**
* The card a send's `buttons` (and `buttonsId`) make, or undefined when it names none. `buttons` is a list of
* `{id, label, style?, once?}`; the id of the question is made up (`ask-…`) unless given.
*/
function buttonsCard(params) {
	const buttons = params.buttons;
	if (buttons === void 0 || buttons === null) {
		if (params.buttonsId !== void 0) throw new CliError("bad_request", "buttonsId goes with buttons");
		return;
	}
	if (!Array.isArray(buttons)) throw new CliError("bad_request", "buttons must be a list of {id, label, style?, once?}");
	return checked({
		kind: "buttons",
		id: str(params, "buttonsId") ?? `ask-${toBase64Url(randomBytes(6))}`,
		buttons
	});
}
/** Whether a 1:1 contact's app shows and presses buttons: null until its app said what it offers. */
function pressable(link) {
	const peer = link.sessionOffers?.peer;
	return peer ? peer.includes(BUTTONS_CAPABILITY) : null;
}
/** The message of mine with buttons that `button update` names, by its id here (or the id both sides know). */
function buttonsMessage(message, ref, group) {
	if (!message) throw new CliError("not_found", `No message ${JSON.stringify(ref)} of yours in this ${group ? "group" : "chat"}: the messageId send gave`);
	if (message.card?.kind !== "buttons") throw new CliError("bad_request", "That message has no buttons: send one with send --button id:Label");
	return message;
}
/**
* `button update`: the answer shown on a question's buttons (`chosen`), the buttons closed (`close`), or a new text
* (`text`), by editing the message with the same buttons. What is not given stays as it was.
*/
async function updateButtons(ctx, params) {
	const target = chatOrGroup(ctx, str(params, "chat", true));
	const ref = str(params, "message", true);
	const chosen = str(params, "chosen");
	const close = bool(params, "close");
	const newText = str(params, "text");
	if (chosen === void 0 && !close && newText === void 0) throw new CliError("bad_request", "Nothing to update: give chosen, close or text");
	if (newText !== void 0 && !bool(params, "force")) {
		const secret = findSecret(newText);
		if (secret) throw new CliError("confirm", `The text looks like ${secret.kind === "cashu" ? "a Cashu token (money anyone who reads it can take)" : "a secret (a seed or a private key)"}; update with --force if you mean to`, { kind: secret.kind });
	}
	const message = buttonsMessage(await messageOf(ctx, target.linkId, ref, (m) => m.sender === "me"), ref, target.group);
	if ((message.edit?.seq ?? 0) >= STATUS_CARD_LIMITS.edits) throw new CliError("refused", `This message took ${STATUS_CARD_LIMITS.edits} updates, the most one takes: ask again with a new send`, {
		messageId: message.id,
		edits: message.edit.seq
	});
	const before = message.card;
	if (chosen !== void 0 && !before.buttons.some((b) => b.id === chosen)) throw new CliError("bad_request", `That message has no button ${JSON.stringify(chosen)}; its buttons: ${before.buttons.map((b) => b.id).join(", ")}`, { card: before });
	const card = checked({
		...before,
		...chosen !== void 0 && { chosen },
		...(close || before.closed) && { closed: true }
	});
	const text = newText ?? message.text;
	const wait = oneOf(params, "wait", target.group ? ["none", "sent"] : ["none", "confirmed"], "none");
	const ms = num(params, "timeout", 30, {
		min: 1,
		max: 3600
	}) * 1e3;
	const result = await node(ctx).editMessage({
		linkId: target.linkId,
		messageId: message.id,
		text,
		card
	});
	if (result.error) throw new CliError(result.refused ? "refused" : "unavailable", result.error);
	let edited = await node(ctx).getMessage(target.linkId, message.id);
	if (wait === "confirmed" && edited?.edit?.pending) edited = await waitForEdit(ctx, target.linkId, message.id, ms);
	const edges = wait === "sent" && edited?.edit ? await waitForGroupFrame(ctx, target.id, message.id, edited.edit.seq, ms) : void 0;
	return {
		[target.group ? "group" : "chat"]: target.id,
		buttons: card.id,
		messageId: message.id,
		card,
		edits: edited?.edit?.seq ?? 0,
		...target.group ? { ...edges !== void 0 && { edges } } : { confirmed: !!edited && !edited.edit?.pending }
	};
}
/**
* `button press`: the other side of a question, as the app's tap: a press on a button of someone else's message, by
* its id here (or the id both sides know). The engine sends a reply whose text is the button's label, and refuses what
* an app would: a button the message does not have, closed buttons, a second answer past `once`, a second press
* within a second. A one-shot in a chat waits until the press went out, as `send` does.
*/
async function pressButton(ctx, params) {
	const target = chatOrGroup(ctx, str(params, "chat", true));
	const ref = str(params, "message", true);
	const buttonId = str(params, "button", true);
	const where = target.group ? "group" : "chat";
	const message = await messageOf(ctx, target.linkId, ref, (m) => m.sender !== "me");
	if (!message) throw new CliError("not_found", `No message ${JSON.stringify(ref)} from someone else in this ${where}: the id its event or history gave`);
	if (message.card?.kind !== "buttons") throw new CliError("bad_request", "That message has no buttons");
	const button = message.card.buttons.find((b) => b.id === buttonId);
	if (!button) throw new CliError("not_found", `That message has no button ${JSON.stringify(buttonId)}; its buttons: ${message.card.buttons.map((b) => b.id).join(", ")}`);
	const wait = target.group ? oneOf(params, "wait", ["none", "sent"], "none") : oneOf(params, "wait", [
		"none",
		"sent",
		"delivered"
	], ctx.mode === "one-shot" ? "sent" : "none");
	const ms = num(params, "timeout", 30, {
		min: 1,
		max: 3600
	}) * 1e3;
	const result = await node(ctx).pressButton({
		linkId: target.linkId,
		messageId: message.id,
		buttonId
	});
	if (result.error) throw new CliError(result.refused ? "refused" : "unavailable", result.error, result.paced ? { paced: true } : void 0);
	const replyId = result.messageId ?? null;
	const answer = {
		[where]: target.id,
		messageId: message.id,
		button: button.id,
		label: button.label,
		replyId
	};
	if (!replyId) return answer;
	if (target.group) {
		const edges = wait === "sent" ? await waitForGroupFrame(ctx, target.id, replyId, void 0, ms) : node(ctx).groupTaken({
			groupId: target.id,
			messageId: replyId
		});
		return {
			...answer,
			edges
		};
	}
	const reply = wait === "none" ? await node(ctx).getMessage(target.linkId, replyId) : await waitForMessage(ctx, target.linkId, replyId, wait, ms);
	return {
		...answer,
		delivery: reply?.delivery ?? null
	};
}
var BUTTON_METHODS = {
	/** WISP 406 · Message Buttons: a press on a button of someone else's message, as the app's tap. */
	"button.press": pressButton,
	/** WISP 406 · Message Buttons: the answer chosen on a question of mine, its buttons closed, or its text changed. */
	"button.update": updateButtons
};
//#endregion
export { waitForEdit as a, findSecret as c, pressable as i, buttonsCard as n, waitForGroupFrame as o, buttonsOf as r, waitForMessage as s, BUTTON_METHODS as t };

//# sourceMappingURL=buttons-CpT1VIOt.js.map