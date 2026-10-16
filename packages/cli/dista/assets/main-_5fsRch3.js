import { $a as RUN_RESULTS, Qa as PR_STATES, Xa as ITEM_STATES, Za as PR_CHECKS, eo as STATUS_CARD_LIMITS, io as cardUrl, nr as GROUP_FILE_LIMITS } from "./src-dfGE33hw.js";
import { a as SECRET_RESULTS, i as ENGINE_READS, r as ENGINE_METHODS, t as turnRef } from "./turnRefs-aJfhdKIb.js";
import { i as localFileError, n as EXIT, r as asCliError, t as CliError } from "./errors-B-zMxbcd.js";
import { t as CONTACT_KEY } from "./apiKit-BeSsbld5.js";
import { a as checkShownName, c as ghostlyHome, d as profileExists, f as profilePaths, i as checkProfileName, l as listProfiles, o as createProfile, p as selectProfile, s as currentProfile, u as lockOwner } from "./profiles-CI6Z0_ww.js";
import { n as ownSocket } from "./privateFolder-Bk9C9oFv.js";
import { accessSync, constants, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { format } from "node:util";
var package_default = {
	name: "@ghostlytools/cli",
	version: "1.3.2",
	type: "module",
	description: "Ghostly for bots and terminals: the app's own engine, headless on Node, behind a daemon and a `ghostly` command with JSON output.",
	license: "MIT",
	repository: {
		"type": "git",
		"url": "git+https://github.com/MiguelMedeiros/ghostly.git",
		"directory": "packages/cli"
	},
	homepage: "https://ghostly.tools/cli",
	bugs: "https://github.com/MiguelMedeiros/ghostly/issues",
	publishConfig: { "access": "public" },
	bin: { "ghostly": "./dist/ghostly.mjs" },
	files: [
		"dist",
		"examples",
		"README.md",
		"SKILL.md"
	],
	engines: { "node": ">=22.12" },
	scripts: {
		"build": "vite build",
		"typecheck": "tsc --noEmit -p tsconfig.json",
		"test": "vitest run"
	},
	dependencies: {
		"@arkade-os/sdk": "0.4.78",
		"@atproto/jwk-webcrypto": "^0.3.4",
		"@atproto/oauth-client": "^0.8.9",
		"@bitcoindevkit/bdk-wallet-web": "0.3.0",
		"@bitcoinerlab/descriptors-scure": "^3.2.0",
		"@cashu/cashu-ts": "^4.11.0",
		"@fedimint/core": "0.0.0-canary-eea6a3c98909fa8e736d6dadb1f1243fd3322b27",
		"@fedimint/fedimint-client-wasm-bundler": "0.0.0-canary-eea6a3c98909fa8e736d6dadb1f1243fd3322b27",
		"@fedimint/types": "0.0.0-canary-eea6a3c98909fa8e736d6dadb1f1243fd3322b27",
		"@hyperswarm/dht-relay": "0.4.3",
		"@noble/ciphers": "^2.4.0",
		"@noble/curves": "^2.4.0",
		"@noble/hashes": "2.4.0",
		"@scure/base": "2.4.0",
		"@scure/bip32": "^2.4.0",
		"@scure/bip39": "2.4.0",
		"@scure/btc-signer": "2.4.1",
		"@secondts/bark": "0.25.0",
		"@serenity-kit/opaque": "1.1.0",
		"@synonymdev/pubky": "0.14.0",
		"@tetherto/wdk-wallet-evm": "1.0.0-beta.20",
		"b4a": "1.9.0",
		"bittorrent-dht": "11.0.12",
		"ethers": "6.17.0",
		"eventsource": "^5.1.2",
		"fake-indexeddb": "6.2.5",
		"hyperdht": "6.34.1",
		"keet-identity-key": "3.2.0",
		"mpg123-decoder": "1.0.3",
		"node-datachannel": "^0.33.4",
		"nostr-tools": "2.25.2",
		"opus-decoder": "0.7.12",
		"opusscript": "0.1.1"
	},
	devDependencies: {
		"@ghostly/browser": "*",
		"@ghostly/core": "*",
		"@ghostly/iroh-web": "*",
		"@types/node": "^26.6.4",
		"typescript": "^5.9.3",
		"vite": "^8.3.3",
		"vitest": "^5.0.3"
	}
};
//#endregion
//#region src/args.ts
/**
* Options every command takes. They may come anywhere on the line.
*/
var GLOBAL_OPTIONS = {
	profile: {
		type: "string",
		short: "p",
		description: "Profile to use (default: $GHOSTLY_PROFILE, then the current one)"
	},
	home: {
		type: "string",
		description: "Ghostly's folder (default: $GHOSTLY_HOME, then ~/.ghostly)"
	},
	pretty: {
		type: "boolean",
		description: "Indent the JSON output"
	},
	help: {
		type: "boolean",
		short: "h",
		description: "Show help"
	}
};
/**
* A small, strict parser: `--name value`, `--name=value`, `-x value`, boolean flags, repeatable lists, and `--`
* before positionals that start with a dash.
*
* The value of an option is taken as is even when it starts with `-` (base64url keys and seeds do one time in 64:
* the ghostly-cli lesson of #208). So is a positional that `idSlot` says takes an id, a key or a draft: there a word
* that starts with `-`, is longer than two characters and is no option of the command is the value (`--` starts one
* id in 4096; `-x` stays an option). Any other positional that starts with `-` is refused instead of sent: a
* mistyped flag must not reach a contact as text. Put `--` before a message that starts with a dash.
*/
function parseArgs(argv, spec, idSlot = () => false) {
	const all = {
		...GLOBAL_OPTIONS,
		...spec
	};
	const byShort = new Map(Object.entries(all).filter(([, s]) => s.short).map(([name, s]) => [s.short, name]));
	const isOption = (arg) => {
		if (!arg.startsWith("--")) return arg.length === 2 && byShort.has(arg.slice(1));
		const name = arg.slice(2).split("=")[0];
		return Object.hasOwn(all, name) || name.startsWith("no-") && all[name.slice(3)]?.type === "boolean";
	};
	const positionals = [];
	const options = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			positionals.push(...argv.slice(i + 1));
			break;
		}
		if (arg.startsWith("-") && arg.length > 2 && idSlot(positionals.length) && !isOption(arg)) {
			positionals.push(arg);
			continue;
		}
		if (arg.startsWith("--") || arg.startsWith("-") && arg.length === 2 && arg !== "-") {
			let name, inline;
			if (arg.startsWith("--")) {
				const eq = arg.indexOf("=");
				name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
				inline = eq === -1 ? void 0 : arg.slice(eq + 1);
			} else {
				const long = byShort.get(arg.slice(1));
				if (!long) throw new CliError("usage", `Unknown option ${arg}`);
				name = long;
			}
			if (name.startsWith("no-") && all[name.slice(3)]?.type === "boolean" && inline === void 0) {
				options[name.slice(3)] = false;
				continue;
			}
			const option = all[name];
			if (!option) throw new CliError("usage", `Unknown option --${name}`);
			if (option.type === "boolean") {
				if (inline !== void 0 && !["true", "false"].includes(inline)) throw new CliError("usage", `--${name} takes no value`);
				options[name] = inline === void 0 ? true : inline === "true";
				continue;
			}
			let value = inline;
			if (value === void 0 && option.optionalValue && !(i + 1 < argv.length && argv[i + 1] !== "" && Number.isFinite(Number(argv[i + 1])))) {
				options[name] = true;
				continue;
			}
			if (value === void 0) {
				if (i + 1 >= argv.length) throw new CliError("usage", `--${name} needs a value`);
				value = argv[++i];
			}
			if (option.type === "number") {
				const number = Number(value);
				if (!Number.isFinite(number)) throw new CliError("usage", `--${name} takes a number, not ${JSON.stringify(value)}`);
				options[name] = number;
			} else if (option.type === "list") options[name] = [...options[name] ?? [], value];
			else options[name] = value;
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") throw new CliError("usage", `Unknown option ${arg} (put -- before text that starts with a dash)`);
		positionals.push(arg);
	}
	return {
		positionals,
		options
	};
}
/** The global option a word names (`--profile`, `--profile=bot`, `-p`), else undefined. */
function globalOption(arg) {
	const name = globalName(arg);
	return name ? GLOBAL_OPTIONS[name] : void 0;
}
/** The name of the global option a word names (`profile` for `-p`, `pretty` for `--no-pretty`), else undefined. */
function globalName(arg) {
	const eq = arg.indexOf("=");
	const name = arg.startsWith("--") ? arg.slice(2, eq === -1 ? void 0 : eq) : arg.length === 2 && arg.startsWith("-") ? Object.entries(GLOBAL_OPTIONS).find(([, o]) => o.short === arg.slice(1))?.[0] : void 0;
	if (name && Object.hasOwn(GLOBAL_OPTIONS, name)) return name;
	const negated = name?.startsWith("no-") && eq === -1 ? name.slice(3) : void 0;
	return negated && GLOBAL_OPTIONS[negated]?.type === "boolean" ? negated : void 0;
}
/**
* Global options given before the command (`ghostly --profile bot send …`) move after it, where every command's
* parser reads them. Stops at `--` and at the first word that is not a global option. They go before the first word
* after the command's that starts with a dash (its first option, or the `--` that ends them), else at the end: never
* between an option and its value, which may itself be `--` (`--pretty profile set --name --`). One that takes a value
* and is the last word has none: a usage error.
*/
function liftGlobals(argv) {
	const lifted = [];
	let i = 0;
	while (i < argv.length) {
		const arg = argv[i];
		const eq = arg.indexOf("=");
		const option = globalOption(arg);
		if (!option || arg === "--") break;
		const takesValue = option.type !== "boolean" && eq === -1;
		if (takesValue && i + 1 >= argv.length) throw new CliError("usage", `--${globalName(arg)} needs a value`);
		lifted.push(...argv.slice(i, i + (takesValue ? 2 : 1)));
		i += takesValue ? 2 : 1;
	}
	const rest = argv.slice(i);
	const dash = rest[0] === "--" ? 0 : rest.findIndex((word, i) => i > 0 && word.startsWith("-"));
	return dash === -1 ? [...rest, ...lifted] : [
		...rest.slice(0, dash),
		...lifted,
		...rest.slice(dash)
	];
}
//#endregion
//#region src/client.ts
/**
* A connection to a profile's daemon over its socket (WISP 1100 § Local control API). `null` from `connectDaemon`
* means no daemon answers there: a one-shot command runs the profile itself.
*/
var DaemonClient = class {
	socket;
	nextId = 1;
	pending = /* @__PURE__ */ new Map();
	eventListener = null;
	closedListener = null;
	constructor(socket) {
		this.socket = socket;
		createInterface({
			input: socket,
			crlfDelay: Infinity
		}).on("line", (line) => {
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			if (message.event) {
				this.eventListener?.(message.event);
				return;
			}
			const waiting = typeof message.id === "number" ? this.pending.get(message.id) : void 0;
			if (!waiting) return;
			this.pending.delete(message.id);
			if (message.error) waiting.reject(new CliError(message.error.code, message.error.message, message.error.details));
			else waiting.resolve(message.result);
		});
		socket.on("close", () => {
			for (const waiting of this.pending.values()) waiting.reject(new CliError("unavailable", "The daemon went away"));
			this.pending.clear();
			this.closedListener?.();
		});
		socket.on("error", () => {});
	}
	call(method, params = {}) {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, {
				resolve,
				reject
			});
			this.socket.write(JSON.stringify({
				id,
				method,
				params
			}) + "\n");
		});
	}
	/** Events after `since` (replayed from the journal), then every new one, until the connection closes. */
	async subscribe(since, listener, onClosed) {
		this.eventListener = listener;
		this.closedListener = onClosed ?? null;
		return this.call("events.subscribe", since === void 0 ? {} : { since });
	}
	close() {
		this.socket.end();
	}
	/** Closes at once: what the daemon still sends is not read. */
	destroy() {
		this.socket.destroy();
	}
};
function connectDaemon(path, timeoutMs = 2e3) {
	if (!ownSocket(path)) return Promise.resolve(null);
	return new Promise((resolve) => {
		const socket = connect(path);
		const timer = setTimeout(() => {
			socket.destroy();
			resolve(null);
		}, timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timer);
			resolve(new DaemonClient(socket));
		});
		socket.once("error", () => {
			clearTimeout(timer);
			resolve(null);
		});
	});
}
//#endregion
//#region src/commands/shared.ts
var wait = {
	wait: {
		type: "string",
		description: "none, sent or delivered (default: none with a daemon, sent without)"
	},
	timeout: {
		type: "number",
		description: "Seconds to wait (default 30)"
	}
};
/** A group has no receipts: `sent` waits until an edge took the frame (a member's, or one of my hubs'). */
var groupWait = {
	wait: {
		type: "string",
		description: "none or sent: until an edge took it (default none)"
	},
	timeout: {
		type: "number",
		description: "Seconds to wait (default 30)"
	}
};
var net = {
	type: "string",
	description: "mainnet or testnet (default testnet)"
};
var card = {
	type: "string",
	description: "A Lightning card (its id; default: the network's default)"
};
var memo = {
	type: "string",
	description: "What it is for (up to 140 characters)"
};
var confirmReal = {
	type: "boolean",
	description: "Confirm a Mainnet (real money) spend"
};
/**
* A path as this command's working directory means it: the daemon runs elsewhere. "" (an unset variable in a script)
* names no file, never the current folder.
*/
function here(path) {
	if (path === "") throw new CliError("usage", "A path given as \"\" names no file");
	return typeof path === "string" ? resolve(path) : void 0;
}
/** A whole number of sats from the command line. */
function sats(value) {
	const n = Number(value);
	if (!value || !Number.isSafeInteger(n) || n <= 0) throw new CliError("usage", `Not an amount in sats: ${JSON.stringify(value)}`);
	return n;
}
/** `name=value` options as an object. */
function pairs(values) {
	if (!Array.isArray(values) || !values.length) return void 0;
	const out = {};
	for (const item of values) {
		const eq = item.indexOf("=");
		if (eq < 1) throw new CliError("usage", `--value takes name=value, not ${JSON.stringify(item)}`);
		out[item.slice(0, eq)] = item.slice(eq + 1);
	}
	return out;
}
var rate = {
	type: "number",
	description: "The audio's sample rate: 48000 (default), 24000, 16000, 12000 or 8000"
};
var force = {
	type: "boolean",
	description: "Send even if the text looks like a seed, a key or ecash"
};
var reply = {
	type: "string",
	description: "Reply to this message (its id, from history or an event)"
};
/** Buttons under a message (WISP 406 · Message Buttons): the text is the question. */
var buttonOptions = {
	button: {
		type: "list",
		description: "A button under the message, id:Label (again for each, 1 to 6; the label may hold colons). A press comes back as button.pressed"
	},
	style: {
		type: "list",
		description: "A button's look, id=primary, neutral or danger"
	},
	once: {
		type: "boolean",
		description: "Each person answers once: after a press their app offers the buttons no more"
	},
	id: {
		type: "string",
		description: "The question's id (default: made up, ask-…)"
	}
};
/** The group's entry link lets anyone join: printed only when asked for. */
var showSecret = { "show-secret": {
	type: "boolean",
	description: "Print the group's entry link (anyone who has it can join)"
} };
/** A pending chat's invite code lets whoever reads it take the chat: printed only when asked for. */
var showInvite = { "show-secret": {
	type: "boolean",
	description: "Print a pending chat's invite code (whoever has it can take the chat)"
} };
var secret = (options) => options["show-secret"] === true ? { showSecret: true } : {};
/**
* `--for` of the typing commands: the seconds it is kept on, 1 to 600, and never with `--stop`. A usage error (exit 2)
* that names the flag: before, the API's own check answered ("for must be a number from 1 to 600", exit 1).
*/
function typingFor(options) {
	const seconds = options.for;
	if (seconds === void 0) return void 0;
	if (typeof seconds !== "number" || !(seconds >= 1 && seconds <= 600)) throw new CliError("usage", `--for takes a number of seconds from 1 to 600, not ${JSON.stringify(seconds)}`);
	if (options.stop === true) throw new CliError("usage", "--for keeps it on: not with --stop");
	return seconds;
}
/**
* A time given as digits: milliseconds. Unix seconds (from 1e9, 2001, up to 1e11, which as milliseconds would be 1970
* to 1973) are refused with the milliseconds they mean: before, they were read as January 1970 without a word.
*/
function milliseconds(text, flag) {
	const ms = Number(text);
	if (ms >= 1e9 && ms < 1e11) throw new CliError("usage", `--${flag} takes milliseconds, not seconds: ${text}000`);
	return ms;
}
/**
* A history cursor: a time when it is all digits (`0` is from the start), else a message id. Message ids are never all
* digits (`me_…`, `peer_…`): before, fewer than 10 digits were read as an id ("No message 0").
*/
function cursor(value, flag) {
	if (value === void 0) return void 0;
	const text = String(value).trim();
	return /^\d+$/.test(text) ? milliseconds(text, flag) : text;
}
/**
* A status card's fields given as JSON (WISP 405 · Status Cards): inline (`{...}`), `-` for stdin, or a file's path. The
* flags given beside it win over it.
*/
function cardJson(value) {
	if (value === void 0) return {};
	const text = String(value).trim();
	let raw;
	try {
		raw = text.startsWith("{") ? text : readFileSync(text === "-" ? 0 : resolve(text), "utf8");
	} catch (error) {
		throw new CliError("usage", `--json takes a card as JSON, - for stdin, or a file: ${error instanceof Error ? error.message : String(error)}`);
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new CliError("usage", "--json is not valid JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CliError("usage", "--json is a JSON object of the card's fields");
	return parsed;
}
/** Options every status card command takes. */
var cardOptions = {
	json: {
		type: "string",
		description: "The card's fields as JSON: inline, - for stdin, or a file (flags win over it)"
	},
	link: {
		type: "list",
		description: "A link on the card: https://… or label=https://… (up to 4)"
	},
	text: {
		type: "string",
		description: "The text older apps show instead (default: written from the card)"
	},
	force: {
		type: "boolean",
		description: "Send even if the card's text looks like a seed, a key or ecash"
	}
};
/** `--link label=https://…` or a bare link, as a card's links. */
function cardLinks(values) {
	if (!Array.isArray(values) || !values.length) return void 0;
	return values.map((value) => {
		const eq = value.indexOf("=");
		return eq > 0 && !value.slice(0, eq).includes(":") ? {
			label: value.slice(0, eq),
			url: value.slice(eq + 1)
		} : { url: value };
	});
}
var listed = (words) => `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
/**
* `--item state:text` as a task's item. The word before the first colon is the state when it is one lowercase word (and
* the colon does not start `://`): one of `ITEM_STATES`, or a usage error that lists them, so `queued:Publishing` is
* refused rather than shown as that text. Anything else (`Step 2: build`, `Note: x`, a link, no colon) is the whole
* text, pending; `pending:fix: tests` keeps a colon after a lowercase word.
*/
function itemOf(value) {
	const colon = value.indexOf(":");
	const word = colon > 0 ? value.slice(0, colon) : "";
	if (!/^[a-z]+$/.test(word) || value.startsWith("//", colon + 1)) return {
		state: "pending",
		text: value
	};
	if (!ITEM_STATES.includes(word)) throw new CliError("usage", `--item takes state:text, and ${JSON.stringify(word)} is not a state: use ${listed(ITEM_STATES)} (pending:<text> keeps a colon in the text), not ${JSON.stringify(value)}`);
	return {
		state: word,
		text: value.slice(colon + 1).trim()
	};
}
/** `--progress`, `--left`: a percent, or a usage error that names the flag. */
function percent(options, flag) {
	const value = options[flag];
	if (value !== void 0 && !(typeof value === "number" && value >= 0 && value <= 100)) throw new CliError("usage", `--${flag} takes a percent from 0 to 100, not ${JSON.stringify(value)}`);
}
/** The flags of a task's pull request, and the field of `pr` each one gives. */
var PR_FLAGS = [
	["pr-url", "url"],
	["pr-number", "number"],
	["additions", "additions"],
	["deletions", "deletions"],
	["files", "files"],
	["pr-state", "state"],
	["pr-checks", "checks"]
];
/**
* A task's fields from its flags; what was not given is left out, so an update changes only what it names. What a flag
* got wrong is a usage error (exit 2) that names the flag: before, it reached the card's own check and failed as
* `bad_request` (exit 1) in the card's words ("Status card: done is at most total").
*/
function taskFields(options) {
	const fields = { ...cardJson(options.json) };
	const set = (key, value) => {
		if (value !== void 0) fields[key] = value;
	};
	set("id", options.id);
	set("title", options.title);
	set("status", options.status);
	percent(options, "progress");
	if (options.progress !== void 0 && options.steps !== void 0) throw new CliError("usage", "--progress or --steps, not both");
	set("progress", options.progress);
	set("step", options.step);
	set("branch", options.branch);
	if (options.steps !== void 0) {
		const match = /^(\d+)\s*\/\s*(\d+)$/.exec(String(options.steps));
		if (!match) throw new CliError("usage", `--steps takes done/total, like 2/5, not ${JSON.stringify(options.steps)}`);
		fields.done = Number(match[1]);
		fields.total = Number(match[2]);
		if (Number(match[2]) < 1 || Number(match[1]) > Number(match[2])) throw new CliError("usage", `--steps takes done/total with done at most total, like 2/5, not ${JSON.stringify(options.steps)}`);
	}
	if (options["pr-url"] !== void 0 && !cardUrl(options["pr-url"])) throw new CliError("usage", `--pr-url takes an https link of at most ${STATUS_CARD_LIMITS.url} characters, not ${JSON.stringify(options["pr-url"])}`);
	for (const [flag, words] of [["pr-state", PR_STATES], ["pr-checks", PR_CHECKS]]) if (options[flag] !== void 0 && !words.includes(options[flag])) throw new CliError("usage", `--${flag} takes ${listed(words)}, not ${JSON.stringify(options[flag])}`);
	const pr = {};
	for (const [flag, key] of PR_FLAGS) if (options[flag] !== void 0) pr[key] = options[flag];
	if (Object.keys(pr).length) fields.pr = {
		...fields.pr && typeof fields.pr === "object" ? fields.pr : {},
		...pr
	};
	if (Array.isArray(options.item) && options.item.length) fields.items = options.item.map(itemOf);
	if (Array.isArray(options.tag) && options.tag.length > STATUS_CARD_LIMITS.tags) throw new CliError("usage", `--tag is given at most ${STATUS_CARD_LIMITS.tags} times, not ${options.tag.length}`);
	if (Array.isArray(options.tag) && options.tag.length) fields.tags = options.tag;
	set("parent", options.parent);
	const links = cardLinks(options.link);
	if (links) fields.links = links;
	return fields;
}
/**
* The fields a new card cannot go without, given as a flag or in `--json`: a usage error (exit 2) that names the
* flags. Before, a missing `--title` reached the card's own check and failed as `bad_request` (exit 1) with
* "Status card: title is text".
*/
function needs(card, fields, usage) {
	const missing = fields.filter(([key]) => typeof card[key] !== "string" || !card[key].trim()).map(([, flag]) => `--${flag}`);
	if (missing.length) throw new CliError("usage", `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} needed: ghostly ${usage}`);
	return card;
}
/**
* A new task's pull request goes by its link: `--pr-state` and the like without `--pr-url` (or `pr.url` in `--json`)
* are a usage error that names them. An update's card may have the link already, so only a send asks.
*/
function prLinked(card, options, usage) {
	const given = PR_FLAGS.filter(([flag]) => options[flag] !== void 0).map(([flag]) => `--${flag}`);
	if (!given.length || card.pr.url !== void 0) return card;
	throw new CliError("usage", `${given.join(" and ")} ${given.length > 1 ? "go" : "goes"} with --pr-url: ghostly ${usage}`);
}
/**
* A usage card says how much is left: `--left`, or `--used` with `--limit`, as flags or in `--json`. The one that is
* missing is a usage error that names the flag.
*/
function quota(card, usage) {
	const used = card.used !== void 0;
	if (used !== (card.limit !== void 0)) throw new CliError("usage", `--${used ? "used" : "limit"} goes with --${used ? "limit" : "used"}: ghostly ${usage}`);
	if (card.left === void 0 && !used) throw new CliError("usage", `--left is needed (or --used with --limit): ghostly ${usage}`);
	return card;
}
/** A time a command names: milliseconds, or a date the JavaScript Date reads (`2026-09-30T01:00:00Z`). */
function cardTime(value, flag) {
	if (value === void 0) return void 0;
	const text = String(value).trim();
	const ms = /^\d+$/.test(text) ? milliseconds(text, flag) : Date.parse(text);
	if (!Number.isSafeInteger(ms) || ms <= 0) throw new CliError("usage", `--${flag} takes a time in milliseconds or a date like 2026-09-30T01:00:00Z, not ${JSON.stringify(value)}`);
	return ms;
}
/** `--run ok`, `--run failed:"CI flaked"`: a run of a routine, recorded as its last. */
function runOf(value) {
	if (value === void 0) return void 0;
	const text = String(value), colon = text.indexOf(":");
	const result = colon === -1 ? text : text.slice(0, colon), summary = colon === -1 ? "" : text.slice(colon + 1).trim();
	if (!RUN_RESULTS.includes(result)) throw new CliError("usage", `--run takes ok, failed or skipped, and :a summary after it if you like, not ${JSON.stringify(value)}`);
	return {
		result,
		...summary && { summary }
	};
}
/** A routine's fields from its flags; what was not given is left out. */
function routineFields(options) {
	const fields = { ...cardJson(options.json) };
	for (const key of [
		"id",
		"name",
		"schedule",
		"cron",
		"state"
	]) if (options[key] !== void 0) fields[key] = options[key];
	const next = cardTime(options.next, "next");
	if (next !== void 0) fields.nextRunAt = next;
	const links = cardLinks(options.link);
	if (links) fields.links = links;
	return fields;
}
/** Options a routine command takes, beside `cardOptions`. */
var routineOptions = {
	name: {
		type: "string",
		description: "What the routine is (120 characters)"
	},
	schedule: {
		type: "string",
		description: "When it runs, as people say it: \"every day 01:00\" (80 characters)"
	},
	cron: {
		type: "string",
		description: "Its cron line, shown beside the schedule (never run)"
	},
	state: {
		type: "string",
		description: "active (default on send) or paused"
	},
	next: {
		type: "string",
		description: "Its next run: milliseconds or a date like 2026-09-30T01:00:00Z"
	},
	run: {
		type: "string",
		description: "Record a run now: ok, failed or skipped, with :a summary if you like (it becomes the last run)"
	},
	...cardOptions
};
/** Options a task command takes, beside `cardOptions`. */
var taskOptions = {
	title: {
		type: "string",
		description: "What the task is (120 characters)"
	},
	status: {
		type: "string",
		description: "queued, running (default on send), blocked, done, failed or cancelled"
	},
	progress: {
		type: "number",
		description: "Percent done, 0 to 100"
	},
	steps: {
		type: "string",
		description: "Steps done of total, like 2/5 (progress is worked out from them)"
	},
	step: {
		type: "string",
		description: "What it is doing now (200 characters)"
	},
	item: {
		type: "list",
		description: "A step or log line, state:text with state pending, running, done, failed or skipped (text alone: pending). A lowercase word before the first colon must be one of them; pending:fix: x keeps the colon. The list replaces the card's (up to 20)"
	},
	branch: {
		type: "string",
		description: "The branch it works on"
	},
	"pr-url": {
		type: "string",
		description: "The pull request's https link"
	},
	"pr-number": {
		type: "number",
		description: "The pull request's number"
	},
	additions: {
		type: "number",
		description: "Lines the pull request adds"
	},
	deletions: {
		type: "number",
		description: "Lines the pull request removes"
	},
	files: {
		type: "number",
		description: "Files the pull request changes"
	},
	"pr-state": {
		type: "string",
		description: "Where the pull request stands: draft, open (ready for review), merged or closed"
	},
	"pr-checks": {
		type: "string",
		description: "The pull request's checks: passing, failing or pending"
	},
	tag: {
		type: "list",
		description: "A short label, like an area or a repository (24 characters); up to 3. An update's tags replace the card's: give all of them"
	},
	parent: {
		type: "string",
		description: "The id of the task of yours in this chat that this one is a part of"
	},
	...cardOptions
};
/**
* `--also week=80` or `--also week=80@2026-10-10T00:00:00Z`: another window of a usage card, its percent left and, after
* `@`, when it resets.
*/
function usageWindowOf(value) {
	const match = /^([^=]+)=(\d+(?:\.\d+)?)(?:@(.+))?$/.exec(value.trim());
	if (!match) throw new CliError("usage", `--also takes window=percent or window=percent@time, like week=80@2026-10-10T00:00:00Z, not ${JSON.stringify(value)}`);
	const resetsAt = cardTime(match[3], "also");
	return {
		window: match[1].trim(),
		left: Number(match[2]),
		...resetsAt !== void 0 && { resetsAt }
	};
}
/** A usage card's fields from its flags (WISP 405 § Usage); `--json` gives any of them, the flags win over it. */
function usageFields(options) {
	const fields = { ...cardJson(options.json) };
	percent(options, "left");
	if (options.left !== void 0 && (options.used !== void 0 || options.limit !== void 0)) throw new CliError("usage", "--left or --used with --limit, not both");
	for (const key of [
		"id",
		"left",
		"used",
		"limit",
		"label",
		"account",
		"window"
	]) if (options[key] !== void 0) fields[key] = options[key];
	const resets = cardTime(options.resets, "resets");
	if (resets !== void 0) fields.resetsAt = resets;
	if (Array.isArray(options.also) && options.also.length) fields.windows = options.also.map(usageWindowOf);
	return fields;
}
/** Options `usage send` takes. */
var usageOptions = {
	left: {
		type: "number",
		description: "Percent of the quota left, 0 to 100"
	},
	used: {
		type: "number",
		description: "How much is used, with --limit (instead of --left; the percent is worked out)"
	},
	limit: {
		type: "number",
		description: "The quota, with --used"
	},
	label: {
		type: "string",
		description: "What the quota is of, like Claude (24 characters)"
	},
	account: {
		type: "string",
		description: "Which of your accounts it is, short (24 characters)"
	},
	window: {
		type: "string",
		description: "The quota's window, as people say it: \"5 h\", \"week\" (16 characters)"
	},
	resets: {
		type: "string",
		description: "When the window starts again: milliseconds or a date like 2026-10-07T18:00:00Z"
	},
	also: {
		type: "list",
		description: "Another window, window=percent[@time], like week=80@2026-10-10T00:00:00Z (up to 3; shown in the details)"
	},
	id: {
		type: "string",
		description: "The card's id (default usage: one card per chat)"
	},
	all: {
		type: "boolean",
		description: "Every 1:1 chat with a contact, instead of one chat"
	},
	json: cardOptions.json,
	text: cardOptions.text,
	force: cardOptions.force
};
//#endregion
//#region src/commands/apps.ts
/** The key file a command signs with: always named, never a default, never on the command line itself. */
function keyFile(value, usage) {
	if (typeof value !== "string" || !value) throw new CliError("usage", `--key <file> is needed: ghostly ${usage}`);
	return value;
}
/** `app send`'s message: JSON on the command line, or `-` for stdin. */
function appData(value) {
	if (value === void 0) throw new CliError("usage", "The message is needed, as JSON or - for stdin: ghostly app send <chat> <ref|name> <json|->");
	const text = value.trim() === "-" ? readFileSync(0, "utf8") : value;
	try {
		return JSON.parse(text);
	} catch {
		throw new CliError("usage", "The message is not valid JSON: quote it for the shell, like '{\"k\":\"move\"}', or pass - and write it on stdin");
	}
}
var key = {
	type: "string",
	description: "The key file (made, owner-only, when it is missing)"
};
/**
* The publisher tools of WISP 1200 (Apps · Publishing): they run here, on files, with no profile or daemon. And the
* apps a profile serves as a bot (`app serve`, `app served`, `app unserve`), which are the profile's. One entry per
* command, in alphabetical order (test/commands.test.ts checks).
*/
var commands$8 = {
	"app close": {
		method: "app.close",
		usage: "app close <chat> <ref|name>",
		summary: "Close a served app in a chat: the contact's app hears it ended",
		args: ["chat", "ref"],
		params: (_, a) => ({
			chat: a.chat,
			ref: a.ref
		})
	},
	"app init": {
		method: "app.init",
		usage: "app init <dir> [--name <name>] [--title <title>] [--force]",
		summary: "Start an app (WISP 1200): a small working one in <dir>, its ghostly-app.json, an index.html that says hello to the contact and a README, ready for app publish",
		args: ["dir"],
		options: {
			name: {
				type: "string",
				description: "The app's name, lowercase letters, digits and hyphens (default: the folder's)"
			},
			title: {
				type: "string",
				description: "The title people see, up to 40 characters (default: from the name)"
			},
			force: {
				type: "boolean",
				description: "Replace the three files when they are there"
			}
		},
		run: async ({ options }, a) => (await import("./apps-XedcVFky.js")).initApp(a.dir, {
			name: options.name,
			title: options.title,
			force: options.force === true
		})
	},
	"app open": {
		method: "app.open",
		usage: "app open <chat> <ref|name> [--no-card]",
		summary: "Open a served app in a chat, as a bot (needs the daemon): the contact gets the app's card, unless their app is open there already, and the two sides can talk once both opened it",
		args: ["chat", "ref"],
		options: { "no-card": {
			type: "boolean",
			description: "Send no app card, only say the app is open"
		} },
		params: ({ options }, a) => ({
			chat: a.chat,
			ref: a.ref,
			noCard: options["no-card"] === true
		})
	},
	"app publish": {
		method: "app.publish",
		usage: "app publish <dir> --key <file> [--out <file>]",
		summary: "Bundle and sign an app (WISP 1200): <dir>/ghostly-app.json and every other file in <dir> become one .ghostlyapp, its sequence one more than the bundle at --out (default <dir>/app.ghostlyapp)",
		args: ["dir"],
		options: {
			key: {
				...key,
				description: "The publisher key file (made, owner-only, on first use; back it up)"
			},
			out: {
				type: "string",
				description: "Where the bundle goes (default <dir>/app.ghostlyapp); the bundle there is the version this one follows"
			},
			sequence: {
				type: "number",
				description: "This version's sequence, higher than the bundle at --out's (default: one more than it)"
			}
		},
		run: async ({ options }, a) => (await import("./apps-XedcVFky.js")).publishApp(a.dir, keyFile(options.key, "app publish <dir> --key <file> [--out <file>] [--sequence n]"), options.out, options.sequence)
	},
	"app revoke": {
		method: "app.revoke",
		usage: "app revoke <dir> --key <file> (--digest <digest>... | --up-to <sequence>) [--reason <text>] [--bundle <file>]",
		summary: "Revoke versions of your app (WISP 1200 · Revocation): a ghostly-revoke/1 statement signed with its publisher key, added to <dir>/ghostly-revoke.json",
		args: ["dir"],
		options: {
			key: {
				type: "string",
				description: "The app's publisher key file (never made here)"
			},
			digest: {
				type: "list",
				description: "A version's digest, base64url as app verify prints it (again for each, up to 64)"
			},
			"up-to": {
				type: "number",
				description: "Every version with this sequence or a lower one"
			},
			reason: {
				type: "string",
				description: "Why, one line of up to 200 characters, shown to people"
			},
			bundle: {
				type: "string",
				description: "The bundle naming the app (default <dir>/app.ghostlyapp)"
			}
		},
		run: async ({ options }, a) => (await import("./apps-XedcVFky.js")).revokeApp(a.dir, keyFile(options.key, "app revoke <dir> --key <file> (--digest <digest>... | --up-to <sequence>) [--reason <text>]"), {
			digests: options.digest,
			upTo: options["up-to"],
			reason: options.reason,
			bundle: options.bundle
		})
	},
	"app send": {
		method: "app.send",
		usage: "app send <chat> <ref|name> <json|->",
		summary: "Send one message of a served app's own protocol to the contact's app (needs the daemon, and both sides open): any JSON value up to 32 KiB, or - to read it from stdin; live only, never kept for later",
		args: [
			"chat",
			"ref",
			"data..."
		],
		params: (_, a) => ({
			chat: a.chat,
			ref: a.ref,
			data: appData(a.data)
		})
	},
	"app serve": {
		method: "app.serve",
		usage: "app serve <bundle|url> --grant chat [--grant name] [--url <url>]",
		summary: "Serve an app as a bot (WISP 1200): its signed .ghostlyapp is checked as a client would, and the profile speaks the app's messages in chats itself; each permission the app asks needs its --grant",
		args: ["bundle"],
		options: {
			grant: {
				type: "list",
				description: "A permission the app asks and you allow: chat (talk to the contact's app) or name (your name in that chat); again for each"
			},
			url: {
				type: "string",
				description: "Where a contact's app reads the bundle, for the card (default: the URL it was served from, else the manifest's first source)"
			}
		},
		params: ({ options }, a) => ({
			bundle: /^[a-z][a-z0-9+.-]*:\/\//i.test(a.bundle ?? "") ? a.bundle : here(a.bundle),
			grant: options.grant,
			url: options.url
		})
	},
	"app served": {
		method: "app.served",
		usage: "app served",
		summary: "The apps this profile serves as a bot, and whether apps/1 is offered to contacts now"
	},
	"app unserve": {
		method: "app.unserve",
		usage: "app unserve <ref|name>",
		summary: "Stop serving an app, by its reference or its name",
		args: ["ref"],
		params: (_, a) => ({ ref: a.ref })
	},
	"app verify": {
		method: "app.verify",
		usage: "app verify <bundle|url>",
		summary: "Check a .ghostlyapp as a client would, from a file or an https URL: its manifest and digest, or refused (exit 1) with the reason",
		args: ["bundle"],
		run: async (_, a) => (await import("./apps-XedcVFky.js")).verifyApp(a.bundle)
	},
	"store sign": {
		method: "store.sign",
		usage: "store sign <index> --key <file> [--out <dir>]",
		summary: "Sign a store index (WISP 1200 · Stores): writes ghostly-store.json, canonical, and ghostly-store.sig beside it or in --out",
		args: ["index"],
		options: {
			key: {
				...key,
				description: "The store key file (made, owner-only, when it is missing and the index names no key; keep it offline)"
			},
			out: {
				type: "string",
				description: "The folder to write ghostly-store.json and ghostly-store.sig in (default: the index's)"
			}
		},
		run: async ({ options }, a) => (await import("./apps-XedcVFky.js")).signStore(a.index, keyFile(options.key, "store sign <index> --key <file> [--out <dir>]"), options.out)
	}
};
//#endregion
//#region src/commands/calls.ts
/** Voice calls: one entry per command, in alphabetical order (test/commands.test.ts checks). */
var commands$7 = {
	"call answer": {
		method: "call.answer",
		usage: "call answer [<chat|call>] [--rate 48000]",
		summary: "Answer a call that rings (the only one, or the one named)",
		args: ["call...?"],
		options: { rate },
		params: ({ options }, a) => ({
			call: a.call,
			rate: options.rate
		})
	},
	"call auto": {
		method: "call.auto",
		usage: "call auto [on|off] [--from <chat>]... [--rate 48000]",
		summary: "Answer calls by themselves: from anyone, or the chats named (kept in the profile)",
		args: ["mode...?"],
		options: {
			from: {
				type: "list",
				description: "Only calls from this chat (again for more)"
			},
			rate
		},
		params: ({ options }, a) => {
			if (a.mode !== void 0 && a.mode !== "on" && a.mode !== "off") throw new CliError("usage", "ghostly call auto [on|off] [--from <chat>]... [--rate n]");
			if (a.mode !== "on" && (options.from !== void 0 || options.rate !== void 0)) throw new CliError("usage", "--from and --rate go with on: ghostly call auto on --from <chat>");
			if (a.mode === void 0) return {};
			return a.mode === "on" ? {
				on: true,
				from: options.from,
				rate: options.rate
			} : { on: false };
		}
	},
	"call flush": {
		method: "call.flush",
		usage: "call flush [<chat|call>]",
		summary: "Drop the audio queued and not played yet (barge-in)",
		args: ["call...?"],
		params: (_, a) => ({ call: a.call })
	},
	"call hangup": {
		method: "call.hangup",
		usage: "call hangup [<chat|call>]",
		summary: "Hang up, or decline a call that rings",
		args: ["call...?"],
		params: (_, a) => ({ call: a.call })
	},
	"call list": {
		method: "call.list",
		usage: "call list",
		summary: "Calls on now, their audio sockets, and auto-answer"
	},
	"call start": {
		method: "call.start",
		usage: "call start <chat> [--rate 48000]",
		summary: "Call a contact (voice); the result names the call's audio socket (daemon)",
		args: ["chat"],
		options: { rate },
		params: ({ options }, a) => ({
			chat: a.chat,
			rate: options.rate
		})
	}
};
//#endregion
//#region src/commands/chats.ts
var BUTTON_UPDATE = "button update <chat|group> <message> [--chosen <button>] [--close] [--text <text>] [--force] [--wait none|confirmed|sent] [--timeout s]";
/** Invites, chats and messages: one entry per command, in alphabetical order (test/commands.test.ts checks). */
var commands$6 = {
	"button press": {
		method: "button.press",
		usage: "button press <chat|group> <message> <button> [--wait none|sent|delivered] [--timeout s]",
		summary: "Press a button of someone else's message, as a tap in the app does (its id from the message's card)",
		args: [
			"chat",
			"message",
			"button"
		],
		options: {
			wait: {
				type: "string",
				description: "none, sent (a one-shot's default in a chat) or delivered; a group takes none or sent"
			},
			timeout: groupWait.timeout
		},
		params: ({ options }, a) => ({
			chat: a.chat,
			message: a.message,
			button: a.button,
			wait: options.wait,
			timeout: options.timeout
		})
	},
	"button update": {
		method: "button.update",
		usage: BUTTON_UPDATE,
		summary: "Show the answer on a message's buttons (--chosen), close them, or change its text (the messageId send --button gave)",
		args: ["chat", "message"],
		options: {
			chosen: {
				type: "string",
				description: "The button to show as the answer (its id)"
			},
			close: {
				type: "boolean",
				description: "Close the buttons: no more presses"
			},
			text: {
				type: "string",
				description: "A new text for the message (default: the one it has); people see it marked edited"
			},
			force,
			wait: {
				type: "string",
				description: "none (default), confirmed (a chat's contact took it) or sent (a group's edge took it)"
			},
			timeout: groupWait.timeout
		},
		params: ({ options }, a) => {
			if (!options.chosen && options.close !== true && !options.text) throw new CliError("usage", `Give --chosen, --close or --text: ghostly ${BUTTON_UPDATE}`);
			return {
				chat: a.chat,
				message: a.message,
				chosen: options.chosen,
				close: options.close === true,
				text: options.text,
				force: options.force === true,
				wait: options.wait,
				timeout: options.timeout
			};
		}
	},
	"chat connect": {
		method: "chat.connect",
		usage: "chat connect <chat>",
		summary: "Reconnect a chat now (ends a --hold)",
		args: ["chat"],
		params: (_, { chat }) => ({ chat })
	},
	"chat disconnect": {
		method: "chat.disconnect",
		usage: "chat disconnect <chat> [--hold <minutes>]",
		summary: "Close a chat's live session (the contact may redial; --hold keeps it on the DHT that long, 0 ends it)",
		args: ["chat"],
		options: { hold: {
			type: "number",
			description: "Stay off the direct link this many minutes (up to 10080): DHT only, taken back after"
		} },
		params: ({ options }, { chat }) => ({
			chat,
			hold: options.hold
		})
	},
	"chat history": {
		method: "chat.history",
		usage: "chat history <chat> [--limit n] [--before id|ms] [--after id|ms]",
		summary: "Messages, oldest first (a page)",
		args: ["chat"],
		options: {
			limit: {
				type: "number",
				description: "Messages per page (default 50)"
			},
			before: {
				type: "string",
				description: "Only before this message id or timestamp"
			},
			after: {
				type: "string",
				description: "Only after this message id or timestamp"
			}
		},
		params: ({ options }, { chat }) => ({
			chat,
			limit: options.limit,
			before: cursor(options.before, "before"),
			after: cursor(options.after, "after")
		})
	},
	"chat list": {
		method: "chat.list",
		usage: "chat list [--show-secret]",
		summary: "Chats, newest first (a pending invite code only with --show-secret)",
		options: showInvite,
		params: ({ options }) => secret(options)
	},
	"chat remove": {
		method: "chat.remove",
		usage: "chat remove <chat> --yes",
		summary: "Delete a chat, its keys and history on this device",
		args: ["chat"],
		options: { yes: {
			type: "boolean",
			description: "Confirm"
		} },
		params: ({ options }, { chat }) => ({
			chat,
			yes: options.yes === true
		})
	},
	"chat rename": {
		method: "chat.rename",
		usage: "chat rename <chat> <name...>",
		summary: "Name a chat on this side (empty: the contact's name)",
		args: ["chat", "name...?"],
		params: (_, { chat, name }) => ({
			chat,
			name: name ?? ""
		})
	},
	"chat show": {
		method: "chat.get",
		usage: "chat show <chat> [--show-secret]",
		summary: "One chat and its connection (its pending invite code only with --show-secret)",
		args: ["chat"],
		options: showInvite,
		params: ({ options }, { chat }) => ({
			chat,
			...secret(options)
		})
	},
	"chat transport": {
		method: "chat.transport",
		usage: "chat transport <chat> <auto|dht|webrtc|iroh|hyperdht>",
		summary: "Choose what carries a chat",
		args: ["chat", "transport"],
		params: (_, a) => ({
			chat: a.chat,
			transport: a.transport
		})
	},
	"chat verify": {
		method: "chat.verify",
		usage: "chat verify <chat> --code <code>",
		summary: "Mark a contact verified after comparing codes",
		args: ["chat"],
		options: { code: {
			type: "string",
			description: "The code the contact reads out"
		} },
		params: ({ options }, { chat }) => {
			if (typeof options.code !== "string" || !options.code.trim()) throw new CliError("usage", "--code is needed: ghostly chat verify <chat> --code <code>");
			return {
				chat,
				code: options.code
			};
		}
	},
	"chat wait": {
		method: "chat.wait",
		usage: "chat wait <chat> [--until live|text|paired] [--timeout s]",
		summary: "Wait for a chat to reach a state",
		args: ["chat"],
		options: {
			until: {
				type: "string",
				description: "live (default), text or paired"
			},
			timeout: {
				type: "number",
				description: "Seconds (default 60)"
			}
		},
		params: ({ options }, { chat }) => ({
			chat,
			until: options.until,
			timeout: options.timeout
		})
	},
	"forward": {
		method: "chat.forward",
		usage: "forward <chat|group> <message>... --to <chat|group>... [--force] [--wait none|sent] [--timeout s]",
		summary: "Forward messages (texts, files from the bytes here) to up to 5 chats and groups, as new messages of yours",
		args: ["chat", "message..."],
		options: {
			to: {
				type: "list",
				description: "A chat or a group to forward to (id, prefix or name; group:<id> for a group; a dash-leading id as it is); up to 5"
			},
			force: {
				type: "boolean",
				description: "Forward even if a text looks like a seed, a key or ecash"
			},
			wait: {
				type: "string",
				description: "none or sent: each text on its way (in a group, taken by an edge), each file's transfer done (default none)"
			},
			timeout: groupWait.timeout
		},
		params: ({ options }, a) => {
			if (!Array.isArray(options.to) || !options.to.length) throw new CliError("usage", "Missing --to: ghostly forward <chat|group> <message>... --to <chat|group>... [--force] [--wait none|sent] [--timeout s]");
			return {
				chat: a.chat,
				messages: (a.message ?? "").split(" ").filter(Boolean),
				to: options.to,
				force: options.force === true,
				wait: options.wait,
				timeout: options.timeout
			};
		}
	},
	"invite create": {
		method: "invite.create",
		usage: "invite create [--label <name>]",
		summary: "A new chat's ghostly1 invite and its link",
		options: { label: {
			type: "string",
			description: "A name for the chat on this side"
		} },
		params: ({ options }) => ({ label: options.label })
	},
	"invite join": {
		method: "invite.join",
		usage: "invite join <invite-or-link> [--label <name>]",
		summary: "Join a chat from its invite",
		args: ["invite"],
		options: { label: {
			type: "string",
			description: "A name for the chat on this side"
		} },
		params: ({ options }, { invite }) => ({
			invite,
			label: options.label
		})
	},
	"message delete": {
		method: "chat.delete",
		usage: "message delete <chat> <message>",
		summary: "Forget a message on this device (the contact keeps theirs)",
		args: ["chat", "message"],
		params: (_, a) => ({
			chat: a.chat,
			message: a.message
		})
	},
	"message details": {
		method: "chat.details",
		usage: "message details <chat> <message>",
		summary: "How a message travelled",
		args: ["chat", "message"],
		params: (_, a) => ({
			chat: a.chat,
			message: a.message
		})
	},
	"message retry": {
		method: "chat.retry",
		usage: "message retry <chat> <message>",
		summary: "Send a failed message again",
		args: ["chat", "message"],
		params: (_, a) => ({
			chat: a.chat,
			message: a.message
		})
	},
	"pin": {
		method: "chat.pin",
		usage: "pin <chat|group> <message> | --remove",
		summary: "Pin a message at the top of a chat or group (one per chat: it replaces the pinned one); --remove unpins",
		args: ["chat", "message...?"],
		options: { remove: {
			type: "boolean",
			description: "Unpin the chat's pinned message (it names no message)"
		} },
		params: ({ options }, a) => {
			if (a.message === void 0 && options.remove !== true) throw new CliError("usage", "Missing <message>: ghostly pin <chat|group> <message> | --remove");
			if (a.message?.includes(" ")) throw new CliError("usage", "Too many arguments: ghostly pin <chat|group> <message> | --remove");
			return {
				chat: a.chat,
				message: a.message,
				remove: options.remove === true
			};
		}
	},
	"react": {
		method: "chat.react",
		usage: "react <chat> <message> <emoji> [--remove]",
		summary: "React to a message with one emoji (it replaces yours); --remove takes yours back",
		args: [
			"chat",
			"message",
			"emoji...?"
		],
		options: { remove: {
			type: "boolean",
			description: "Take your reaction back"
		} },
		params: ({ options }, a) => ({
			chat: a.chat,
			message: a.message,
			emoji: a.emoji,
			remove: options.remove === true
		})
	},
	"routine send": {
		method: "routine.send",
		usage: "routine send <chat|group> --name <name> --schedule \"every day 01:00\" [--cron \"0 1 * * *\"] [--state active|paused] [--next <time>] [--run ok|failed|skipped[:summary]] [--link url]... [--id id] [--json json|-|file] [--force] [--wait none|sent|delivered] [--timeout s]",
		summary: "Send a routine card (something a bot runs on a schedule: its last run and the next) to a chat or group",
		args: ["chat"],
		options: {
			id: {
				type: "string",
				description: "The routine's id, kept across updates (default: made up)"
			},
			...routineOptions,
			...groupWait,
			wait: wait.wait
		},
		params: ({ options }, { chat }) => ({
			chat,
			card: needs(routineFields(options), [["name", "name"], ["schedule", "schedule"]], "routine send <chat|group> --name <name> --schedule \"every day 01:00\""),
			run: runOf(options.run),
			text: options.text,
			force: options.force === true,
			wait: options.wait,
			timeout: options.timeout
		})
	},
	"routine update": {
		method: "routine.update",
		usage: "routine update <chat|group> <routine> [--run ok|failed|skipped[:summary]] [--next <time>] [--state active|paused] [--schedule ...] [--json json|-|file] [--force] [--wait none|confirmed|sent] [--timeout s]",
		summary: "Update a routine card you sent: record a run, the next one, a pause (at most one update per 2.5 s; sooner ones merge)",
		args: ["chat", "routine"],
		options: {
			...routineOptions,
			wait: {
				type: "string",
				description: "none (default), confirmed (a chat's contact took it) or sent (a group's edge took it)"
			},
			timeout: groupWait.timeout
		},
		params: ({ options }, a) => ({
			chat: a.chat,
			routine: a.routine,
			card: routineFields(options),
			run: runOf(options.run),
			text: options.text,
			force: options.force === true,
			wait: options.wait,
			timeout: options.timeout
		})
	},
	"task send": {
		method: "task.send",
		usage: "task send <chat|group> --title <title> [--status s] [--progress n | --steps a/b] [--step \"...\"] [--item state:text]... [--pr-url url --pr-number n --additions n --deletions n --files n --pr-state s --pr-checks c] [--branch b] [--tag label]... [--parent task] [--link url]... [--id id] [--json json|-|file] [--force] [--wait none|sent|delivered] [--timeout s]",
		summary: "Send a task card (a bot's work: status, progress, its PR) to a chat or group; prints its id and message",
		args: ["chat"],
		options: {
			id: {
				type: "string",
				description: "The task's id, kept across updates (default: made up)"
			},
			...taskOptions,
			...groupWait,
			wait: wait.wait
		},
		params: ({ options }, { chat }) => ({
			chat,
			card: prLinked(needs(taskFields(options), [["title", "title"]], "task send <chat|group> --title <title>"), options, "task send <chat|group> --title <title> --pr-url <url>"),
			text: options.text,
			force: options.force === true,
			wait: options.wait,
			timeout: options.timeout
		})
	},
	"task update": {
		method: "task.update",
		usage: "task update <chat|group> <task> [--status s] [--progress n | --steps a/b] [--step \"...\"] [--item state:text]... [--pr-url ...] [--pr-state s] [--pr-checks c] [--tag label]... [--parent task] [--json json|-|file] [--force] [--wait none|confirmed|sent] [--timeout s]",
		summary: "Update a task card you sent: the fields given, merged over it (at most one update per 2.5 s; sooner ones merge)",
		args: ["chat", "task"],
		options: {
			...taskOptions,
			wait: {
				type: "string",
				description: "none (default), confirmed (a chat's contact took it) or sent (a group's edge took it)"
			},
			timeout: groupWait.timeout
		},
		params: ({ options }, a) => ({
			chat: a.chat,
			task: a.task,
			card: taskFields(options),
			text: options.text,
			force: options.force === true,
			wait: options.wait,
			timeout: options.timeout
		})
	},
	"typing": {
		method: "chat.typing",
		usage: "typing <chat> [--kind typing|recording|thinking] [--status \"<text>\"] [--for s] [--stop]",
		summary: "Show the contact you are writing, recording or thinking (live chats; it fades after 6 s unless said again, or kept with --for; a send or --stop ends it)",
		args: ["chat"],
		options: {
			stop: {
				type: "boolean",
				description: "Say you stopped"
			},
			kind: {
				type: "string",
				description: "typing (default), recording (a voice note) or thinking"
			},
			status: {
				type: "string",
				description: "A short line shown instead, e.g. \"Transcribing your audio…\" (40 characters, no links)"
			},
			for: {
				type: "number",
				description: "Keep saying it for this many seconds (up to 600), until a send or --stop"
			}
		},
		params: ({ options }, { chat }) => ({
			chat,
			stop: options.stop === true,
			kind: options.kind,
			status: options.status,
			for: typingFor(options)
		})
	},
	"usage send": {
		method: "usage.send",
		usage: "usage send [<chat|group>] [--all] --left <percent> [--window \"5 h\"] [--resets <time>] [--label Claude] [--account <name>] [--also week=80@<time>]... [--used n --limit n] [--id id] [--json json|-|file] [--force] [--wait none|sent] [--timeout s]",
		summary: "Say how much of your quota is left (a bot's usage card, one per chat, updated in place); --all for every 1:1 chat",
		args: ["chat?"],
		options: {
			...usageOptions,
			...groupWait
		},
		params: ({ options }, { chat }) => {
			if (!chat && options.all !== true) throw new CliError("usage", "Name a chat or group, or give --all: ghostly usage send <chat|--all> --left <percent>");
			return {
				chat,
				all: options.all === true,
				card: quota(usageFields(options), "usage send <chat|--all> --left <percent>"),
				text: options.text,
				force: options.force === true,
				wait: options.wait,
				timeout: options.timeout
			};
		}
	}
};
//#endregion
//#region src/commands/files.ts
/** Files: one entry per command, in alphabetical order (test/commands.test.ts checks). */
var commands$5 = {
	"file accept": {
		method: "file.action",
		usage: "file accept [<chat>] <file>",
		summary: "Take a file the contact offers, or download a group's file that did not come by itself (<chat> may be the group)",
		args: ["chat?", "file"],
		params: (_, a) => ({
			chat: a.chat,
			file: a.file,
			action: "accept"
		})
	},
	"file cancel": {
		method: "file.action",
		usage: "file cancel [<chat>] <file>",
		summary: "Cancel a transfer",
		args: ["chat?", "file"],
		params: (_, a) => ({
			chat: a.chat,
			file: a.file,
			action: "cancel"
		})
	},
	"file decline": {
		method: "file.action",
		usage: "file decline [<chat>] <file>",
		summary: "Refuse a file the contact offers",
		args: ["chat?", "file"],
		params: (_, a) => ({
			chat: a.chat,
			file: a.file,
			action: "decline"
		})
	},
	"file list": {
		method: "file.list",
		usage: "file list <chat|group>",
		summary: "A chat's or a group's files and their transfers",
		args: ["chat"],
		params: (_, { chat }) => ({ chat })
	},
	"file pause": {
		method: "file.action",
		usage: "file pause [<chat>] <file>",
		summary: "Pause a transfer",
		args: ["chat?", "file"],
		params: (_, a) => ({
			chat: a.chat,
			file: a.file,
			action: "pause"
		})
	},
	"file request": {
		method: "file.action",
		usage: "file request [<chat>] <file>",
		summary: "Ask again for a file that stopped arriving: it goes on from what is here (a group's file: asked of whoever holds it)",
		args: ["chat?", "file"],
		params: (_, a) => ({
			chat: a.chat,
			file: a.file,
			action: "request"
		})
	},
	"file resend": {
		method: "file.action",
		usage: "file resend [<chat>] <file>",
		summary: "Send again a file that stopped moving or failed: it goes on from what the contact holds",
		args: ["chat?", "file"],
		params: (_, a) => ({
			chat: a.chat,
			file: a.file,
			action: "resend"
		})
	},
	"file resume": {
		method: "file.action",
		usage: "file resume [<chat>] <file>",
		summary: "Resume a transfer",
		args: ["chat?", "file"],
		params: (_, a) => ({
			chat: a.chat,
			file: a.file,
			action: "resume"
		})
	},
	"file save": {
		method: "file.save",
		usage: "file save [<chat>] <file> [--dir d | --path p] [--force] [--wait [--timeout s]]",
		summary: "Write a received file to disk (never over a file without --force; --wait: once it is all here)",
		args: ["chat?", "file"],
		options: {
			dir: {
				type: "string",
				description: "Into this folder, under its own name"
			},
			path: {
				type: "string",
				description: "To this path"
			},
			force: {
				type: "boolean",
				description: "Replace a file there"
			},
			wait: {
				type: "boolean",
				description: "Wait for the transfer to finish first"
			},
			timeout: {
				type: "number",
				description: "Seconds --wait waits (default 300)"
			}
		},
		params: ({ options }, a) => {
			if (options.path === "") throw new CliError("usage", "--path needs a file");
			if (options.dir === "") throw new CliError("usage", "--dir needs a folder");
			if (options.dir !== void 0 && options.path !== void 0) throw new CliError("usage", "--path names the file: not with --dir");
			if (options.timeout !== void 0 && options.wait !== true) throw new CliError("usage", "--timeout is how long --wait waits: not without --wait");
			return {
				chat: a.chat,
				file: a.file,
				dir: options.path === void 0 ? here(options.dir ?? ".") : void 0,
				path: here(options.path),
				force: options.force === true,
				wait: options.wait === true ? true : void 0,
				timeout: options.timeout
			};
		}
	},
	"file send": {
		method: "file.send",
		usage: "file send <chat|group> <path> [--name n] [--mime t] [--voice [ms] [--peaks 0,40,…]] [--reply <message>]",
		summary: `Send a file (or, with --voice, a voice note), as a reply with --reply; to a group, every member's app fetches it (up to ${GROUP_FILE_LIMITS.maxBytes / 1024 / 1024} MiB)`,
		args: ["chat", "path"],
		options: {
			name: {
				type: "string",
				description: "The name the contact (or the group) sees"
			},
			mime: {
				type: "string",
				description: "Its type (default: from the extension)"
			},
			voice: {
				type: "number",
				optionalValue: true,
				description: "A voice note; its length in milliseconds (default: measured from the sound)"
			},
			peaks: {
				type: "string",
				description: "Loudness bars 0-255, comma-separated (default: measured from the sound)"
			},
			reply
		},
		params: ({ options }, a) => ({
			chat: a.chat,
			path: here(a.path),
			name: options.name,
			mime: options.mime,
			voice: options.voice,
			peaks: typeof options.peaks === "string" ? options.peaks.split(",") : void 0,
			reply: options.reply
		})
	},
	"file wait": {
		method: "file.wait",
		usage: "file wait [<chat>] <file> [--timeout s]",
		summary: "Wait until a transfer is done (exit 0) or failed (exit 1, with its error)",
		args: ["chat?", "file"],
		options: { timeout: {
			type: "number",
			description: "Seconds (default 300)"
		} },
		params: ({ options }, a) => ({
			chat: a.chat,
			file: a.file,
			timeout: options.timeout
		})
	}
};
//#endregion
//#region src/commands/general.ts
/** The profile's status, its picture, the event journal: one entry per command, in alphabetical order (test/commands.test.ts checks). */
var commands$4 = {
	"events": {
		method: "events.replay",
		usage: "events [--since seq]",
		summary: "Events the journal holds, without following",
		options: { since: {
			type: "number",
			description: "Only events after this seq"
		} },
		params: ({ options }) => ({ since: options.since ?? 0 })
	},
	"profile picture": {
		method: "profile.picture",
		usage: "profile picture <jpeg> | --clear",
		summary: "The picture contacts see (a square JPEG, 128 px is what the app sends)",
		args: ["path...?"],
		options: { clear: {
			type: "boolean",
			description: "Remove the picture"
		} },
		params: ({ options }, a) => {
			if (!a.path && options.clear !== true) throw new CliError("usage", "Missing <jpeg>: ghostly profile picture <jpeg> | --clear");
			if (a.path && options.clear === true) throw new CliError("usage", "--clear removes the picture: not with a <jpeg>");
			return {
				path: here(a.path || void 0),
				clear: options.clear === true
			};
		}
	},
	"status": {
		method: "status",
		usage: "status",
		summary: "The profile, its chats and whether a daemon runs it"
	}
};
//#endregion
//#region src/commands/groups.ts
/** Groups: one entry per command, in alphabetical order (test/commands.test.ts checks). */
var commands$3 = {
	"group accept": {
		method: "group.accept",
		usage: "group accept <group>",
		summary: "Accept an invitation to a group",
		args: ["group"],
		params: (_, { group }) => ({ group })
	},
	"group admin": {
		method: "group.admin",
		usage: "group admin <group> <member> [--show-secret]",
		summary: "Make a member the admin (admin)",
		args: ["group", "member"],
		options: showSecret,
		params: ({ options }, a) => ({
			group: a.group,
			member: a.member,
			...secret(options)
		})
	},
	"group create": {
		method: "group.create",
		usage: "group create <name...> [--mesh]",
		summary: "A community (a link anyone can open) or, with --mesh, a private group of up to 32",
		args: ["name..."],
		options: { mesh: {
			type: "boolean",
			description: "A private mesh of contacts instead of a community"
		} },
		params: ({ options }, { name }) => ({
			name,
			profile: options.mesh ? "mesh" : "community"
		})
	},
	"group decline": {
		method: "group.decline",
		usage: "group decline <group>",
		summary: "Decline an invitation to a group",
		args: ["group"],
		params: (_, { group }) => ({ group })
	},
	"group forget": {
		method: "group.forget",
		usage: "group forget <group> --yes",
		summary: "Leave and delete a group's history here",
		args: ["group"],
		options: { yes: {
			type: "boolean",
			description: "Confirm"
		} },
		params: ({ options }, { group }) => ({
			group,
			yes: options.yes === true
		})
	},
	"group history": {
		method: "group.history",
		usage: "group history <group> [--limit n] [--before id|ms] [--after id|ms]",
		summary: "A group's messages (a page)",
		args: ["group"],
		options: {
			limit: {
				type: "number",
				description: "Messages per page (default 50)"
			},
			before: {
				type: "string",
				description: "Only before this message id or timestamp"
			},
			after: {
				type: "string",
				description: "Only after this message id or timestamp"
			}
		},
		params: ({ options }, { group }) => ({
			group,
			limit: options.limit,
			before: cursor(options.before, "before"),
			after: cursor(options.after, "after")
		})
	},
	"group hub": {
		method: "group.hub",
		usage: "group hub <group> <member> [--pin | --exclude | --auto] [--show-secret]",
		summary: "Pin a member as a hub of a private group past 16 members, exclude one, or leave it to their app (admin)",
		args: ["group", "member"],
		options: {
			...showSecret,
			pin: {
				type: "boolean",
				description: "Always a hub while online"
			},
			exclude: {
				type: "boolean",
				description: "Never a hub"
			},
			auto: {
				type: "boolean",
				description: "A hub if their app stays online (the default)"
			}
		},
		params: ({ options }, a) => {
			const roles = [
				"pin",
				"exclude",
				"auto"
			].filter((role) => options[role] === true);
			if (roles.length > 1) throw new CliError("usage", "--pin, --exclude or --auto: one of them");
			return {
				group: a.group,
				member: a.member,
				role: roles[0] ?? "auto",
				...secret(options)
			};
		}
	},
	"group invite": {
		method: "group.invite",
		usage: "group invite <group> <chat> [--show-secret]",
		summary: "Invite a contact into a group you administer",
		args: ["group", "chat"],
		options: showSecret,
		params: ({ options }, a) => ({
			group: a.group,
			chat: a.chat,
			...secret(options)
		})
	},
	"group join": {
		method: "group.join",
		usage: "group join <link>",
		summary: "Join a group by its link",
		args: ["link"],
		params: (_, { link }) => ({ link })
	},
	"group leave": {
		method: "group.leave",
		usage: "group leave <group> --yes",
		summary: "Leave a group; its history and files go from this device",
		args: ["group"],
		options: { yes: {
			type: "boolean",
			description: "Confirm"
		} },
		params: ({ options }, { group }) => ({
			group,
			yes: options.yes === true
		})
	},
	"group link": {
		method: "group.link",
		usage: "group link <group> [--off] [--reset]",
		summary: "Turn the group's link on (--reset: a new one), or --off",
		args: ["group"],
		options: {
			off: {
				type: "boolean",
				description: "Turn the link off"
			},
			reset: {
				type: "boolean",
				description: "Replace it: the old link stops working"
			}
		},
		params: ({ options }, a) => {
			if (options.off === true && options.reset === true) throw new CliError("usage", "--off turns the link off: not with --reset");
			return {
				group: a.group,
				on: options.off !== true,
				reset: options.reset === true
			};
		}
	},
	"group list": {
		method: "group.list",
		usage: "group list [--show-secret]",
		summary: "Groups and invitations",
		options: showSecret,
		params: ({ options }) => secret(options)
	},
	"group picture": {
		method: "group.picture",
		usage: "group picture <group> <jpeg> | --clear",
		summary: "Set or clear the group's picture (admin; a square JPEG)",
		args: ["group", "path...?"],
		options: { clear: {
			type: "boolean",
			description: "Remove the picture"
		} },
		params: ({ options }, a) => {
			if (!a.path && options.clear !== true) throw new CliError("usage", "Missing <jpeg>: ghostly group picture <group> <jpeg> | --clear");
			if (a.path && options.clear === true) throw new CliError("usage", "--clear removes the picture: not with a <jpeg>");
			return {
				group: a.group,
				path: here(a.path || void 0),
				clear: options.clear === true
			};
		}
	},
	"group react": {
		method: "group.react",
		usage: "group react <group> <message> <emoji> [--remove]",
		summary: "React to a group's message with one emoji; --remove takes yours back",
		args: [
			"group",
			"message",
			"emoji...?"
		],
		options: { remove: {
			type: "boolean",
			description: "Take your reaction back"
		} },
		params: ({ options }, a) => ({
			group: a.group,
			message: a.message,
			emoji: a.emoji,
			remove: options.remove === true
		})
	},
	"group remove": {
		method: "group.remove",
		usage: "group remove <group> <member> [--show-secret]",
		summary: "Remove a member (admin)",
		args: ["group", "member"],
		options: showSecret,
		params: ({ options }, a) => ({
			group: a.group,
			member: a.member,
			...secret(options)
		})
	},
	"group rename": {
		method: "group.rename",
		usage: "group rename <group> <name...> [--show-secret]",
		summary: "Rename the group (admin; the picture stays)",
		args: ["group", "name..."],
		options: showSecret,
		params: ({ options }, a) => ({
			group: a.group,
			name: a.name,
			...secret(options)
		})
	},
	"group rotate": {
		method: "group.rotate",
		usage: "group rotate <group> [--show-secret]",
		summary: "A fresh group secret, members unchanged (admin)",
		args: ["group"],
		options: showSecret,
		params: ({ options }, a) => ({
			group: a.group,
			...secret(options)
		})
	},
	"group show": {
		method: "group.get",
		usage: "group show <group> [--show-secret]",
		summary: "A group and its members (its entry link only with --show-secret)",
		args: ["group"],
		options: showSecret,
		params: ({ options }, { group }) => ({
			group,
			...secret(options)
		})
	},
	"group typing": {
		method: "group.typing",
		usage: "group typing <group> [--kind typing|recording|thinking] [--status \"<text>\"] [--for s] [--stop]",
		summary: "Show the members you are writing, recording or thinking (private groups; it fades after 6 s unless said again, or kept with --for; a send or --stop ends it)",
		args: ["group"],
		options: {
			stop: {
				type: "boolean",
				description: "Say you stopped"
			},
			kind: {
				type: "string",
				description: "typing (default), recording (a voice note) or thinking"
			},
			status: {
				type: "string",
				description: "A short line shown instead, e.g. \"Reading the thread…\" (40 characters, no links)"
			},
			for: {
				type: "number",
				description: "Keep saying it for this many seconds (up to 600), until a send or --stop"
			}
		},
		params: ({ options }, { group }) => ({
			group,
			stop: options.stop === true,
			kind: options.kind,
			status: options.status,
			for: typingFor(options)
		})
	}
};
//#endregion
//#region src/commands/identities.ts
/** Identity proofs and x401 credentials: one entry per command, in alphabetical order (test/commands.test.ts checks). */
var commands$2 = {
	"identity cancel": {
		method: "identity.cancel",
		usage: "identity cancel <draft>",
		summary: "Drop a proof not finished",
		args: ["draft"],
		params: (_, a) => ({ draft: a.draft })
	},
	"identity complete": {
		method: "identity.complete",
		usage: "identity complete <draft> [--evidence-file f | --stdin]",
		summary: "Finish a proof: what the tool printed, or nothing for a published record",
		args: ["draft"],
		options: {
			"evidence-file": {
				type: "string",
				description: "The tool's output, from this file"
			},
			stdin: {
				type: "boolean",
				description: "The tool's output, from stdin"
			}
		},
		params: ({ options }, a) => {
			if (options["evidence-file"] !== void 0 && options.stdin === true) throw new CliError("usage", "--evidence-file or --stdin, not both");
			return {
				draft: a.draft,
				evidenceFile: here(options["evidence-file"]),
				stdin: options.stdin === true
			};
		}
	},
	"identity contact": {
		method: "identity.contact",
		usage: "identity contact <chat>",
		summary: "What a contact shared, as this device checked it",
		args: ["chat"],
		params: (_, a) => ({ chat: a.chat })
	},
	"identity list": {
		method: "identity.list",
		usage: "identity list",
		summary: "This profile's identity proofs"
	},
	"identity providers": {
		method: "identity.providers",
		usage: "identity providers",
		summary: "Kinds of identity proof, and which signers work here"
	},
	"identity recheck": {
		method: "identity.recheck",
		usage: "identity recheck <chat> <id>",
		summary: "Check a contact's proof again",
		args: ["chat", "id"],
		params: (_, a) => ({
			chat: a.chat,
			id: a.id
		})
	},
	"identity remove": {
		method: "identity.remove",
		usage: "identity remove <id>",
		summary: "Remove a proof: withdrawn from every chat, revoked",
		args: ["id"],
		params: (_, a) => ({ id: a.id })
	},
	"identity share": {
		method: "identity.share",
		usage: "identity share <chat> <id>",
		summary: "Show a proof to a contact",
		args: ["chat", "id"],
		params: (_, a) => ({
			chat: a.chat,
			id: a.id
		})
	},
	"identity withdraw": {
		method: "identity.withdraw",
		usage: "identity withdraw <chat> <id>",
		summary: "Withdraw a proof from a contact",
		args: ["chat", "id"],
		params: (_, a) => ({
			chat: a.chat,
			id: a.id
		})
	},
	"x401 credential add": {
		method: "x401.credential.add",
		usage: "x401 credential add <file|-> [--label <name>]",
		summary: "Keep an issued SD-JWT VC bound to a key from x401 key new (a file, or - for stdin)",
		args: ["file"],
		options: { label: {
			type: "string",
			description: "Your name for it, up to 80 characters on one line (default: its type)"
		} },
		params: ({ options }, a) => ({
			file: a.file === "-" ? "-" : here(a.file),
			label: options.label
		})
	},
	"x401 credential list": {
		method: "x401.credential.list",
		usage: "x401 credential list [--show-secret]",
		summary: "This profile's x401 credentials: issuer, type, claim paths",
		options: { "show-secret": {
			type: "boolean",
			description: "Print the claims' values too (a name, a document number...)"
		} },
		params: ({ options }) => secret(options)
	},
	"x401 credential remove": {
		method: "x401.credential.remove",
		usage: "x401 credential remove <id>",
		summary: "Remove a credential and its holder key",
		args: ["id"],
		params: (_, a) => ({ id: a.id })
	},
	"x401 key new": {
		method: "x401.key.new",
		usage: "x401 key new",
		summary: "A fresh P-256 holder key: its public JWK goes to the issuer (the 8 newest wait for a credential; past them, the oldest is dropped)"
	}
};
//#endregion
//#region src/commands/payments.ts
/** Wallets and payments: one entry per command, in alphabetical order (test/commands.test.ts checks). */
var commands$1 = {
	"chat accept": {
		method: "chat.accept",
		usage: "chat accept <chat> <method> [--off] [--networks mainnet,testnet]",
		summary: "Which ways of paying a chat takes",
		args: ["chat", "method"],
		options: {
			off: {
				type: "boolean",
				description: "Stop taking it"
			},
			networks: {
				type: "string",
				description: "Comma-separated networks it is taken on"
			}
		},
		params: ({ options }, a) => ({
			chat: a.chat,
			method: a.method,
			on: options.off !== true,
			networks: typeof options.networks === "string" ? options.networks.split(",").map((n) => n.trim()).filter(Boolean) : void 0
		})
	},
	"chat pay": {
		method: "chat.pay",
		usage: "chat pay <chat> <sats> [--memo t] [--network testnet] [--confirm-real]",
		summary: "Send ecash to a contact (Mainnet needs --confirm-real)",
		args: ["chat", "amount"],
		options: {
			memo,
			network: net,
			"confirm-real": confirmReal
		},
		params: ({ options }, a) => ({
			chat: a.chat,
			amount: sats(a.amount),
			memo: options.memo,
			network: options.network,
			confirmReal: options["confirm-real"] === true
		})
	},
	"chat pay-request": {
		method: "chat.payRequest",
		usage: "chat pay-request <chat> <payment> [--via lightning] [--max-fee sats] [--card <id>] [--confirm-real]",
		summary: "Pay a contact's request",
		args: ["chat", "payment"],
		options: {
			via: {
				type: "string",
				description: "lightning: pay its invoice instead of ecash"
			},
			"max-fee": {
				type: "number",
				description: "Refuse a fee above this"
			},
			card,
			"confirm-real": confirmReal
		},
		params: ({ options }, a) => ({
			chat: a.chat,
			payment: a.payment,
			via: options.via,
			maxFee: options["max-fee"],
			card: options.card,
			confirmReal: options["confirm-real"] === true
		})
	},
	"chat request": {
		method: "chat.request",
		usage: "chat request <chat> <sats> [--memo t] [--method m] [--rail cashu|lightning] [--network testnet] [--card <id>]",
		summary: "Ask a contact to pay",
		args: ["chat", "amount"],
		options: {
			memo,
			method: {
				type: "string",
				description: "cashu, arkade, usdt, bitcoin, spark, …"
			},
			rail: {
				type: "string",
				description: "cashu or lightning"
			},
			network: net,
			card
		},
		params: ({ options }, a) => ({
			chat: a.chat,
			amount: sats(a.amount),
			memo: options.memo,
			method: options.method,
			rail: options.rail,
			network: options.network,
			card: options.card
		})
	},
	"lightning default": {
		method: "lightning.default",
		usage: "lightning default <card> [--network testnet]",
		summary: "The Lightning card that receives by default",
		args: ["card"],
		options: { network: net },
		params: ({ options }, { card: c }) => ({
			card: c,
			network: options.network
		})
	},
	"lightning rename": {
		method: "lightning.rename",
		usage: "lightning rename <card> <name...> [--network testnet]",
		summary: "Name a Lightning card",
		args: ["card", "name..."],
		options: { network: net },
		params: ({ options }, a) => ({
			card: a.card,
			name: a.name,
			network: options.network
		})
	},
	"pay": {
		method: "pay",
		usage: "pay <invoice|lightning-address|lnurl> [--amount sats] [--network n] [--max-fee sats] [--card <id>] [--comment t] [--confirm-real]",
		summary: "Pay over Lightning from Testnet, or --network mainnet with --confirm-real",
		args: ["target"],
		options: {
			amount: {
				type: "number",
				description: "Sats, for an address or LNURL"
			},
			network: net,
			"max-fee": {
				type: "number",
				description: "Refuse a fee above this"
			},
			card,
			comment: {
				type: "string",
				description: "For the address's owner"
			},
			"confirm-real": confirmReal
		},
		params: ({ options }, { target }) => ({
			target,
			amount: options.amount,
			network: options.network,
			maxFee: options["max-fee"],
			card: options.card,
			comment: options.comment,
			confirmReal: options["confirm-real"] === true
		})
	},
	"payment check": {
		method: "payment.check",
		usage: "payment check <chat> <payment>",
		summary: "Paid from another wallet: the contact's app looks now",
		args: ["chat", "payment"],
		params: (_, a) => ({
			chat: a.chat,
			payment: a.payment
		})
	},
	"payment list": {
		method: "payment.list",
		usage: "payment list [--chat <chat>]",
		summary: "Payments and requests, newest first",
		options: { chat: {
			type: "string",
			description: "Only this chat's"
		} },
		params: ({ options }) => ({ chat: options.chat })
	},
	"payment reclaim": {
		method: "payment.reclaim",
		usage: "payment reclaim <payment>",
		summary: "Take back ecash the contact has not taken",
		args: ["payment"],
		params: (_, a) => ({ payment: a.payment })
	},
	"wallet add-mint": {
		method: "wallet.mint.add",
		usage: "wallet add-mint <url> [--primary]",
		summary: "Add a Cashu mint (a local or test mint is Testnet's)",
		args: ["url"],
		options: { primary: {
			type: "boolean",
			description: "Make it the one invoices are created at"
		} },
		params: ({ options }, { url }) => ({
			url,
			primary: options.primary === true
		})
	},
	"wallet address": {
		method: "wallet.address",
		usage: "wallet address <bitcoin|arkade|spark|usdt> [--network testnet]",
		summary: "An address to be paid on",
		args: ["type"],
		options: { network: net },
		params: ({ options }, { type }) => ({
			type,
			network: options.network
		})
	},
	"wallet create": {
		method: "wallet.create",
		usage: "wallet create <type> [--network testnet] [--provider <id>] [--value name=value]... [--stdin] [--invite <code>] [--api-key <key>]",
		summary: "A wallet: cashu, lightning, arkade, spark, bitcoin, fedimint, usdt (bark: app only)",
		args: ["type"],
		options: {
			network: net,
			provider: {
				type: "string",
				description: "Lightning or on-chain source (wallet list shows them)"
			},
			value: {
				type: "list",
				description: "A field of the source's form, name=value"
			},
			stdin: {
				type: "boolean",
				description: "Secret fields as name=value lines on stdin (api-key=… for the API key), kept out of ps"
			},
			invite: {
				type: "string",
				description: "Fedimint: the federation's invite"
			},
			"api-key": {
				type: "string",
				description: "Spark on Mainnet: your Breez API key (better on stdin: --stdin)"
			}
		},
		params: ({ options }, { type }) => ({
			type,
			network: options.network,
			provider: options.provider,
			invite: options.invite,
			apiKey: options["api-key"],
			values: pairs(options.value),
			stdin: options.stdin === true ? true : void 0
		})
	},
	"wallet faucet": {
		method: "wallet.faucet",
		usage: "wallet faucet <type> [--card <id>]",
		summary: "Test coins from a Testnet wallet's faucet",
		args: ["type"],
		options: { card },
		params: ({ options }, { type }) => ({
			type,
			network: "testnet",
			card: options.card
		})
	},
	"wallet history": {
		method: "wallet.history",
		usage: "wallet history [--network testnet] [--limit n]",
		summary: "A network's wallet history, newest first",
		options: {
			network: net,
			limit: {
				type: "number",
				description: "Entries (default 50)"
			}
		},
		params: ({ options }) => ({
			network: options.network,
			limit: options.limit
		})
	},
	"wallet list": {
		method: "wallet.list",
		usage: "wallet list [--network mainnet|testnet]",
		summary: "Wallets with their balances, and what New can make",
		options: { network: net },
		params: ({ options }) => ({ network: options.network })
	},
	"wallet receive": {
		method: "wallet.receive",
		usage: "wallet receive <sats> [--network testnet] [--card <id>]",
		summary: "A Lightning invoice to be paid",
		args: ["amount"],
		options: {
			network: net,
			card
		},
		params: ({ options }, { amount }) => ({
			amount: sats(amount),
			network: options.network,
			card: options.card
		})
	},
	"wallet redeem": {
		method: "wallet.redeem",
		usage: "wallet redeem [<cashu-token>]",
		summary: "Take the ecash of a Cashu token (its mint must be one of yours); the token on stdin keeps it out of ps",
		args: ["token?"],
		params: (_, { token }) => ({ token })
	},
	"wallet remove": {
		method: "wallet.remove",
		usage: "wallet remove <type> [--network testnet] [--card <id>] [--accept-loss]",
		summary: "Remove a wallet; refused while it holds money or waits for some, unless --accept-loss",
		args: ["type"],
		options: {
			network: net,
			card,
			"accept-loss": {
				type: "boolean",
				description: "What it holds on this device is lost without its backup"
			}
		},
		params: ({ options }, { type }) => ({
			type,
			network: options.network,
			card: options.card,
			acceptLoss: options["accept-loss"] === true
		})
	}
};
//#endregion
//#region src/commands/services.ts
/** Shared local services: one entry per command, in alphabetical order (test/commands.test.ts checks). */
var commands = {
	"service add": {
		method: "service.add",
		usage: "service add <name> <http://127.0.0.1:port>",
		summary: "A web app on this machine that contacts may be given",
		args: ["name", "target"],
		params: (_, a) => ({
			name: a.name,
			target: a.target
		})
	},
	"service close": {
		method: "service.close",
		usage: "service close <chat> <service>",
		summary: "Close a contact's app opened here",
		args: ["chat", "service"],
		params: (_, a) => ({
			chat: a.chat,
			service: a.service
		})
	},
	"service enable": {
		method: "service.enable",
		usage: "service enable <service> [--off]",
		summary: "Turn a shared app on or off",
		args: ["service"],
		options: { off: {
			type: "boolean",
			description: "Turn it off"
		} },
		params: ({ options }, a) => ({
			service: a.service,
			off: options.off === true
		})
	},
	"service list": {
		method: "service.list",
		usage: "service list",
		summary: "Web apps this profile shares"
	},
	"service open": {
		method: "service.open",
		usage: "service open <chat> <service> [--port p]",
		summary: "A contact's app on a loopback port here (daemon)",
		args: ["chat", "service"],
		options: { port: {
			type: "number",
			description: "Local port (default: any free one)"
		} },
		params: ({ options }, a) => ({
			chat: a.chat,
			service: a.service,
			port: options.port
		})
	},
	"service peer": {
		method: "service.peer",
		usage: "service peer <chat>",
		summary: "What a contact shares with you",
		args: ["chat"],
		params: (_, a) => ({ chat: a.chat })
	},
	"service remove": {
		method: "service.remove",
		usage: "service remove <service>",
		summary: "Stop sharing a web app with anyone",
		args: ["service"],
		params: (_, a) => ({ service: a.service })
	},
	"service share": {
		method: "service.share",
		usage: "service share <service> <chat> [--off]",
		summary: "Give (or take back) a contact access to a web app",
		args: ["service", "chat"],
		options: { off: {
			type: "boolean",
			description: "Take it back"
		} },
		params: ({ options }, a) => ({
			service: a.service,
			chat: a.chat,
			off: options.off === true
		})
	}
};
//#endregion
//#region src/commands/index.ts
/**
* The commands that are one API method each, one file per area of the app, each in alphabetical order. A new
* command goes in its area's file at its place; a new area is a new file and its two lines here. The order here
* is the order `ghostly help` lists them in.
*/
var COMMANDS = {
	...commands$4,
	...commands$6,
	...commands$3,
	...commands$5,
	...commands$1,
	...commands$2,
	...commands,
	...commands$7,
	...commands$8
};
/** Commands that take text (argument or stdin), with the secret guard and delivery waits. */
var TEXT_COMMANDS = {
	"send": {
		method: "chat.send",
		target: "chat",
		args: ["chat", "text...?"],
		usage: "send <chat> [text...] [--reply <message>] [--button id:Label]... [--style id=primary|neutral|danger]... [--once] [--id id] [--stdin] [--force] [--wait none|sent|delivered]",
		summary: "Send a message (text from arguments or stdin); --button puts buttons under it, each label its own (case aside)",
		options: {
			stdin: {
				type: "boolean",
				description: "Read the text from stdin"
			},
			force,
			reply,
			...buttonOptions,
			...wait
		}
	},
	"edit": {
		method: "chat.edit",
		target: "chat",
		message: true,
		args: [
			"chat",
			"message",
			"text...?"
		],
		usage: "edit <chat> <message> [text... | --text <text> | --stdin] [--force] [--wait none|confirmed]",
		summary: "Replace the text of a message you sent (the id send gave; in a group, group edit)",
		options: {
			stdin: {
				type: "boolean",
				description: "Read the new text from stdin"
			},
			text: {
				type: "string",
				description: "The new text, as one argument"
			},
			force,
			wait: {
				type: "string",
				description: "none or confirmed (default: none with a daemon, confirmed without)"
			},
			timeout: wait.timeout
		}
	},
	"group send": {
		method: "group.send",
		target: "group",
		args: ["group", "text...?"],
		usage: "group send <group> [text...] [--mention <member>]... [--reply <message>] [--button id:Label]... [--style id=primary|neutral|danger]... [--once] [--id id] [--stdin] [--force] [--wait none|sent] [--timeout s]",
		summary: "Send to a group; mention members written as @name in the text; --button puts buttons under it",
		options: {
			stdin: {
				type: "boolean",
				description: "Read the text from stdin"
			},
			force,
			reply,
			mention: {
				type: "list",
				description: "A member (key, key prefix, name or everyone) named as @name in the text"
			},
			...buttonOptions,
			...groupWait
		}
	},
	"group edit": {
		method: "group.edit",
		target: "group",
		message: true,
		args: [
			"group",
			"message",
			"text...?"
		],
		usage: "group edit <group> <message> [text... | --text <text> | --stdin] [--mention <member>]... [--force] [--wait none|sent] [--timeout s]",
		summary: "Replace the text of a message you sent to a group (the id group send gave)",
		options: {
			stdin: {
				type: "boolean",
				description: "Read the new text from stdin"
			},
			text: {
				type: "string",
				description: "The new text, as one argument"
			},
			force,
			mention: {
				type: "list",
				description: "A member newly named as @name in the text (those the message named stay)"
			},
			...groupWait
		}
	}
};
/**
* Positionals that name something by its id (a chat or a group also by a prefix or its name). The ids are the
* engine's and the contacts', and drafts, payments and groups are base64url, which starts with `-` one time in 64:
* in these a word that starts with a dash is the value. A mistyped flag there names nothing and fails as not found;
* text, names and paths stay strict.
*/
var ID_ARGS = /* @__PURE__ */ new Set([
	"chat",
	"message",
	"group",
	"member",
	"payment",
	"file",
	"draft",
	"id",
	"card",
	"service",
	"call"
]);
/** A leading positional that may be left out (`name?`); a trailing one that may (`text...?`) shifts nothing. */
var leadingOptional = (name) => name.endsWith("?") && !name.endsWith("...?");
/**
* Which of a command's positionals take an id, by index (a trailing `...` one covers the rest). An optional `name?`
* shifts the others, so it counts only where it and what may come in its place are all ids.
*/
function idSlot(command) {
	const names = (command.args ?? []).map((name) => name.replace(/\?$/, ""));
	const shift = (command.args ?? []).filter(leadingOptional).length;
	const rest = names.findIndex((name) => name.endsWith("..."));
	const at = (index) => {
		const name = rest !== -1 && index >= rest ? names[rest].slice(0, -3) : names[index];
		return name !== void 0 && ID_ARGS.has(name);
	};
	return (index) => at(index) && (shift === 0 || index + shift >= names.length || at(index + shift));
}
/**
* The positionals of a command, by name; missing required ones are a usage error, and so are ones given as "" (an
* unset variable in a script), before the profile opens. A leading `name?` is optional: it is given only when every
* required one is there too (`file accept [<chat>] <file>`). A trailing `name...` takes the rest and needs at least
* one word that is not ""; `name...?` may take none (text from stdin, `chat rename`'s name back to the contact's).
*/
function positionals(command, values) {
	let names = command.args ?? [];
	const optional = names.filter(leadingOptional);
	if (optional.length) {
		const skip = Math.max(0, optional.length - Math.max(0, values.length - (names.length - optional.length)));
		names = [...optional.slice(skip).map((name) => name.slice(0, -1)), ...names.filter((name) => !leadingOptional(name))];
	}
	const out = {};
	for (let i = 0; i < names.length; i++) {
		const name = names[i].replace(/\?$/, "");
		if (name.endsWith("...")) {
			const rest = values.slice(i);
			if (rest.every((word) => word === "") && !names[i].endsWith("?")) throw new CliError("usage", `Missing <${name.slice(0, -3)}>: ghostly ${command.usage}`);
			out[name.slice(0, -3)] = rest.length ? rest.join(" ") : void 0;
			return out;
		}
		if (values[i] === void 0 || values[i] === "") throw new CliError("usage", `Missing <${name}>: ghostly ${command.usage}`);
		out[name] = values[i];
	}
	noMoreThan(names.length, values, command.usage);
	return out;
}
/** Words past a usage's arguments are refused, never dropped: `profile use my bot` would select `my`. */
function noMoreThan(count, values, usage) {
	if (values.length > count) throw new CliError("usage", `Too many arguments: ghostly ${usage}`);
}
//#endregion
//#region src/listen.ts
/**
* Who `listen` passes on, checked before any hook or output: chats by id (a contact key is matched to its chat as
* events come, so a chat made after the start counts too), groups by id. An event of a chat or group not on it is
* dropped; one that names neither (`daemon.started`, `events.gap`, `identity.approval`) is this profile's own and
* passes.
*/
var Allowlist = class {
	chats;
	keys;
	groups;
	peerOf;
	peers = /* @__PURE__ */ new Map();
	/** `peerOf`: a chat's contact key (null when it has none yet, or the chat is gone). */
	constructor(chats, keys, groups, peerOf) {
		this.chats = chats;
		this.keys = keys;
		this.groups = groups;
		this.peerOf = peerOf;
	}
	async allows(event) {
		if ("group" in event) return typeof event.group === "string" && this.groups.has(event.group);
		if (!("chat" in event)) return true;
		const chat = event.chat;
		if (typeof chat !== "string") return false;
		if (this.chats.has(chat)) return true;
		if (!this.keys.size) return false;
		let key = this.peers.get(chat);
		if (!key) {
			key = await this.peerOf(chat).catch(() => null) || void 0;
			if (key) this.peers.set(chat, key);
		}
		return !!key && this.keys.has(key);
	}
};
/**
* `--from` and `--group` as ids, resolved once at start: a contact key as that key (whatever any chat is named), else a
* chat by id, prefix or name (`findChat`); a group by id, prefix or name. A name that later changes (or a contact who
* renames themselves) moves nothing.
*/
async function allowlist(from, groups, call, peerOf) {
	const chats = /* @__PURE__ */ new Set(), keys = /* @__PURE__ */ new Set(), groupIds = /* @__PURE__ */ new Set();
	for (const ref of from) if (CONTACT_KEY.test(ref)) keys.add(ref);
	else chats.add((await call("chat.get", { chat: ref })).id);
	for (const ref of groups) groupIds.add((await call("group.get", { group: ref })).id);
	return new Allowlist(chats, keys, groupIds, peerOf);
}
/** The turn an event starts, or null: only a contact's message, and a group message that mentions this profile. */
function toTurn(event) {
	const message = event.message;
	if (!message || typeof message.text !== "string") return null;
	if (event.type === "message.received" && typeof event.chat === "string") return turn(event, "message.received", { chat: event.chat }, message);
	if (event.type === "group.message" && typeof event.group === "string" && message.mentioned) return turn(event, "group.message", {
		group: event.group,
		...message.member ? { member: message.member } : {}
	}, message);
	if (event.type === "group.mentioned" && typeof event.group === "string" && message.mentioned) return turn(event, "group.mentioned", {
		group: event.group,
		...message.member ? { member: message.member } : {}
	}, message);
	return null;
}
function turn(event, source, where, message) {
	const file = message.file;
	const place = where.chat ?? where.group ?? "", messageId = turnRef(place, message.id);
	return {
		seq: event.seq,
		id: `agent.turn:${source}:${place}:${messageId}`,
		type: "agent.turn",
		at: event.at,
		source,
		...where,
		messageId,
		timestamp: message.timestamp,
		...message.press ? { press: message.press } : {},
		untrusted: {
			text: message.text,
			name: message.nick ?? null,
			messageId: message.id,
			...message.replyTo ? { replyTo: {
				id: message.replyTo.id,
				snippet: message.replyTo.snippet
			} } : {},
			...file ? { file: {
				id: file.id,
				name: file.name,
				size: file.size,
				mime: file.mime,
				voice: !!file.voice
			} } : {}
		}
	};
}
/** Only loopback: events carry message text, and a webhook is a local bridge (WISP 1100 § Security). */
function checkWebhook(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new CliError("usage", `Not a URL: ${url}`);
	}
	if (!["http:", "https:"].includes(parsed.protocol)) throw new CliError("usage", "The webhook must be http:// or https://");
	if (![
		"127.0.0.1",
		"localhost",
		"[::1]"
	].includes(parsed.hostname)) throw new CliError("usage", "The webhook must be on this machine (127.0.0.1, localhost or [::1])");
	return parsed;
}
function readCursor(path) {
	if (!path || !existsSync(path)) return void 0;
	const value = Number(readFileSync(path, "utf8").trim());
	return Number.isInteger(value) && value >= 0 ? value : void 0;
}
/**
* Whether a cursor can be kept at `path`, asked before anything starts: its folder is there and takes a file. Before, a
* folder that was not there was found at the first event: the listener ran, said "event N failed: ENOENT" for each one
* and never wrote the cursor, so the next start began at the journal's end and skipped what came while it was down.
* Throws what the file system says (`asCliError` names the path and the code: not_found, refused).
*/
function checkCursor(path) {
	if (!path) return;
	const folder = dirname(resolve(path));
	if (!statSync(folder).isDirectory()) throw new CliError("not_found", `No such file or folder: ${folder}`);
	accessSync(folder, constants.W_OK | constants.X_OK);
}
function writeCursor(path, seq) {
	rmSync(path + ".tmp", { force: true });
	writeFileSync(path + ".tmp", String(seq) + "\n", {
		mode: 384,
		flag: "wx"
	});
	renameSync(path + ".tmp", path);
}
/**
* `--type`: one type (`message.received`, exactly: `group.message` is not its `group.message.edited`), or a family, a
* word with no "." (`message`, `chat`) or one ending in "." or "*" (`group.typing.`). Before, a family needed its "." and
* `--type chat` let nothing through. A family is whole words: `message` is not `messages.x`.
*/
function matches(event, types) {
	if (!types.length) return true;
	return types.some((type) => {
		if (type === "*") return true;
		const family = /[.*]$/.test(type) ? type.replace(/\.?\*$/, "").replace(/\.$/, "") : type.includes(".") ? null : type;
		return event.type === type || family !== null && event.type.startsWith(family + ".");
	});
}
/**
* Every event type a daemon of this version emits (events.ts, appEvents.ts, holds.ts, identities.ts, calls/manager.ts,
* main.ts) and `--turns`' own. A test reads them back from the source: a type added there and not here fails it.
*/
var EVENT_TYPES = [
	"agent.turn",
	"app.closed",
	"app.message",
	"app.opened",
	"button.pressed",
	"call.connected",
	"call.ended",
	"call.incoming",
	"call.outgoing",
	"call.resumed",
	"call.stalled",
	"chat.announced",
	"chat.connection",
	"chat.created",
	"chat.held",
	"chat.joined",
	"chat.pairing",
	"chat.pinned",
	"chat.released",
	"chat.removed",
	"chat.renamed",
	"daemon.started",
	"events.gap",
	"file.done",
	"file.failed",
	"file.offered",
	"file.stage",
	"group.created",
	"group.deleted",
	"group.event",
	"group.members",
	"group.mentioned",
	"group.message",
	"group.message.edited",
	"group.pinned",
	"group.reaction",
	"group.removed",
	"group.sent",
	"group.status",
	"group.typing.started",
	"group.typing.stopped",
	"identity.approval",
	"identity.progress",
	"identity.received",
	"identity.status",
	"message.deleted",
	"message.delivery",
	"message.edited",
	"message.reaction",
	"message.received",
	"message.sent",
	"payment.created",
	"payment.updated",
	"typing.started",
	"typing.stopped"
];
/** The families, the first word of each type: what a `--type` must start with. */
var EVENT_FAMILIES = [...new Set(EVENT_TYPES.map((type) => type.split(".")[0]))];
/**
* Checks each `--type` before anything starts. Before, `--type bogus` (or a typo such as `message.recieved`) was taken
* and the listener stayed silent for good. A first word that is no family is a usage error naming them; a type, or a
* family below the first word, that no event has is said on stderr (`warn`) and kept: a newer daemon may emit it.
*/
function checkTypes(types, warn) {
	for (const type of types) {
		if (type === "*") continue;
		const family = type.split(/[.*]/)[0];
		if (!EVENT_FAMILIES.includes(family)) throw new CliError("usage", `No event is of type ${type}: --type takes a type, or a family (${EVENT_FAMILIES.join(", ")})`);
		if (!EVENT_TYPES.some((known) => matches({
			seq: 0,
			id: "",
			type: known,
			at: 0
		}, [type]))) warn(`ghostly: no event is of type ${type}; the ${family} family has ${EVENT_TYPES.filter((known) => known.startsWith(family + ".")).join(", ")}`);
	}
}
/** The environment a hook runs in: this one's, less the backup passphrase (a hook, and what it runs, never needs it). */
function hookEnv(env) {
	const rest = { ...env };
	delete rest.GHOSTLY_BACKUP_PASSPHRASE;
	return rest;
}
/** Runs `command` through the shell with the event on stdin (never in its arguments); resolves with its exit code. */
function runExec(command, event) {
	return new Promise((resolve) => {
		const child = spawn(command, {
			shell: true,
			stdio: [
				"pipe",
				"inherit",
				"inherit"
			],
			env: {
				...hookEnv(process.env),
				GHOSTLY_EVENT_TYPE: event.type,
				GHOSTLY_EVENT_ID: event.id,
				GHOSTLY_EVENT_SEQ: String(event.seq)
			}
		});
		child.on("error", () => resolve(127));
		child.on("close", (code) => resolve(code ?? 1));
		child.stdin.on("error", () => {});
		child.stdin.end(JSON.stringify(event) + "\n");
	});
}
async function post(url, event) {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			if ((await fetch(url, {
				method: "POST",
				redirect: "manual",
				headers: {
					"content-type": "application/json",
					"x-ghostly-event": event.type,
					"x-ghostly-seq": String(event.seq)
				},
				body: JSON.stringify(event),
				signal: AbortSignal.timeout(1e4)
			})).ok) return true;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
	}
	return false;
}
/**
* A handler that takes events in order, one at a time. A step that throws (the output closed, the allowlist's lookup,
* the cursor's disk) is said on stderr and passed: the cursor moves on and the next event is handled.
*/
function eventHandler(options) {
	const webhook = options.webhook ? checkWebhook(options.webhook) : null;
	let chain = Promise.resolve();
	let behind = 0;
	const handle = (event) => {
		const seq = event.seq, type = event.type;
		behind++;
		chain = chain.then(async () => {
			const skip = () => {
				if (options.cursor) writeCursor(options.cursor, event.seq);
			};
			if (!matches(event, options.types)) return skip();
			if (options.allow && !await options.allow.allows(event)) return skip();
			if (options.turns) {
				const next = toTurn(event);
				if (!next) return skip();
				event = next;
			}
			const full = options.print && options.write(JSON.stringify(event)) === false;
			if (options.exec) {
				const code = await runExec(options.exec, event);
				if (code !== 0) process.stderr.write(`ghostly: --exec exited ${code} on event ${event.seq} (${event.type})\n`);
			}
			if (webhook && !await post(webhook, event)) process.stderr.write(`ghostly: the webhook did not take event ${event.seq} (${event.type})\n`);
			if (full) await options.drained?.();
			if (options.cursor) writeCursor(options.cursor, event.seq);
		}).catch((error) => {
			try {
				process.stderr.write(`ghostly: event ${seq} (${type}) failed: ${error instanceof Error ? error.message : String(error)}\n`);
				if (options.cursor) writeCursor(options.cursor, seq);
			} catch {}
		}).finally(() => {
			behind--;
		});
	};
	return Object.assign(handle, {
		behind: () => behind,
		idle: () => chain
	});
}
/**
* Bounds what a listener holds when its output or hooks fall behind (a stdout reader that hung, a slow --exec): past
* `MAX_BEHIND` events not handled it stops taking events (`pause`: the subscription closes) and drops what still
* arrives; once every event taken is handled, `resume` opens it again after the last one taken. The daemon's journal
* keeps what came meanwhile (and says `events.gap` past what it keeps), so a consumer that hangs for a day does not
* grow the listener by the day's traffic.
*/
var Feed = class {
	handle;
	since;
	pause;
	resume;
	held = false;
	/** `since`: the last event taken, where a new subscription starts. */
	constructor(handle, since, pause, resume) {
		this.handle = handle;
		this.since = since;
		this.pause = pause;
		this.resume = resume;
	}
	get paused() {
		return this.held;
	}
	take = (event) => {
		if (this.held) return;
		this.since = event.seq;
		this.handle(event);
		if (this.handle.behind() < 1e3) return;
		this.held = true;
		this.pause();
		this.handle.idle().then(() => {
			this.held = false;
			this.resume(this.since);
		});
	};
};
//#endregion
//#region src/secretInput.ts
/**
* Secrets a command takes (a Cashu token, an API key, a card's form) come on stdin: on the command line they show in
* `ps` to every user of the machine while the command runs, and stay in the shell's history. Still taken there, with
* a warning. Fills `params` in place; the warning to print on stderr, if any. `tty`: stdin is a terminal, where a
* read would wait on the keyboard without a word.
*/
async function secretsFromStdin(method, params, read, tty = false) {
	const warning = (what) => `${what} on the command line shows in ps and the shell's history: give it on stdin instead`;
	if (method === "wallet.redeem") {
		if (params.token !== void 0) return warning("A token");
		const missing = () => new CliError("usage", "Missing <cashu-token>: give it as an argument or on stdin (… | ghostly wallet redeem)");
		if (tty) throw missing();
		const token = (await read()).trim();
		if (!token) throw missing();
		params.token = token;
		return;
	}
	if (method === "wallet.create") {
		const onLine = params.apiKey !== void 0;
		if (params.stdin === true) {
			const values = { ...params.values };
			for (const line of (await read()).split(/\r?\n/)) {
				if (!line.trim()) continue;
				const eq = line.indexOf("=");
				if (eq < 1) throw new CliError("usage", "--stdin takes name=value lines (api-key=… for the API key)");
				const name = line.slice(0, eq).trim(), value = line.slice(eq + 1);
				if (name === "api-key") params.apiKey = value;
				else values[name] = value;
			}
			if (Object.keys(values).length) params.values = values;
		}
		delete params.stdin;
		return onLine ? warning("An API key") : void 0;
	}
}
//#endregion
//#region src/main.ts
var VERSION = package_default.version;
/**
* The engine's modules (the API, the host, the backup, the buttons) are loaded only where a command needs them here: a
* command a running daemon answers loads none of them, and starts about as fast as Node does. Statically imported, they
* cost every command ~100 ms before its socket was opened.
*/
var engineApi = () => import("./api-0yRHDJvK.js");
var engineHost = () => import("./host-B9EoE0qS.js");
var pretty = false;
function print(value) {
	process.stdout.write(JSON.stringify(value, null, pretty ? 2 : void 0) + "\n");
}
/** Done, with something to know (a voice note sent without its waveform): said on stderr, the JSON stays the answer. */
function printAnswer(result) {
	if (typeof result?.warning === "string") {
		process.stderr.write(`ghostly: ${result.warning}\n`);
		delete result.warning;
	}
	print(result);
}
function globals(parsed) {
	const home = ghostlyHome(parsed.options.home);
	const profile = currentProfile(home, parsed.options.profile);
	return {
		home,
		profile,
		paths: profilePaths(home, profile),
		pretty: parsed.options.pretty === true
	};
}
/** The profile must exist; `default` is made on first use, any other with `profile create`. */
function requireProfile(g) {
	if (profileExists(g.home, g.profile)) return;
	if (g.profile === "default") {
		createProfile(g.home, g.profile);
		return;
	}
	throw noProfile(g);
}
function noProfile(g) {
	return new CliError("not_found", `No profile ${g.profile}: make it with \`ghostly profile create ${g.profile}\``);
}
/** For a command that only reads: a mistyped profile is named as one, and `default` is not made by asking about it. */
function knownProfile(g) {
	if (g.profile !== "default" && !profileExists(g.home, g.profile)) throw noProfile(g);
}
/** Said on stderr when the daemon runs another release than this command (it started before an upgrade). */
function versionWarning(daemon, cli) {
	if (typeof daemon !== "string" || daemon === cli) return null;
	return `ghostly: the daemon runs ${daemon} and this command is ${cli}: \`ghostly daemon restart\` runs the new code`;
}
async function warnVersion(client) {
	const warning = versionWarning((await client.call("status").catch(() => null))?.version, VERSION);
	if (warning) process.stderr.write(warning + "\n");
}
/**
* A command about one 1:1 chat: a one-shot for it leaves the groups' sessions unstarted. A fresh process starts an edge
* per group member, and their first polls spent the relays' 30 requests a minute in seconds: the chat's message then
* waited for the next minute (60 s and more instead of 3 to 5).
*/
function chatOnly(method, params) {
	if (method.startsWith("task.") || method.startsWith("routine.") || method.startsWith("button.")) return false;
	if (method === "usage.send") return params.all === true;
	return method.startsWith("chat.") || params.chat !== void 0 && params.group === void 0 && !method.startsWith("group.");
}
/**
* Calls that only read what the profile stores: a one-shot for one opens it offline (`RuntimeOptions.offline`).
* Opened online, `status` or `chat list` started every chat, put the profile's records on the relays again and waited
* for its leave packet to be taken: 0.25 s became 3.3 s with a relay that takes 1.5 s, and 10 s with one that does not
* answer, and each read spent ~5 relay requests per chat of the relays' per-address budget.
*/
var READS = /* @__PURE__ */ new Set([
	"status",
	"profile.get",
	"settings.get",
	"events.replay",
	"chat.list",
	"chat.get",
	"chat.history",
	"chat.details",
	"group.list",
	"group.get",
	"group.history",
	"file.list",
	"wallet.list",
	"wallet.history",
	"payment.list",
	"identity.list",
	"identity.providers",
	"identity.contact",
	"service.list",
	"service.peer",
	"call.list",
	"app.served",
	"x401.credential.list"
]);
/** Whether a one-shot for this call opens the profile offline; test/readOnlyCommands.test.ts names every table command. */
function readOnly(method, params) {
	if (method === "engine.call") return typeof params.method === "string" && ENGINE_READS.includes(params.method);
	if (method === "call.auto") return params.on === void 0;
	return READS.has(method);
}
/**
* Calls whose change stays on this device: a chat's name here, a chat removed (nothing goes to the contact), auto-answer
* (calls.json), a proof dropped, a web app added (shared with no one yet), an x401 key or credential (WISP 3xx: never
* shared with a contact). Opened online, each put the profile's records on the relays and waited for them (6 PUT + 4
* GET, 3.3 s with a relay that takes 1.5 s), and the contacts' apps saw this device come online. `message delete` stays
* online: it settles a file offer already on the DHT.
*/
var LOCAL_WRITES = /* @__PURE__ */ new Set([
	"chat.rename",
	"chat.remove",
	"call.auto",
	"identity.cancel",
	"service.add",
	"x401.key.new",
	"x401.credential.add",
	"x401.credential.remove"
]);
/** Settings of this device only: no contact and no relay hears of them (nick, avatar and the relays' do). */
var LOCAL_SETTINGS = /* @__PURE__ */ new Set([
	"sendTyping",
	"autoDownloads",
	"serveFiles"
]);
/** Whether a one-shot for this call opens the profile offline: a read, or a change that stays on this device. */
function offlineCall(method, params) {
	return readOnly(method, params) || LOCAL_WRITES.has(method);
}
async function session(g, options) {
	requireProfile(g);
	const client = await connectDaemon(g.paths.socket);
	if (client) await warnVersion(client);
	if (client) return {
		mode: "daemon",
		call: (m, p) => client.call(m, p),
		close: async () => client.close()
	};
	const [{ openHost }, { callApi }] = await Promise.all([engineHost(), engineApi()]);
	const host = await openHost(g.paths, "one-shot", VERSION, options);
	return {
		mode: "one-shot",
		call: (m, p) => callApi(host.ctx, m, p ?? {}),
		close: () => host.close()
	};
}
/**
* How a one-shot opens the profile: `deferGroups` when the command is about one 1:1 chat (`chatOnly`) and needs
* nothing of the groups, `offline` when it only reads or changes only this device (`offlineCall`).
*/
async function withSession(g, work, options = {}) {
	const s = await session(g, options);
	try {
		return await work(s);
	} finally {
		await s.close();
	}
}
async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
}
var o = (type, description) => ({
	type,
	description
});
/** Commands with their own flow (main.ts), as help shows them. */
var SPECIAL = [
	[
		"profile create <name> [--use] [--name <shown name>]",
		"Make a profile (its own keys, chats and wallets)",
		{
			use: o("boolean", "Make it the current profile"),
			name: o("string", "The name contacts see")
		}
	],
	["profile list", "Profiles, and which one is current"],
	["profile use <name>", "Make a profile the current one"],
	["profile show", "The name contacts see, and whether it is shared"],
	[
		"profile set [--name <name>] [--share-profile | --no-share-profile]",
		"Change the name contacts see",
		{
			name: o("string", "The name contacts see"),
			"share-profile": o("boolean", "Share the name and picture with contacts (--no-share-profile: do not)")
		}
	],
	[
		"profile backup --out <file> [--passphrase-file f | --no-passphrase] [--light]",
		"A backup of the profile, encrypted with a passphrase (from a file or GHOSTLY_BACKUP_PASSPHRASE); --no-passphrase makes one anyone can read",
		{
			out: o("string", "The backup file to write"),
			"passphrase-file": o("string", "The passphrase, from this file (else GHOSTLY_BACKUP_PASSPHRASE)"),
			passphrase: {
				...o("boolean", "Do not encrypt. The file then holds the profile's keys and wallet secrets in the clear"),
				negatedOnly: true
			},
			light: o("boolean", "Leave out files over 1 MB (voice messages over 4 MB); their messages stay")
		}
	],
	[
		"profile restore <file> <new profile> [--passphrase-file f] [--use]",
		"A backup into a new profile (a backup made with --no-passphrase needs none)",
		{
			"passphrase-file": o("string", "The passphrase, from this file (else GHOSTLY_BACKUP_PASSPHRASE)"),
			use: o("boolean", "Make it the current profile")
		}
	],
	[
		"daemon [--detach] [--timeout s]",
		"Keep the profile online (foreground; --detach runs it in the background)",
		{
			detach: o("boolean", "Run in the background (log in the profile folder)"),
			timeout: o("number", "Seconds --detach waits for it to start (default 60)")
		}
	],
	["daemon status", "Whether a daemon runs the profile, its version, and its socket (for the socket API)"],
	[
		"daemon stop [--timeout s]",
		"Stop the profile's daemon",
		{ timeout: o("number", "Seconds to wait for it to stop (default 20)") }
	],
	[
		"daemon restart [--timeout s]",
		"Stop the profile's daemon and start it again in the background (after an upgrade: the new code)",
		{ timeout: o("number", "Seconds to wait for each step") }
	],
	[
		"listen [--since seq] [--cursor file] [--type t]... [--turns] [--from <chat|key>]... [--group <group>]... [--exec cmd] [--webhook url] [--print]",
		"Stream events as JSON lines (starts the profile here if no daemon runs it)",
		{
			since: o("number", "Replay events after this seq first"),
			cursor: o("string", "A file that keeps the last seq handled (read at start, written after each event)"),
			type: o("list", "Only events of this type (message.received) or family (message, or group.typing.); repeat for more"),
			turns: o("boolean", "Only agent turns: each message received, and each group message that mentions you, as one agent.turn event"),
			from: o("list", "Only this chat's events (id, prefix, name or the contact's key; again for more)"),
			group: o("list", "Only this group's events (again for more); with --from or --group, nobody else's event gets through"),
			exec: o("string", "Run this command per event, the event as JSON on stdin"),
			webhook: o("string", "POST each event to this URL"),
			print: o("boolean", "Print events too when --exec or --webhook handles them")
		}
	],
	[
		"settings get [--show-secret]",
		"The profile's settings",
		{ "show-secret": o("boolean", "Show credentials too") }
	],
	["settings set <key> <json-value>", "Change one: relays, irohRelays, hyperdhtRelay, readRelays, iceServers, publicProfiles, online, shareProfile, sendTyping, autoDownloads, serveFiles, nick"],
	[
		"engine <method> [json-params | -] [--confirm-real] [--show-secret]",
		"Any call of the app's engine, with its own parameters",
		{
			"confirm-real": o("boolean", "Confirm a Mainnet (real money) spend"),
			"show-secret": o("boolean", "Print a call's secrets")
		}
	],
	["engine --list", "The engine's calls"],
	["call pipe [<chat|call>]", "A call's audio on stdin/stdout: raw s16le mono PCM at the call's rate (e.g. with sox or ffmpeg)"],
	[
		"identity add <provider> [subject] [--signer id] [--field name=value]... [--days n]",
		"Make an identity proof (a tool's or a published one finishes with identity complete)",
		{
			signer: o("string", "Which signer makes the proof (identity providers lists them)"),
			field: o("list", "A field of the provider's form, name=value"),
			days: o("number", "How long the proof holds"),
			timeout: o("number", "Seconds to wait for an approval")
		}
	],
	["version", "This CLI's version (also ghostly --version)"]
];
function help() {
	const rows = [
		...SPECIAL.slice(0, 7).map(([usage, summary]) => [usage, summary]),
		...Object.values(COMMANDS).filter((c) => c.method !== "events.replay").map((c) => [c.usage, c.summary]),
		...Object.values(TEXT_COMMANDS).map((c) => [c.usage, c.summary]),
		...SPECIAL.slice(7).map(([usage, summary]) => [usage, summary]),
		[COMMANDS.events.usage, COMMANDS.events.summary]
	];
	const width = 58;
	return [
		`ghostly ${VERSION}: Ghostly for bots and terminals, the app's own engine without a screen.`,
		"",
		"Usage: ghostly <command> [options]   (JSON on stdout; errors as {\"error\":{code,message}} with an exit code)",
		"",
		...rows.map(([usage, summary]) => `  ${usage.length > width ? usage + "\n  " + " ".repeat(width) : usage.padEnd(width)}  ${summary}`),
		"",
		"Options for every command:",
		...Object.entries(GLOBAL_OPTIONS).map(([name, o]) => `  --${name}${o.short ? `, -${o.short}` : ""}`.padEnd(24) + o.description),
		"",
		"A <chat> is its id, a unique prefix of it, or its name; a <group> the same. Exit codes: 0 done, 1 failed,",
		"2 usage, 3 not found, 4 timed out, 5 needs --force/--yes/--confirm-real. See packages/cli/README.md."
	].join("\n");
}
/** What `ghostly help help` answers. */
var HELP_USAGE = [
	"Usage: ghostly help [<command>...]",
	"",
	"  Help for every command, or for one command or a group of them (also ghostly <command> --help)",
	"",
	"Options for every command: --profile, -p <name>  --home <dir>  --pretty  --help, -h"
].join("\n");
/** Every command's help row: usage, summary and, for the table and text commands, their options. */
function helpRows() {
	return [
		...SPECIAL.map(([usage, summary, options]) => ({
			usage,
			summary,
			options
		})),
		...Object.values(COMMANDS),
		...Object.values(TEXT_COMMANDS)
	];
}
/** The words that name a command in its usage line: up to the first argument or option. */
function commandWords(usage) {
	const words = [];
	for (const word of usage.split(" ")) {
		if (!/^[a-z][a-z0-9-]*$/.test(word)) break;
		words.push(word);
	}
	return words;
}
/**
* Help for one command (`ghostly help file send`, `ghostly file send --help`): its usage, what it does and its
* options; for a group (`ghostly help file`), the group's commands.
*/
function commandHelp(words) {
	if (words[0] === "help") return HELP_USAGE;
	const named = (list) => helpRows().filter((row) => {
		const own = commandWords(row.usage);
		return list.every((word, i) => own[i] === word);
	});
	let rows = named(words);
	while (!rows.length && words.length > 1) rows = named(words = words.slice(0, -1));
	const asked = words.join(" ");
	if (!rows.length) throw new CliError("usage", `Unknown command: ${asked} (ghostly help)`);
	const exact = rows.filter((row) => commandWords(row.usage).join(" ") === asked);
	const lines = [];
	for (const row of exact) {
		lines.push(`Usage: ghostly ${row.usage}`, "", `  ${row.summary}`);
		const options = Object.entries(row.options ?? {}).filter(([, o]) => o.description);
		if (options.length) {
			lines.push("", "Options:");
			const labels = options.map(([name, o]) => `  --${o.negatedOnly ? "no-" : ""}${name}${o.type === "boolean" ? "" : ` <${o.type === "number" ? "n" : "value"}>`}`);
			const width = Math.max(26, ...labels.map((label) => label.length + 2));
			options.forEach(([, o], i) => lines.push(labels[i].padEnd(width) + o.description));
		}
		if (Object.values(TEXT_COMMANDS).includes(row)) lines.push("", "  -- ends the options: everything after it is the text, options included (\"-- -1 --wait sent\" sends", "  all of it). Put options before --.");
		lines.push("");
	}
	const rest = rows.filter((row) => !exact.includes(row));
	if (rest.length) {
		const width = Math.min(58, Math.max(...rest.map((row) => row.usage.length)));
		const count = `${rest.length}${exact.length ? " more" : ""} command${rest.length === 1 ? "" : "s"}`;
		lines.push(`ghostly ${asked}: ${count} (ghostly help ${asked} <command> for one)`, "");
		for (const row of rest) lines.push(`  ${row.usage.length > width ? row.usage + "\n  " + " ".repeat(width) : row.usage.padEnd(width)}  ${row.summary}`);
		lines.push("");
	}
	lines.push("Options for every command: --profile, -p <name>  --home <dir>  --pretty  --help, -h");
	return lines.join("\n");
}
async function profileCommand(sub, argv) {
	const parsed = parseArgs(argv, {
		create: {
			use: {
				type: "boolean",
				description: ""
			},
			name: {
				type: "string",
				description: ""
			}
		},
		backup: {
			out: {
				type: "string",
				description: ""
			},
			"passphrase-file": {
				type: "string",
				description: ""
			},
			passphrase: {
				type: "boolean",
				description: ""
			},
			light: {
				type: "boolean",
				description: ""
			}
		},
		restore: {
			"passphrase-file": {
				type: "string",
				description: ""
			},
			use: {
				type: "boolean",
				description: ""
			}
		},
		set: {
			name: {
				type: "string",
				description: ""
			},
			"share-profile": {
				type: "boolean",
				description: ""
			}
		}
	}[sub ?? ""] ?? {});
	const g = globals(parsed);
	pretty = g.pretty;
	switch (sub) {
		case "create": {
			const [name] = parsed.positionals;
			if (!name || parsed.positionals.length > 1) throw new CliError("usage", "ghostly profile create <name>");
			const shownName = parsed.options.name === void 0 ? void 0 : checkShownName(parsed.options.name);
			const paths = createProfile(g.home, name);
			let shown = null;
			if (shownName !== void 0) try {
				shown = await withSession({
					...g,
					profile: name,
					paths
				}, (s) => s.call("profile.set", { name: shownName }));
			} catch (e) {
				rmSync(paths.dir, {
					recursive: true,
					force: true
				});
				throw e;
			}
			if (parsed.options.use) selectProfile(g.home, name);
			print({
				created: name,
				folder: paths.dir,
				current: currentProfile(g.home) === name,
				...shown ? { profile: shown } : {}
			});
			return;
		}
		case "list": {
			noMoreThan(0, parsed.positionals, "profile list");
			const current = currentProfile(g.home);
			print({
				profiles: listProfiles(g.home).map((name) => ({
					name,
					current: name === current,
					running: lockOwner(profilePaths(g.home, name)) !== null
				})),
				home: g.home
			});
			return;
		}
		case "use": {
			const [name] = parsed.positionals;
			if (!name) throw new CliError("usage", "ghostly profile use <name>");
			noMoreThan(1, parsed.positionals, "profile use <name>");
			selectProfile(g.home, name);
			print({ current: name });
			return;
		}
		case "show":
			noMoreThan(0, parsed.positionals, "profile show");
			print(await withSession(g, (s) => s.call("profile.get"), { offline: true }));
			return;
		case "set": {
			noMoreThan(0, parsed.positionals, "profile set [--name <name>] [--share-profile | --no-share-profile]");
			const params = {};
			if (parsed.options.name !== void 0) params.name = parsed.options.name;
			if (parsed.options["share-profile"] !== void 0) params.shareProfile = parsed.options["share-profile"];
			if (!Object.keys(params).length) throw new CliError("usage", "ghostly profile set [--name <name>] [--share-profile | --no-share-profile]");
			print(await withSession(g, (s) => s.call("profile.set", params)));
			return;
		}
		case "backup": {
			noMoreThan(0, parsed.positionals, "profile backup --out <file> [--passphrase-file f | --no-passphrase] [--light]");
			const out = parsed.options.out;
			if (typeof out !== "string") throw new CliError("usage", "ghostly profile backup --out <file> [--passphrase-file f | --no-passphrase] [--light] (or GHOSTLY_BACKUP_PASSPHRASE)");
			const unsealed = parsed.options.passphrase === false;
			if (parsed.options.passphrase === true) throw new CliError("usage", "The passphrase comes from --passphrase-file or GHOSTLY_BACKUP_PASSPHRASE, never the command line");
			if (unsealed && (parsed.options["passphrase-file"] !== void 0 || process.env.GHOSTLY_BACKUP_PASSPHRASE)) throw new CliError("usage", "A passphrase is set (--passphrase-file or GHOSTLY_BACKUP_PASSPHRASE) and --no-passphrase was given: choose one");
			const light = parsed.options.light === true ? { light: true } : {};
			const params = unsealed ? {
				path: resolve(out),
				noPassphrase: true,
				...light
			} : {
				path: resolve(out),
				passphrase: backupPassphrase(parsed.options["passphrase-file"]),
				...light
			};
			const made = await withSession(g, (s) => s.call("profile.backup", params), { offline: true });
			if (unsealed) process.stderr.write("Not encrypted: this file holds the profile's keys, chats and wallet secrets in the clear. Anyone who gets it gets everything in it, including any money in its wallets.\n");
			print(made);
			return;
		}
		case "restore": {
			const [file, name] = parsed.positionals;
			if (!file || !name) throw new CliError("usage", "ghostly profile restore <file> <new profile> [--passphrase-file f] [--use]");
			noMoreThan(2, parsed.positionals, "profile restore <file> <new profile> [--passphrase-file f] [--use]");
			const { backupFileProtection, restoreProfile } = await import("./backup-DezSzFeN.js");
			const protection = await backupFileProtection(file);
			const paths = await restoreProfile(g.home, checkProfileName(name), file, protection === "none" ? void 0 : backupPassphrase(parsed.options["passphrase-file"], RESTORE_PASSPHRASE));
			if (parsed.options.use) selectProfile(g.home, name);
			print({
				restored: name,
				folder: paths.dir,
				protection
			});
			return;
		}
		default: throw new CliError("usage", "ghostly profile create|list|use|show|set|picture|backup|restore");
	}
}
/**
* A clean stop (peers told goodbye, the store folded), once; a second signal, or a stop that takes longer than
* 20 s, leaves at once. The store's journal makes that safe.
*/
function stopper(work) {
	let started = false;
	return () => {
		if (started) process.exit(1);
		started = true;
		setTimeout(() => process.exit(1), 2e4).unref();
		work().then(() => process.exit(0), () => process.exit(1));
	};
}
/**
* Ctrl-C, a service manager's stop, and the terminal or SSH session it ran in closing (SIGHUP, which would otherwise
* end it on the spot): each a clean stop.
*/
function onStopSignals(stop) {
	for (const signal of [
		"SIGINT",
		"SIGTERM",
		"SIGHUP"
	]) process.on(signal, stop);
}
var BACKUP_PASSPHRASE = "The backup passphrase comes from --passphrase-file or GHOSTLY_BACKUP_PASSPHRASE (at least 12 characters). For a backup that is not encrypted, say so with --no-passphrase";
/** Restore takes no --no-passphrase: a backup made without one says so itself. */
var RESTORE_PASSPHRASE = "This backup is encrypted: its passphrase comes from --passphrase-file or GHOSTLY_BACKUP_PASSPHRASE";
/** The backup passphrase: from a file or the environment, never the command line (it would sit in shell history). */
function backupPassphrase(file, missing = BACKUP_PASSPHRASE) {
	const value = typeof file === "string" ? readFileSync(file, "utf8").replace(/\r?\n$/, "") : process.env.GHOSTLY_BACKUP_PASSPHRASE;
	if (!value) throw new CliError("usage", missing);
	return value;
}
async function runDaemon(g) {
	requireProfile(g);
	if (await connectDaemon(g.paths.socket)) throw new CliError("busy", `A daemon already runs profile ${g.profile}`);
	const { keepServing, openHost, serve } = await engineHost();
	const host = await openHost(g.paths, "daemon", VERSION);
	let served;
	try {
		served = await serve(host);
	} catch (error) {
		await host.close();
		throw error;
	}
	keepServing();
	const stop = stopper(async () => {
		await served.close();
		await host.close();
	});
	host.ctx.stop = stop;
	onStopSignals(stop);
	host.ctx.hub.emit("daemon.started", `daemon.started:${process.pid}:${Date.now()}`, {
		pid: process.pid,
		version: VERSION
	});
	print({
		daemon: "ready",
		profile: g.profile,
		pid: process.pid,
		socket: g.paths.socket,
		lastSeq: host.ctx.hub.lastSeq
	});
}
async function daemonCommand(argv) {
	const sub = argv[0] && !argv[0].startsWith("-") ? argv[0] : void 0;
	const parsed = parseArgs(sub ? argv.slice(1) : argv, {
		detach: {
			type: "boolean",
			description: ""
		},
		timeout: {
			type: "number",
			description: ""
		}
	});
	const g = globals(parsed);
	pretty = g.pretty;
	if (!sub || [
		"status",
		"stop",
		"restart"
	].includes(sub)) noMoreThan(0, parsed.positionals, sub === "status" ? "daemon status" : sub ? `daemon ${sub} [--timeout s]` : "daemon [--detach] [--timeout s]");
	if (sub === "status") {
		knownProfile(g);
		const client = await connectDaemon(g.paths.socket);
		if (!client) {
			print({
				running: false,
				profile: g.profile,
				socket: g.paths.socket
			});
			return;
		}
		try {
			print({
				running: true,
				...await client.call("status"),
				socket: g.paths.socket
			});
		} finally {
			client.close();
		}
		return;
	}
	if (sub === "stop") {
		knownProfile(g);
		const stopFor = seconds(parsed, 20);
		const client = await connectDaemon(g.paths.socket);
		if (!client) throw new CliError("not_found", `No daemon runs profile ${g.profile}`);
		print({
			stopped: true,
			pid: await stopDaemon(g, client, stopFor)
		});
		return;
	}
	if (sub === "restart") {
		const stopFor = seconds(parsed, 20), startFor = seconds(parsed, 60);
		const client = await connectDaemon(g.paths.socket);
		const before = client ? (await client.call("status").catch(() => null))?.version ?? null : null;
		print({
			restarted: true,
			stopped: client ? await stopDaemon(g, client, stopFor) : null,
			before,
			version: VERSION,
			...await startDetached(g, startFor)
		});
		return;
	}
	if (sub) throw new CliError("usage", "ghostly daemon [--detach] [--timeout s] | daemon status | daemon stop | daemon restart");
	const startFor = seconds(parsed, 60);
	if (!parsed.options.detach) {
		await runDaemon(g);
		return;
	}
	print(await startDetached(g, startFor));
}
/** `--timeout <s>`, or `fallback` without one: seconds above 0 (0 or less would not wait at all). */
function seconds(parsed, fallback) {
	const value = parsed.options.timeout;
	if (value === void 0) return fallback;
	if (typeof value !== "number" || !(value > 0)) throw new CliError("usage", "--timeout takes a number of seconds above 0");
	return value;
}
/**
* Asks the daemon to stop and waits until its process is gone, not only until it let go of the profile (it releases
* the lock a moment before it exits); its pid.
*/
async function stopDaemon(g, client, seconds) {
	const { pid } = await client.call("daemon.stop");
	client.close();
	const until = Date.now() + seconds * 1e3;
	const running = () => lockOwner(g.paths) === pid || processAlive(pid);
	while (running() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
	if (running()) throw new CliError("timeout", `The daemon (process ${pid}) has not stopped yet`);
	return pid;
}
/** Throws busy, with its pid, when a process other than `except` holds the profile. */
function heldBy(g, except) {
	const owner = lockOwner(g.paths);
	if (owner !== null && owner !== except) throw new CliError("busy", `Profile ${g.profile} is in use by process ${owner}`, { pid: owner });
}
function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}
/** A daemon in the background, running this command's code, once its socket answers. */
async function startDetached(g, seconds) {
	requireProfile(g);
	if (await connectDaemon(g.paths.socket)) throw new CliError("busy", `A daemon already runs profile ${g.profile}`);
	heldBy(g);
	const log = openSync(g.paths.log, "a", 384);
	const child = spawn(process.execPath, [
		...process.execArgv,
		process.argv[1],
		"daemon",
		"--home",
		g.home,
		"--profile",
		g.profile
	], {
		detached: true,
		stdio: [
			"ignore",
			log,
			log
		]
	});
	child.unref();
	const until = Date.now() + seconds * 1e3;
	let client = null;
	while (!client && Date.now() < until) {
		if (child.exitCode !== null) break;
		await new Promise((resolve) => setTimeout(resolve, 200));
		client = await connectDaemon(g.paths.socket, 500);
	}
	if (!client) {
		heldBy(g, child.pid);
		if (child.exitCode === null && child.pid !== void 0 && processAlive(child.pid)) throw new CliError("timeout", `The daemon (process ${child.pid}) is still starting; ghostly daemon status shows when it is up`, {
			pid: child.pid,
			log: g.paths.log
		});
		throw new CliError("engine", `The daemon did not start; see ${g.paths.log}`);
	}
	client.close();
	return {
		daemon: "started",
		profile: g.profile,
		pid: child.pid,
		socket: g.paths.socket,
		log: g.paths.log
	};
}
async function listenCommand(argv) {
	const parsed = parseArgs(argv, {
		since: {
			type: "number",
			description: ""
		},
		cursor: {
			type: "string",
			description: ""
		},
		type: {
			type: "list",
			description: ""
		},
		exec: {
			type: "string",
			description: ""
		},
		webhook: {
			type: "string",
			description: ""
		},
		print: {
			type: "boolean",
			description: ""
		},
		from: {
			type: "list",
			description: ""
		},
		group: {
			type: "list",
			description: ""
		},
		turns: {
			type: "boolean",
			description: ""
		}
	});
	noMoreThan(0, parsed.positionals, SPECIAL.find(([usage]) => usage.startsWith("listen "))[0]);
	const g = globals(parsed);
	pretty = false;
	if (parsed.options.webhook) checkWebhook(String(parsed.options.webhook));
	const types = parsed.options.type ?? [];
	const turns = parsed.options.turns === true;
	if (turns && types.length) throw new CliError("usage", "--turns takes the place of --type: a turn is a message received, or a group message that mentions you");
	checkTypes(types, (line) => process.stderr.write(line + "\n"));
	const from = parsed.options.from ?? [], groups = parsed.options.group ?? [];
	const cursor = parsed.options.cursor;
	checkCursor(cursor);
	const since = parsed.options.since ?? readCursor(cursor);
	const start = async (call, peerOf) => {
		return eventHandler({
			types,
			turns,
			exec: parsed.options.exec,
			webhook: parsed.options.webhook,
			cursor,
			print: parsed.options.print === true || !parsed.options.exec && !parsed.options.webhook,
			write: (line) => process.stdout.write(line + "\n"),
			drained: () => new Promise((resolve) => {
				const done = () => {
					process.stdout.off("drain", done);
					process.stdout.off("close", done);
					resolve();
				};
				process.stdout.on("drain", done);
				process.stdout.on("close", done);
			}),
			allow: from.length || groups.length ? await allowlist(from, groups, call, peerOf) : void 0
		});
	};
	requireProfile(g);
	const client = await connectDaemon(g.paths.socket);
	if (client) await warnVersion(client);
	if (client) {
		const handle = await start((m, p) => client.call(m, p), async (chat) => {
			const c = await connectDaemon(g.paths.socket, 1e3);
			if (!c) return null;
			try {
				return (await c.call("chat.get", { chat })).peer || null;
			} finally {
				c.close();
			}
		}).catch((error) => {
			client.close();
			throw error;
		});
		let current = client;
		const reconnect = (wait) => void (async () => {
			while (!current && !feed.paused) {
				await new Promise((resolve) => setTimeout(resolve, wait));
				wait = 1e3;
				if (current || feed.paused) return;
				const next = await connectDaemon(g.paths.socket, 1e3);
				if (next) {
					current = next;
					await follow(next).catch(() => {
						if (current === next) current = null;
					});
				}
			}
		})();
		const feed = new Feed(handle, since, () => {
			const c = current;
			current = null;
			c?.destroy();
		}, () => reconnect(0));
		const follow = async (c) => {
			await c.subscribe(feed.since, feed.take, () => {
				if (current !== c) return;
				current = null;
				reconnect(1e3);
			});
		};
		await follow(client);
		process.on("SIGINT", () => {
			current?.close();
			process.exit(0);
		});
		process.on("SIGTERM", () => {
			current?.close();
			process.exit(0);
		});
		return;
	}
	const [{ keepServing, openHost, serve }, { callApi }] = await Promise.all([engineHost(), engineApi()]);
	const host = await openHost(g.paths, "daemon", VERSION);
	const call = (m, p) => callApi(host.ctx, m, p);
	const handle = await start(call, async (chat) => (await call("chat.get", { chat })).peer || null).catch(async (error) => {
		await host.close();
		throw error;
	});
	const served = await serve(host).catch(async (error) => {
		await host.close();
		throw error;
	});
	keepServing();
	const stop = stopper(async () => {
		await served.close();
		await host.close();
	});
	host.ctx.stop = stop;
	onStopSignals(stop);
	let off = null, left = [];
	const open = (from) => {
		for (;;) {
			const events = left.length ? left : host.ctx.hub.replay(from ?? host.ctx.hub.lastSeq);
			left = [];
			if (!events.length) break;
			for (let i = 0; i < events.length; i++) {
				feed.take(events[i]);
				if (feed.paused) {
					left = events.slice(i + 1);
					return;
				}
			}
			from = feed.since;
		}
		off = host.ctx.hub.onEvent(feed.take);
	};
	const feed = new Feed(handle, since, () => {
		off?.();
		off = null;
	}, open);
	open(since);
	host.ctx.hub.emit("daemon.started", `daemon.started:${process.pid}:${Date.now()}`, {
		pid: process.pid,
		version: VERSION,
		listen: true
	});
}
async function engineCommand(argv) {
	const parsed = parseArgs(argv, {
		"confirm-real": {
			type: "boolean",
			description: ""
		},
		"show-secret": {
			type: "boolean",
			description: ""
		},
		list: {
			type: "boolean",
			description: ""
		}
	});
	const g = globals(parsed);
	pretty = g.pretty;
	if (parsed.options.list) {
		noMoreThan(0, parsed.positionals, "engine --list");
		print({ methods: [...ENGINE_METHODS, ...ENGINE_READS].sort() });
		return;
	}
	const [method, raw] = parsed.positionals;
	if (!method || parsed.positionals.length > 2) throw new CliError("usage", "ghostly engine <method> [json-params | -]");
	if (!ENGINE_METHODS.includes(method) && !ENGINE_READS.includes(method)) throw new CliError("not_found", `The engine has no call ${method} (ghostly engine --list)`);
	const showSecret = parsed.options["show-secret"] === true;
	if (SECRET_RESULTS.has(method) && !showSecret) throw new CliError("confirm", `${method} answers with secrets: add --show-secret to print them`);
	let params;
	const text = raw === "-" ? await readStdin() : raw;
	if (text !== void 0 && text.trim()) try {
		params = JSON.parse(text);
	} catch {
		throw new CliError("usage", "The parameters must be JSON (an object)");
	}
	const confirmReal = parsed.options["confirm-real"] === true;
	if (confirmReal && params && typeof params === "object") params.confirmedReal = true;
	let result = await withSession(g, (s) => s.call("engine.call", {
		method,
		params,
		confirmReal
	}), { offline: ENGINE_READS.includes(method) });
	if (method === "getState" && !showSecret && result && typeof result === "object") {
		const { hideStateSecrets } = await engineApi();
		result = hideStateSecrets(result);
	}
	print(result);
}
async function settingsCommand(sub, argv) {
	const parsed = parseArgs(argv, { "show-secret": {
		type: "boolean",
		description: ""
	} });
	const g = globals(parsed);
	pretty = g.pretty;
	if (sub === "get") {
		noMoreThan(0, parsed.positionals, "settings get [--show-secret]");
		print(await withSession(g, (s) => s.call("settings.get", { showSecret: parsed.options["show-secret"] === true }), { offline: true }));
		return;
	}
	if (sub === "set") {
		const [key, value] = parsed.positionals;
		if (!key || value === void 0 || parsed.positionals.length > 2) throw new CliError("usage", "ghostly settings set <key> <json-value>");
		let parsedValue;
		try {
			parsedValue = JSON.parse(value);
		} catch {
			parsedValue = value;
		}
		if ((await engineApi()).SETTABLE[key] === "string" && typeof parsedValue !== "string") parsedValue = value;
		printAnswer(await withSession(g, (s) => s.call("settings.set", { [key]: parsedValue }), { offline: LOCAL_SETTINGS.has(key) }));
		return;
	}
	throw new CliError("usage", "ghostly settings get | settings set <key> <json-value>");
}
async function textCommand(name, argv) {
	const spec = TEXT_COMMANDS[name];
	const parsed = parseArgs(argv, spec.options, idSlot(spec));
	const g = globals(parsed);
	pretty = g.pretty;
	const [target, ...rest] = parsed.positionals;
	const [message, ...words] = spec.message ? rest : [void 0, ...rest];
	if (!target || spec.message && !message) throw new CliError("usage", `ghostly ${spec.usage}`);
	let text = words.join(" ");
	if (parsed.options.text !== void 0) {
		if (text || parsed.options.stdin) throw new CliError("usage", "Give the text once: as arguments, --text or stdin");
		text = String(parsed.options.text);
	} else if (parsed.options.stdin || !text && !process.stdin.isTTY) {
		if (text) throw new CliError("usage", "Give the text as arguments or on stdin, not both");
		text = (await readStdin()).replace(/\n$/, "");
	}
	if (!text.trim()) throw new CliError("usage", `No text: ghostly ${spec.usage}`);
	const params = {
		[spec.target]: target,
		text,
		force: parsed.options.force === true,
		...message !== void 0 && { message }
	};
	if (spec.target === "group") params.mentions = parsed.options.mention ?? [];
	if (parsed.options.reply !== void 0) params.reply = parsed.options.reply;
	if (!spec.message) Object.assign(params, (await import("./buttons-D9o3JxpE.js")).buttonsOf(parsed.options));
	print(await withSession(g, (s) => {
		if (spec.target === "chat") {
			params.wait = parsed.options.wait ?? (s.mode === "one-shot" ? spec.message ? "confirmed" : "sent" : "none");
			if (parsed.options.timeout !== void 0) params.timeout = parsed.options.timeout;
		} else {
			if (parsed.options.wait !== void 0) params.wait = parsed.options.wait;
			if (parsed.options.timeout !== void 0) params.timeout = parsed.options.timeout;
		}
		return s.call(spec.method, params);
	}, { deferGroups: spec.target === "chat" }));
}
/**
* `identity add`: a proof. An in-app signer finishes in this one command (what it waits on is printed to stderr as it
* comes); a tool or a published record answers with the statement, and `identity complete` finishes it later, in the
* same daemon.
*/
async function identityAddCommand(argv) {
	const parsed = parseArgs(argv, {
		signer: {
			type: "string",
			description: ""
		},
		field: {
			type: "list",
			description: ""
		},
		days: {
			type: "number",
			description: ""
		},
		timeout: {
			type: "number",
			description: ""
		}
	});
	const g = globals(parsed);
	pretty = g.pretty;
	const [provider, ...subject] = parsed.positionals;
	if (!provider) throw new CliError("usage", "ghostly identity add <provider> [subject] [--signer id] [--field name=value]... [--days n]");
	const fields = {};
	for (const item of parsed.options.field ?? []) {
		const eq = item.indexOf("=");
		if (eq < 1) throw new CliError("usage", `--field takes name=value, not ${JSON.stringify(item)}`);
		fields[item.slice(0, eq)] = item.slice(eq + 1);
	}
	const params = {
		provider,
		subject: subject.join(" ") || void 0,
		signer: parsed.options.signer,
		fields,
		days: parsed.options.days,
		timeout: parsed.options.timeout
	};
	const tell = (event) => {
		if (event.type === "identity.approval" || event.type === "identity.progress") process.stderr.write(JSON.stringify(event) + "\n");
	};
	requireProfile(g);
	const client = await connectDaemon(g.paths.socket);
	if (client) {
		await warnVersion(client);
		const watcher = await connectDaemon(g.paths.socket);
		await watcher?.subscribe(void 0, tell);
		try {
			print(await client.call("identity.add", params));
		} finally {
			client.close();
			watcher?.close();
		}
		return;
	}
	const [{ openHost }, { callApi }] = await Promise.all([engineHost(), engineApi()]);
	const host = await openHost(g.paths, "one-shot", VERSION);
	const off = host.ctx.hub.onEvent(tell);
	try {
		const result = await callApi(host.ctx, "identity.add", params);
		if (!result.done) {
			await callApi(host.ctx, "identity.cancel", { draft: result.draft }).catch(() => {});
			throw new CliError("unavailable", "A proof made in two steps waits in the daemon between them: start `ghostly daemon --detach`, then run this again");
		}
		print(result);
	} finally {
		off();
		await host.close();
	}
}
async function tableCommand(name, argv) {
	const command = COMMANDS[name];
	const parsed = parseArgs(argv, command.options ?? {}, idSlot(command));
	const g = globals(parsed);
	pretty = g.pretty;
	const args = positionals(command, parsed.positionals);
	if (command.run) {
		printAnswer(await command.run(parsed, args));
		return;
	}
	const params = command.params?.(parsed, args) ?? {};
	for (const key of Object.keys(params)) if (params[key] === void 0) delete params[key];
	if (command.method === "identity.complete") {
		if (params.evidenceFile) params.evidence = readFileSync(params.evidenceFile, "utf8");
		else if (params.stdin) params.evidence = await readStdin();
		delete params.evidenceFile;
		delete params.stdin;
	}
	if (command.method === "x401.credential.add") {
		try {
			params.credential = params.file === "-" ? await readStdin() : readFileSync(params.file, "utf8");
		} catch (error) {
			throw localFileError(error, params.file) ?? new CliError("usage", `Cannot read the credential: ${error instanceof Error ? error.message : String(error)}`);
		}
		delete params.file;
	}
	const secretWarning = await secretsFromStdin(command.method, params, readStdin, process.stdin.isTTY === true);
	if (secretWarning) process.stderr.write(`ghostly: ${secretWarning}\n`);
	printAnswer(await withSession(g, async (s) => {
		const result = await s.call(command.method, params);
		if (command.method === "invite.join" && s.mode === "one-shot") await s.call("chat.wait", {
			chat: result.chat,
			until: "paired",
			timeout: 60
		}).catch(() => {});
		return result;
	}, {
		deferGroups: chatOnly(command.method, params),
		offline: offlineCall(command.method, params)
	}));
}
/**
* `call pipe`: a call's audio socket bridged to stdin and stdout, for shell pipelines. stdout carries audio only (the
* contact's, raw PCM); what the command says goes to stderr. It ends when the call does.
*/
async function callPipeCommand(argv) {
	const parsed = parseArgs(argv, {}, idSlot({ args: ["call...?"] }));
	const g = globals(parsed);
	const ref = parsed.positionals.join(" ") || void 0;
	const client = await connectDaemon(g.paths.socket);
	if (!client) throw new CliError("unavailable", `No daemon runs profile ${g.profile}: calls need one (ghostly daemon --detach)`);
	let call;
	try {
		call = await client.call("call.get", ref ? { call: ref } : {});
	} finally {
		client.close();
	}
	const audio = call.audio;
	if (!audio) throw new CliError("unavailable", "That call has no audio yet: answer it first");
	const socket = connect(audio.socket);
	await new Promise((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	process.stderr.write(`ghostly: call ${call.call}: s16le mono ${audio.rate} Hz on stdin/stdout\n`);
	process.stdin.pipe(socket, { end: false });
	socket.pipe(process.stdout);
	socket.on("close", () => exit(0));
	socket.on("error", () => exit(1));
}
/**
* The command's words when the line asks for help (`help <words>`, or `--help`/`--help=true`/`-h` before any `--`), else
* null. `--help=false` asks for none: the command runs.
*/
function helpAsked(argv) {
	const end = argv.indexOf("--");
	const head = end === -1 ? argv : argv.slice(0, end);
	const words = (list) => {
		const out = [];
		for (const word of list) {
			if (word.startsWith("-")) break;
			out.push(word);
		}
		return out;
	};
	if (head[0] === "help") return words(head.slice(1));
	if (head.some((word) => word === "--help" || word === "--help=true" || word === "-h")) return words(head);
	return null;
}
async function main(input) {
	const argv = liftGlobals(input);
	const helpFor = argv.length === 0 || globalOption(argv[0]) ? [] : helpAsked(argv);
	if (helpFor) {
		process.stdout.write((helpFor.length ? commandHelp(helpFor) : help()) + "\n");
		return 0;
	}
	if (argv[0] === "--version" || argv[0] === "version") {
		const parsed = parseArgs(argv.slice(1), {});
		noMoreThan(0, parsed.positionals, "version");
		pretty = parsed.options.pretty === true;
		print({ version: VERSION });
		return 0;
	}
	const [first, second, third] = argv;
	const two = second && !second.startsWith("-") ? `${first} ${second}` : "";
	const three = two && third && !third.startsWith("-") ? `${two} ${third}` : "";
	const text = (name) => Object.hasOwn(TEXT_COMMANDS, name), table = (name) => Object.hasOwn(COMMANDS, name);
	if (first === "profile" && !table(two)) {
		await profileCommand(second, argv.slice(2));
		return 0;
	}
	if (first === "daemon") {
		await daemonCommand(argv.slice(1));
		return -1;
	}
	if (first === "listen") {
		await listenCommand(argv.slice(1));
		return -1;
	}
	if (first === "engine") {
		await engineCommand(argv.slice(1));
		return 0;
	}
	if (first === "settings") {
		await settingsCommand(second, argv.slice(2));
		return 0;
	}
	if (two === "identity add") {
		await identityAddCommand(argv.slice(2));
		return 0;
	}
	if (two === "call pipe") {
		await callPipeCommand(argv.slice(2));
		return -1;
	}
	if (three && table(three)) {
		await tableCommand(three, argv.slice(3));
		return 0;
	}
	if (two && text(two)) {
		await textCommand(two, argv.slice(2));
		return 0;
	}
	if (two && table(two)) {
		await tableCommand(two, argv.slice(2));
		return 0;
	}
	if (text(first)) {
		await textCommand(first, argv.slice(1));
		return 0;
	}
	if (table(first)) {
		await tableCommand(first, argv.slice(1));
		return 0;
	}
	throw unknownCommand(first, two ? second : void 0, three ? third : void 0);
}
/**
* A command line that names no command. The words of a group (`ghostly chat`, `ghostly wallet frob`, `ghostly x401
* credential`) are answered with the group's commands, as `ghostly help chat` lists them; before, it was only "Unknown
* command: chat". The longest group the words name answers: `x401 credential frob` lists add, list and remove.
*/
function unknownCommand(first, second, third) {
	const asked = [
		first,
		second,
		third
	].filter((word) => !!word);
	const all = helpRows().map((row) => commandWords(row.usage));
	for (let depth = Math.min(asked.length, 2); depth >= 1; depth--) {
		const group = asked.slice(0, depth), name = group.join(" "), extra = asked[depth];
		const subs = [...new Set(all.filter((words) => words.length > depth && group.every((word, i) => words[i] === word)).map((words) => words[depth]))];
		if (!subs.length) continue;
		const list = `${subs.slice(0, -1).join(", ")}${subs.length > 1 ? " or " : ""}${subs.at(-1)}`;
		return new CliError("usage", extra ? `Unknown command: ${name} ${extra}: ghostly ${name} takes ${list} (ghostly help ${name})` : `ghostly ${name} takes a command: ${list} (ghostly help ${name})`);
	}
	return new CliError("usage", `Unknown command: ${asked.slice(0, 2).join(" ")} (ghostly help)`);
}
/** Leaves once what was printed reached stdout (a pipe drains asynchronously). */
function exit(code) {
	process.stdout.write("", () => process.exit(code));
}
/**
* Stdout is the command's answer and nothing else: one JSON object, or a stream of JSON lines. What the engine notes
* as it works (a relay left alone for a minute, a wallet moved to its network's key) is written with `console.info`
* and the like, which Node sends to stdout: a script reading the answer (`ghostly wallet list | jq`) then failed on a
* line that is not JSON. Those notes go to stderr, where a daemon's log and a terminal still show them.
*/
function notesToStderr() {
	for (const level of [
		"log",
		"info",
		"debug"
	]) console[level] = (...args) => {
		process.stderr.write(`${format(...args)}\n`);
	};
}
/** Runs the command line; `-1` from `main` means the process stays (a daemon, a listener). */
async function run(argv) {
	notesToStderr();
	try {
		const code = await main(argv);
		if (code >= 0) exit(code);
	} catch (error) {
		const failure = asCliError(error);
		print({ error: failure.toJSON() });
		exit(EXIT[failure.code]);
	}
}
//#endregion
export { run };

//# sourceMappingURL=main-_5fsRch3.js.map