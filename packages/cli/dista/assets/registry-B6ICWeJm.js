import { $t as staticDidDocument, Ai as domainTxtRecord, Al as utf8Encode, An as newPubkyProofFolder, Bi as wellKnownUrl, Bt as didGhostlyServiceEntry, Ct as ATPROTO_PROOF_SCOPE, Dl as toBase64Url, Dn as PUBKY_PROOF_MAX_BYTES, Dt as checkAtprotoProofRecord, El as randomBytes, Et as atprotoProofRkey, Fi as normalizeDomain, Fn as homeserverWebEndpoint, Ft as DID_FILE_MAX_BYTES, Gt as didWebFileNames, Ht as didSignedMessages, In as pubkyHomeserverOf, Ji as IdentityCheckUnavailable, Jt as normalizeDid, Kt as didWebFileUrl, Lt as DidError, Mn as pubkyProofCapability, Mt as AtprotoProofError, Nn as pubkyProofFile, Nt as verifyAtprotoRecordProof, On as isPubkyKey, Ot as isAtprotoDid, Pn as pubkyProofPath, Pt as DID_DOCUMENT_MAX_BYTES, Qt as signingKeys, Rt as checkDidJws, St as ATPROTO_PROOF_COLLECTION, Tl as fromBase64Url, Tt as atprotoProofRecord, Ut as didWebDocumentUrl, Vt as didJwsAlg, Wt as didWebFile, Xt as parseDidDocument, Yt as parseDid, Zt as parseDidSignaturePaste, _t as verifyBitcoinMessage, an as resolveDidDht, bt as ATPROTO_DECLARED_SCOPE, dt as SshSigError, en as strictBase64Url, fl as RELAY_PAYLOAD_MAX_BYTES, ft as parseSshPublicKey, gt as verifySshSignature, hl as openRelayPayload, ht as sshSignCommand, ji as domainWellKnownFile, jn as normalizePubkyKey, jt as shortAtprotoDid, ki as dnsProofName, kl as utf8Decode, kn as isPubkyProofFolder, kt as normalizeAtprotoHandle, mt as sameSshKey, pt as parseSshSignature, qt as didWebHost, ut as SSHSIG_NAMESPACE, vt as BitcoinAddressError, xt as ATPROTO_FULL_SCOPE, yt as decodeAnyBitcoinAddress, zt as checkDidSignature } from "./src-dfGE33hw.js";
import { _ as reserveAdapterIds, a as DomainCheckError, c as assertPublicHost, d as ownDid, i as verifiedAtprotoHandle, l as chosenResolver, m as registeredIdentityProviders, n as resolveAtprotoDid, o as assertDomainRecord, r as resolveAtprotoHandle, s as assertNip05, t as assertPublicServer, u as resolverById, v as boundedIdentityFetch } from "./resolve-DjOUKuPc.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { generateSecretKey } from "nostr-tools/pure";
import { decode, npubEncode } from "nostr-tools/nip19";
//#region ../browser/src/proofs/bitcoinWallets.ts
/** What a proof proves and what it does not; shown next to every Bitcoin proof, given or received. */
var BITCOIN_PROOF_LIMITS = [
	"Proves: whoever made this signature could sign with the key behind this address when they signed.",
	"Does not prove the address holds any balance, now or ever.",
	"Does not prove they sent or received any past payment.",
	"Does not prove they would pay you, or spend from this address at all."
];
var BITCOIN_WALLET_GUIDES = [
	{
		id: "sparrow",
		name: "Sparrow Wallet",
		scripts: [
			"p2wpkh",
			"p2tr",
			"p2pkh"
		],
		format: "bip322",
		steps: [
			"Open the wallet that holds the address, then Tools → Sign/Verify Message.",
			"Address: paste the address you are proving.",
			"Message: paste the statement Ghostly shows, exactly as it is.",
			"Format: BIP322 (Simple) for a bc1q… or bc1p… address (tb1… on test networks). For a legacy 1… address, Standard (Electrum).",
			"Sign Message, then copy the whole Signature (it starts with smp…) and paste it into Ghostly."
		],
		testnet: "Tools → Restart In → Testnet or Signet, with a wallet on that network.",
		note: "Sparrow offers BIP322 (Simple) for software wallets only; a connected hardware wallet signs the Standard (Electrum) format, which Ghostly accepts only for a legacy 1… address.",
		docs: "https://sparrowwallet.com/docs/"
	},
	{
		id: "bitcoin-core",
		name: "Bitcoin Core",
		scripts: ["p2pkh"],
		format: "legacy",
		steps: [
			"Bitcoin Core signs messages in the legacy format only, for a legacy address (1… on mainnet, m… or n… on test networks). Make one in the Receive tab with the Base58 (Legacy) type, or with `getnewaddress \"\" legacy`.",
			"GUI: File → Sign message…; paste the address, paste the statement, Sign Message, copy the signature.",
			"Command line: bitcoin-cli signmessage \"<address>\" '<statement>' (single quotes keep the statement's double quotes intact)."
		],
		testnet: "Run it with -signet, -testnet4 or -regtest; add the same flag to bitcoin-cli.",
		docs: "https://developer.bitcoin.org/reference/rpc/signmessage.html"
	},
	{
		id: "electrum",
		name: "Electrum",
		scripts: ["p2pkh"],
		format: "legacy",
		steps: [
			"Electrum signs in the legacy format, which Ghostly accepts only for a legacy 1… address (m…/n… on test networks); its default bc1… wallets need another wallet.",
			"Addresses tab (View → Show Addresses), right-click the address → Sign/verify message.",
			"Paste the statement into Message, click Sign, copy the Signature and paste it into Ghostly."
		],
		testnet: "Start Electrum with --testnet or --signet.",
		docs: "https://electrum.readthedocs.io/"
	},
	{
		id: "coldcard",
		name: "COLDCARD",
		scripts: [
			"p2wpkh",
			"p2tr",
			"p2pkh"
		],
		format: "bip322",
		steps: [
			"Follow COLDCARD's BIP-322 guide for your firmware: it signs the statement for one of its addresses via MicroSD, NFC or QR, depending on the model.",
			"Give it the statement exactly as Ghostly shows it and the address you are proving.",
			"Paste the signature it produces into Ghostly."
		],
		note: "Older firmware signs only the legacy format (Ghostly accepts that for a legacy 1… address) and limits message length and characters.",
		docs: "https://coldcard.com/docs/bip322/"
	},
	{
		id: "trezor",
		name: "Trezor Suite",
		scripts: ["p2pkh"],
		format: "legacy",
		steps: [
			"Trezor signs messages in the legacy format; Ghostly accepts it for an address of a Legacy account (1…).",
			"Open the Legacy account and choose Sign & verify in its menu.",
			"Paste the statement into Message, pick the address, Sign, confirm on the device, copy the signature into Ghostly."
		]
	},
	{
		id: "other",
		name: "Another wallet",
		scripts: [
			"p2wpkh",
			"p2tr",
			"p2sh",
			"p2pkh"
		],
		format: "bip322",
		steps: [
			"Look for \"Sign message\" in the wallet. Choose BIP-322 when it asks for a format.",
			"Sign the statement exactly as Ghostly shows it, with the address you are proving.",
			"A nested SegWit address (3…, or 2… on test networks) needs a full BIP-322 signature (it starts with ful…).",
			"Paste the signature into Ghostly; it tells you right away if it does not match."
		]
	}
];
/** The guides that can sign for an address of this type. */
function guidesFor(script) {
	return BITCOIN_WALLET_GUIDES.filter((g) => g.scripts.includes(script));
}
//#endregion
//#region ../browser/src/proofs/providers/bitcoin.ts
var MAX_SIGNATURE = 8192;
var SIGNATURE = /^(smp|ful|pof)?[A-Za-z0-9+/]+={0,2}$/;
var SCRIPT_NAMES = {
	p2wpkh: "native SegWit (bc1q…)",
	p2tr: "Taproot (bc1p…)",
	p2sh: "nested SegWit (3…)",
	p2pkh: "legacy (1…)",
	p2wsh: "script / multisig (P2WSH)",
	"witness-unknown": "future SegWit version"
};
function normalizeAddress(input) {
	const value = input.trim();
	let info;
	try {
		info = decodeAnyBitcoinAddress(value);
	} catch (e) {
		throw Object.assign(new Error(e instanceof BitcoinAddressError ? e.message : "Enter a Bitcoin address"), { cause: e });
	}
	if (info.type === "p2wsh" || info.type === "witness-unknown") throw new Error("Ghostly can check proofs for single-key addresses only (bc1q…, bc1p…, 3…, 1…), not multisig or script addresses");
	return info.witnessVersion === void 0 ? value : value.toLowerCase();
}
var isTestAddress = (address) => {
	try {
		return decodeAnyBitcoinAddress(address).network === "testnet";
	} catch {
		return false;
	}
};
function shortAddress(address) {
	return `${address.slice(0, address.startsWith("bcrt1") ? 9 : 7)}…${address.slice(-4)}${isTestAddress(address) ? " · test network" : ""}`;
}
/** Wallet steps for this statement's address: the guide's own, or why this wallet cannot sign for it. */
function walletInstructions(guide, statement) {
	const address = statement.binding.subject;
	const info = decodeAnyBitcoinAddress(address);
	const steps = [];
	if (!guide.scripts.includes(info.type)) {
		const others = guidesFor(info.type).filter((g) => g.id !== "other").map((g) => g.name);
		steps.push({ text: `${guide.name} cannot sign for a ${SCRIPT_NAMES[info.type]} address in a format Ghostly accepts.${others.length ? ` Try ${others.join(" or ")}, or another wallet that signs BIP-322.` : " Use a wallet that signs BIP-322."}` });
	} else {
		steps.push({
			text: "Sign exactly this statement, as one line, without adding a line break:",
			copy: statement.text
		});
		steps.push({
			text: "With this address:",
			copy: address
		});
		for (const text of guide.steps) steps.push({ text });
		if (guide.id === "bitcoin-core") steps.push({
			text: `Command line${info.network === "testnet" ? " (add -signet, -testnet4 or -regtest)" : ""}:`,
			copy: `bitcoin-cli signmessage "${address}" '${statement.text}'`
		});
		if (info.network === "testnet" && guide.testnet) steps.push({ text: `Test networks: ${guide.testnet}` });
		if (guide.note) steps.push({ text: guide.note });
	}
	steps.push({ text: "This shows you can sign for the address. It does not show a balance, a past payment, or that you would pay." });
	return {
		steps,
		paste: {
			label: "Signature",
			placeholder: "smp… (BIP-322) or the base64 signature your wallet shows",
			multiline: true
		}
	};
}
function cleanSignature(pasted) {
	const signature = pasted.replace(/\s+/g, "");
	if (!signature) throw new Error("Paste the signature your wallet made");
	if (signature.length > MAX_SIGNATURE || !SIGNATURE.test(signature)) throw new Error("That is not a Bitcoin message signature: paste the whole signature, as the wallet shows it");
	return signature;
}
function check(statement, signature) {
	const address = statement.binding.subject;
	const network = decodeAnyBitcoinAddress(address).network;
	const verdict = verifyBitcoinMessage({
		address,
		message: statement.text,
		signature,
		network
	});
	if (verdict.state !== "valid") throw new Error(verdict.reason);
	return {
		verdict,
		network
	};
}
function walletSigner(guide) {
	return {
		id: guide.id,
		kind: "external-tool",
		label: guide.name,
		description: guide.format === "legacy" ? "Legacy message signature: for a legacy 1… address only." : "BIP-322 message signature.",
		instructions: (statement) => walletInstructions(guide, statement),
		parse(pasted, statement) {
			const signature = cleanSignature(pasted);
			check(statement, signature);
			return { signature };
		}
	};
}
var bitcoin = {
	id: "bitcoin",
	label: "Bitcoin address",
	category: "self-custodied",
	summary: "Sign a message in your own wallet",
	description: "Proves you can sign with the key behind a Bitcoin address: your wallet signs the statement and you paste the signature.",
	limits: "It does not prove a balance, a past payment, or that you would pay.",
	platforms: [
		"web",
		"extension",
		"desktop"
	],
	subject: {
		label: "Bitcoin address",
		placeholder: "bc1q… (tb1… on test networks)",
		help: BITCOIN_PROOF_LIMITS.join(" "),
		normalize: normalizeAddress,
		short: shortAddress
	},
	publicUri: (address) => `bitcoin:${address}`,
	validity: {
		defaultDays: 90,
		maxDays: 365
	},
	privacy: "Nothing: the signature is checked on this device, with no blockchain lookup. Contacts you share it with learn the address.",
	signers: BITCOIN_WALLET_GUIDES.map(walletSigner),
	parseEvidence(raw) {
		const e = raw;
		if (!e || typeof e !== "object" || Array.isArray(e) || Object.keys(e).join(",") !== "signature" || typeof e.signature !== "string" || e.signature.length > MAX_SIGNATURE || !SIGNATURE.test(e.signature)) throw new Error("That is not a Bitcoin message signature");
		return { signature: e.signature };
	},
	async verify(statement, evidence) {
		const { verdict, network } = check(statement, evidence.signature);
		const format = verdict.format === "legacy" ? "Legacy signmessage" : verdict.format === "bip322-full" ? "BIP-322 full" : "BIP-322 simple";
		const script = {
			p2pkh: "P2PKH",
			p2wpkh: "P2WPKH",
			"p2sh-p2wpkh": "P2SH-P2WPKH",
			p2tr: "P2TR"
		}[verdict.script];
		return {
			subject: statement.binding.subject,
			source: `${format} signature, ${script}${network === "testnet" ? ", test network" : ""}`
		};
	}
};
//#endregion
//#region ../browser/src/proofs/nostr.ts
function extensionSigner() {
	return globalThis.nostr;
}
/** No NIP-05 lookup, arbitrary fetch, private key import or automatic relay switching. */
function parseProofBunker(input) {
	if (input.length > 4096) throw new Error("Bunker URL too long");
	let uri;
	try {
		uri = new URL(input);
	} catch {
		throw new Error("Enter a bunker:// connection URL from your signer");
	}
	const relays = uri.searchParams.getAll("relay");
	if (uri.protocol !== "bunker:" || !/^[a-f0-9]{64}$/.test(uri.hostname) || uri.username || uri.password || uri.port || uri.hash || uri.pathname && uri.pathname !== "/" || relays.length < 1 || relays.length > 3) throw new Error("Invalid bunker connection URL");
	for (const address of relays) {
		const relay = new URL(address);
		if (relay.username || relay.password || relay.hash || !(relay.protocol === "wss:" || relay.protocol === "ws:" && [
			"127.0.0.1",
			"localhost",
			"[::1]"
		].includes(relay.hostname))) throw new Error("Use secure wss:// relays (ws:// is allowed only on loopback for local testing)");
	}
	return {
		pubkey: uri.hostname,
		relays,
		secret: uri.searchParams.get("secret")
	};
}
/**
* Runs `work` with the person's Nostr signer: the page's NIP-07 extension, or a NIP-46 bunker. `permissions`
* is what the bunker is asked for (NIP-46 `connect`): the identity proof's `sign_event:30078` by default;
* the social layer asks for the kinds it publishes.
*/
async function withNostrSigner(options, work) {
	options.signal.throwIfAborted();
	let signer;
	let pool;
	let clientKey;
	let timer;
	let abort;
	let closed = false;
	const guard = {
		getPublicKey: async () => {
			if (closed) throw new Error("Signer request cancelled");
			const key = await active.getPublicKey();
			if (closed) throw new Error("Signer request cancelled");
			return key;
		},
		signEvent: async (event) => {
			if (closed) throw new Error("Signer request cancelled");
			const signed = await active.signEvent(event);
			if (closed) throw new Error("Signer request cancelled");
			return signed;
		}
	};
	let active;
	try {
		const timeout = new Promise((_, reject) => {
			abort = () => {
				closed = true;
				reject(/* @__PURE__ */ new Error("Signing cancelled"));
			};
			options.signal.addEventListener("abort", abort, { once: true });
			timer = setTimeout(() => {
				closed = true;
				reject(/* @__PURE__ */ new Error("Signer timed out. Your Ghostly identity is unchanged."));
			}, 12e4);
		});
		const action = async () => {
			if (options.bunker) {
				const bp = parseProofBunker(options.bunker);
				const [{ BunkerSigner }, { SimplePool }] = await Promise.all([import("nostr-tools/nip46"), import("nostr-tools/pool")]);
				if (closed) throw new Error("Signer request cancelled");
				pool = new SimplePool();
				clientKey = generateSecretKey();
				signer = BunkerSigner.fromBunker(clientKey, bp, {
					pool,
					skipSwitchRelays: true,
					onauth: (url) => {
						try {
							const u = new URL(url);
							if (!closed && u.protocol === "https:" && !u.username && !u.password) options.onAuth(u.href);
						} catch {}
					}
				});
				await signer.sendRequest("connect", [
					bp.pubkey,
					bp.secret ?? "",
					options.permissions ?? "sign_event:30078",
					JSON.stringify({ name: options.appName ?? "Ghostly — optional conversation proof" })
				]);
				active = signer;
			} else {
				active = extensionSigner();
				if (!active) throw new Error("No NIP-07 signer in this window. Use a bunker connection from your Nostr signer.");
			}
			if (closed) throw new Error("Signer request cancelled");
			return work(guard);
		};
		return await Promise.race([action(), timeout]);
	} finally {
		closed = true;
		if (timer) clearTimeout(timer);
		if (abort) options.signal.removeEventListener("abort", abort);
		await signer?.close();
		pool?.destroy();
		clientKey?.fill(0);
	}
}
//#endregion
//#region ../browser/src/proofs/providers/nostr.ts
/**
* NIP-78 application data (kind 30078): no new kind is claimed. Signers show it as such; it is never
* published to a relay — the event travels only to the contacts the person shares it with.
*/
var NOSTR_PROOF_KIND = 30078;
var HEX64$1 = /^[a-f0-9]{64}$/;
/** The exact event a signer is asked to sign: the statement as content, dated at issue, expiring with it. */
function nostrProofTemplate(statement) {
	const { issuedAt, expiresAt } = statement.binding;
	return {
		kind: NOSTR_PROOF_KIND,
		created_at: issuedAt,
		content: statement.text,
		tags: [["d", "ghostly-identity-proof"], ["expiration", String(expiresAt)]]
	};
}
var hex$1 = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
var unhex$1 = (s) => Uint8Array.from(s.match(/../g), (x) => parseInt(x, 16));
function normalizeNostrKey(input) {
	const value = input.trim();
	if (HEX64$1.test(value.toLowerCase())) return value.toLowerCase();
	if (value.startsWith("npub1")) try {
		const decoded = decode(value);
		if (decoded.type === "npub") return decoded.data;
	} catch {}
	throw new Error("Enter a Nostr public key: npub1… or 64 hex characters");
}
function nostrSigner(id) {
	return {
		id,
		kind: "in-app",
		label: id === "nip07" ? "Browser extension (NIP-07)" : "Remote signer (NIP-46)",
		description: id === "nip07" ? "Approve in the Nostr extension of this browser." : "Paste the bunker:// link from your signer app, then approve there.",
		fields: id === "nip46" ? [{
			name: "bunker",
			label: "Signer connection link",
			kind: "secret",
			placeholder: "bunker://…"
		}] : void 0,
		platforms: id === "nip07" ? ["web", "desktop"] : void 0,
		available: id === "nip07" ? () => !!extensionSigner() : void 0,
		run: (ctx, work) => withNostrSigner({
			bunker: id === "nip46" ? ctx.values.bunker : void 0,
			signal: ctx.signal,
			onAuth: ctx.onAuthUrl
		}, (signer) => {
			return work({
				subject: async () => normalizeNostrKey(await signer.getPublicKey()),
				sign: async (statement) => {
					ctx.onProgress("Approve the Ghostly identity statement in your signer.");
					return await signer.signEvent(nostrProofTemplate(statement));
				}
			});
		})
	};
}
var nostr = {
	id: "nostr",
	label: "Nostr",
	category: "self-custodied",
	summary: "Sign once with your Nostr signer",
	description: "Proves you hold a Nostr key: your signer signs the statement, your key never leaves it.",
	platforms: [
		"web",
		"extension",
		"desktop"
	],
	subject: {
		label: "Public key",
		placeholder: "npub1…",
		normalize: normalizeNostrKey,
		short: (key) => {
			const npub = npubEncode(key);
			return `${npub.slice(0, 10)}…${npub.slice(-4)}`;
		}
	},
	publicUri: (key) => `nostr:${npubEncode(key)}`,
	validity: {
		defaultDays: 90,
		maxDays: 365
	},
	privacy: "Nothing: the signature is checked on this device. The proof is never published to a relay.",
	signers: [nostrSigner("nip07"), nostrSigner("nip46")],
	parseEvidence(raw) {
		const e = raw;
		if (!e || typeof e !== "object" || Array.isArray(e) || Object.keys(e).sort().join(",") !== "content,created_at,id,kind,pubkey,sig,tags" || typeof e.id !== "string" || !HEX64$1.test(e.id) || typeof e.pubkey !== "string" || !HEX64$1.test(e.pubkey) || typeof e.sig !== "string" || !/^[a-f0-9]{128}$/.test(e.sig) || !Number.isSafeInteger(e.kind) || !Number.isSafeInteger(e.created_at) || typeof e.content !== "string" || e.content.length > 2048 || !Array.isArray(e.tags) || e.tags.length > 4 || !e.tags.every((t) => Array.isArray(t) && t.length <= 4 && t.every((x) => typeof x === "string" && x.length <= 128))) throw new Error("That is not a signed Nostr event");
		return {
			id: e.id,
			pubkey: e.pubkey,
			created_at: e.created_at,
			kind: e.kind,
			tags: e.tags.map((t) => [...t]),
			content: e.content,
			sig: e.sig
		};
	},
	async verify(statement, event) {
		const expected = nostrProofTemplate(statement);
		if (event.pubkey !== statement.binding.subject) throw new Error("Signed by another Nostr key");
		if (event.kind !== expected.kind || event.created_at !== expected.created_at || event.content !== expected.content || JSON.stringify(event.tags) !== JSON.stringify(expected.tags)) throw new Error("The signer did not sign the exact Ghostly statement");
		const id = hex$1(sha256(utf8Encode(JSON.stringify([
			0,
			event.pubkey,
			event.created_at,
			event.kind,
			event.tags,
			event.content
		]))));
		if (event.id !== id) throw new Error("The Nostr event id does not match its content");
		let valid;
		try {
			valid = schnorr.verify(unhex$1(event.sig), unhex$1(id), unhex$1(event.pubkey));
		} catch {
			valid = false;
		}
		if (!valid) throw new Error("Invalid Nostr signature");
		return {
			subject: event.pubkey,
			source: "Nostr signature (NIP-01, BIP-340)"
		};
	}
};
//#endregion
//#region ../browser/src/proofs/providers/domain.ts
var recordFor = (s) => ({
	key: s.binding.key,
	proof: s.id
});
var exactKeys$2 = (raw, keys) => !!raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).sort().join(",") === keys;
var dnsSigner = {
	id: "dns",
	kind: "publish",
	label: "DNS TXT record",
	description: "Add a TXT record at your DNS host. Contacts' apps look it up through a DNS-over-HTTPS resolver.",
	instructions(statement) {
		const domain = statement.binding.subject;
		return { steps: [
			{
				text: `Open the DNS settings of ${domain} at your registrar or DNS host and add a TXT record with this name. Some hosts add the domain themselves: then enter only the part before ${domain}.`,
				copy: dnsProofName(domain)
			},
			{
				text: "Value (one string, exactly as shown):",
				copy: domainTxtRecord(recordFor(statement))
			},
			{ text: "Set the TTL to 300 seconds or less, so removing the record takes effect quickly. Then press Check: DNS changes can take a few minutes to appear." },
			{ text: "The record stays public while the proof is in use. Removing it withdraws this proof from every contact at their next check." }
		] };
	},
	evidence: () => ({ method: "dns" })
};
var httpsSigner = {
	id: "https",
	kind: "publish",
	label: "File on your website",
	description: "Upload a small file to your website. Contacts' apps download it from your server.",
	instructions(statement) {
		const domain = statement.binding.subject;
		return { steps: [
			{
				text: `Create this file on the web server of ${domain}:`,
				copy: wellKnownUrl(domain)
			},
			{
				text: "With exactly this content:",
				copy: domainWellKnownFile([recordFor(statement)])
			},
			{
				text: "Serve it over HTTPS at exactly that address, without any redirect (not even to www), and with this header so browsers may read it:",
				copy: "Access-Control-Allow-Origin: *"
			},
			{ text: "Then press Check. The file stays public while the proof is in use; deleting it withdraws this proof from every contact at their next check." }
		] };
	},
	evidence: () => ({ method: "https" })
};
var domainField = {
	name: "domain",
	label: "Domain",
	kind: "text",
	placeholder: "example.com",
	help: "Its /.well-known/nostr.json must name this Nostr key for \"_\" (the domain itself)."
};
/** NIP-05: the statement is signed by the Nostr key the domain's nostr.json names for itself. */
function nip05Signer(id) {
	const extension = id === "nip05-nip07";
	return {
		id,
		kind: "in-app",
		label: extension ? "NIP-05 with a browser extension" : "NIP-05 with a remote signer",
		description: "Already run NIP-05? Sign with the Nostr key your domain's nostr.json names for itself. No new record needed.",
		fields: extension ? [domainField] : [domainField, {
			name: "bunker",
			label: "Signer connection link",
			kind: "secret",
			placeholder: "bunker://…"
		}],
		platforms: extension ? ["web", "desktop"] : void 0,
		available: extension ? () => !!extensionSigner() : void 0,
		run: (ctx, work) => {
			const domain = normalizeDomain(ctx.values.domain ?? "");
			return withNostrSigner({
				bunker: extension ? void 0 : ctx.values.bunker,
				signal: ctx.signal,
				onAuth: ctx.onAuthUrl
			}, (signer) => {
				return work({
					subject: async () => domain,
					sign: async (statement) => {
						ctx.onProgress("Approve the Ghostly identity statement in your signer.");
						return {
							method: "nip05",
							event: await signer.signEvent(nostrProofTemplate(statement))
						};
					}
				});
			});
		}
	};
}
var domain = {
	id: "domain",
	label: "Domain",
	category: "self-custodied",
	summary: "A DNS record or a file on your site",
	description: "Proves you control a domain name: publish a DNS TXT record or a file on its website, once. Contacts' apps look it up when you share it and can check again later.",
	limits: "Does not prove who runs the domain, only that whoever added the proof could publish under it.",
	platforms: [
		"web",
		"extension",
		"desktop"
	],
	subject: {
		label: "Domain",
		placeholder: "example.com",
		help: "A domain or subdomain you control. A proof for alice.example.com is published under alice.example.com.",
		normalize: normalizeDomain
	},
	publicUri: (domain) => `https://${domain}`,
	validity: {
		defaultDays: 90,
		maxDays: 365
	},
	recheck: { afterSeconds: 86400 },
	privacy: "DNS: the contact's app asks the DNS-over-HTTPS resolver chosen in its settings (Quad9 by default; the next of Quad9, Cloudflare and Google when it cannot be reached) for the record, so that resolver learns the domain was checked. Website or NIP-05: the resolver learns the domain, and the domain's web server sees the contact's IP address.",
	signers: [
		dnsSigner,
		httpsSigner,
		nip05Signer("nip05-nip07"),
		nip05Signer("nip05-nip46")
	],
	parseEvidence(raw) {
		const e = raw;
		if (exactKeys$2(raw, "method") && (e.method === "dns" || e.method === "https")) return { method: e.method };
		if (exactKeys$2(raw, "event,method") && e.method === "nip05") return {
			method: "nip05",
			event: nostr.parseEvidence(e.event)
		};
		throw new Error("That is not domain proof evidence");
	},
	async verify(statement, evidence, ctx) {
		const subject = statement.binding.subject;
		if (normalizeDomain(subject) !== subject) throw new Error("The domain is not in canonical form");
		const resolver = chosenResolver();
		const options = {
			fetch: ctx.fetch,
			signal: ctx.signal,
			resolver: resolver.id,
			now: () => ctx.now * 1e3
		};
		if (evidence.method === "nip05") {
			await nostr.verify({
				...statement,
				binding: {
					...statement.binding,
					subject: evidence.event.pubkey
				}
			}, evidence.event, ctx);
			await assertNip05(subject, evidence.event.pubkey, options);
			return {
				subject,
				source: `Nostr signature by the key ${wellKnownUrl(subject, "nip05")} names for ${subject}`
			};
		}
		const found = await assertDomainRecord(subject, evidence.method, recordFor(statement), options);
		return {
			subject,
			source: evidence.method === "dns" ? `DNS TXT record at ${dnsProofName(subject)}, via ${resolverById(found.resolver).name}${found.dnssec ? ", DNSSEC validated" : ""}` : `File at ${wellKnownUrl(subject)}`
		};
	}
};
//#endregion
//#region ../browser/src/proofs/openpgp.ts
/**
* OpenPGP identity proofs (RFC 9580, and the RFC 4880 v4 keys people actually have).
*
* The person signs a Ghostly statement once — the binding by which their
* OpenPGP key authorizes a Ghostly proof key (see PROOFS.md); each chat
* then gets a presentation the app signs itself. They sign with their own tooling —
* `gpg --clearsign`, `gpg --detach-sign --armor`, a YubiKey or another OpenPGP
* card behind gpg — and pastes the result with their public key. No secret key
* ever enters Ghostly: a pasted private key is refused before it is parsed.
*
* What is shared with a contact is small and self-contained: one signature
* packet and a minimal copy of the public key (the primary key, its user IDs
* with their self-signatures, the subkey that signed). The contact verifies it
* locally with the statement their own app builds; nothing is fetched.
*
* A key's user IDs are claims its holder wrote. Possession of the key proves
* control of the key, not that a name or an email in a user ID belongs to the
* person — the UI must say so wherever user IDs are shown.
*
* OpenPGP.js is loaded lazily (the "lightweight" build: ~233 KB minified,
* ~64 KB gzipped, plus a ~46 KB curve chunk only for ECDSA keys), so nobody
* pays for it until an OpenPGP proof is opened.
*/
var PGP_SCHEME = "openpgp/1";
/** Strict size limits. Pasted input is the person's own; shared input comes from a peer. */
var PGP_LIMITS = {
	/** A clearsigned statement or an armored detached signature. RSA-4096 with the statement is ~1.5 KB. */
	pastedSignature: 16384,
	/** An armored public key as exported, before it is minimized. Flooded keys are refused, not trimmed. */
	pastedKey: 262144,
	/** One signature packet, binary. RSA-4096 with the usual subpackets is ~600 bytes. */
	sharedSignature: 1536,
	/** The minimal key, binary. Both fit, base64url, in the contract's 16 KiB of evidence JSON. */
	sharedKey: 9216,
	/** User IDs kept in the minimal key and shown. */
	userIds: 16,
	/** Bytes per user ID. */
	userIdLength: 256,
	/** A keyserver response. */
	keyserverResponse: 262144
};
var loading;
/** The only place OpenPGP.js is imported: a separate chunk, fetched on first use. */
function loadOpenPgp() {
	loading ??= import("./openpgp-BBFr-zHQ.js").then((m) => m).catch((e) => {
		loading = void 0;
		throw e;
	});
	return loading;
}
function config(pgp) {
	const { hash, publicKey, curve } = pgp.enums;
	return {
		minRSABits: 2048,
		maxUserIDLength: PGP_LIMITS.userIdLength,
		enableParsingV5Entities: false,
		ignoreUnsupportedPackets: true,
		ignoreMalformedPackets: false,
		rejectHashAlgorithms: /* @__PURE__ */ new Set([hash.md5, hash.ripemd]),
		rejectMessageHashAlgorithms: /* @__PURE__ */ new Set([
			hash.md5,
			hash.ripemd,
			hash.sha1
		]),
		rejectPublicKeyAlgorithms: /* @__PURE__ */ new Set([publicKey.elgamal, publicKey.dsa]),
		rejectCurves: /* @__PURE__ */ new Set([curve.secp256k1])
	};
}
/** The allowlist, checked on the primary key and on the key that signs. */
function allowedAlgorithm(packet, signing) {
	const { algorithm, bits, curve } = packet.getAlgorithmInfo();
	const names = {
		nistP256: "P-256",
		nistP384: "P-384",
		nistP521: "P-521",
		brainpoolP256r1: "brainpoolP256r1",
		brainpoolP384r1: "brainpoolP384r1",
		brainpoolP512r1: "brainpoolP512r1"
	};
	if ((algorithm === "rsaEncryptSign" || algorithm === "rsaSign" && signing) && bits && bits >= 2048) return `RSA ${bits}`;
	if (algorithm === "ed25519" || algorithm === "eddsaLegacy" && curve === "ed25519Legacy") return "Ed25519";
	if (algorithm === "ed448") return "Ed448";
	if (algorithm === "ecdsa" && curve && names[curve]) return `ECDSA ${names[curve]}`;
	throw new PgpProofError(`This key uses ${algorithm.startsWith("rsa") ? `RSA ${bits ?? "?"}` : curve ? `${algorithm} ${curve}` : algorithm}, which Ghostly does not accept. Use Ed25519, ECDSA (P-256, P-384, P-521, brainpool) or RSA with at least 2048 bits.`);
}
var ALLOWED_HASHES = /* @__PURE__ */ new Set([
	8,
	9,
	10,
	11,
	12,
	14
]);
var PgpProofError = class extends Error {
	name = "PgpProofError";
};
/** Armored blocks in pasted text; more BEGIN lines than any real paste has are refused before the regex scans. */
function armorBlocks(text) {
	if ((text.match(/-----BEGIN PGP /g) ?? []).length > 4) throw new PgpProofError("Paste only what gpg printed: one signature and your public key.");
	return [...text.matchAll(ARMOR)];
}
var ARMOR = /-----BEGIN PGP SIGNED MESSAGE-----[\s\S]*?-----END PGP SIGNATURE-----|-----BEGIN PGP ([A-Z ,/0-9]+)-----[\s\S]*?-----END PGP \1-----/g;
/** The single armored block in pasted text (terminal output may surround it). */
function armoredBlock(text, what) {
	if (/PRIVATE KEY BLOCK/.test(text)) throw new PgpProofError("This is a PRIVATE key. Never paste it anywhere: Ghostly only needs your public key (gpg --armor --export).");
	const blocks = armorBlocks(text);
	if (blocks.length === 0) throw new PgpProofError(what === "key" ? "Paste an armored public key: it starts with -----BEGIN PGP PUBLIC KEY BLOCK-----." : "Paste the whole signed text: it starts with -----BEGIN PGP SIGNED MESSAGE----- (or -----BEGIN PGP SIGNATURE----- for a detached signature).");
	if (blocks.length > 1) throw new PgpProofError(`Paste only one ${what === "key" ? "public key" : "signature"}.`);
	return {
		type: blocks[0][1] ?? "SIGNED MESSAGE",
		block: blocks[0][0]
	};
}
function secondsOf(date) {
	if (date === null || date === Infinity) return null;
	return Math.floor((date instanceof Date ? date.getTime() : date) / 1e3);
}
var hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
var nowSeconds = () => Math.floor(Date.now() / 1e3);
/** Clearsigned text as it is hashed: trailing whitespace dropped, no final newline. */
function canonicalStatement(statement) {
	return statement.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n").replace(/\n+$/, "");
}
/**
* One paste holding what gpg printed: the signed statement (clearsigned, or a detached signature) and,
* optionally, the public key. Anything around the blocks (prompts, blank lines) is ignored.
*/
function splitPgpPaste(pasted) {
	if (typeof pasted !== "string" || pasted.length > PGP_LIMITS.pastedKey + PGP_LIMITS.pastedSignature) throw new PgpProofError("This is too large. Paste only what gpg printed.");
	if (/PRIVATE KEY BLOCK/.test(pasted)) throw new PgpProofError("This is a PRIVATE key. Never paste it anywhere: Ghostly only needs your public key (gpg --armor --export).");
	const blocks = armorBlocks(pasted).map((m) => ({
		type: m[1] ?? "SIGNED MESSAGE",
		block: m[0]
	}));
	const keys = blocks.filter((b) => b.type === "PUBLIC KEY BLOCK"), others = blocks.filter((b) => b.type !== "PUBLIC KEY BLOCK");
	if (keys.length > 1) throw new PgpProofError("Paste only one public key.");
	if (others.length === 0) throw new PgpProofError("Paste the signed statement too: it starts with -----BEGIN PGP SIGNED MESSAGE-----.");
	if (others.length > 1) throw new PgpProofError("Paste only one signature.");
	return {
		signature: others[0].block,
		publicKey: keys[0]?.block
	};
}
/** Refuses a statement that `gpg --clearsign` would alter (dash-escaping, trailing spaces) or that is not plain text. */
function assertSignableStatement(statement) {
	if (!statement || statement.length > 4096 || statement !== canonicalStatement(statement) || /^-/m.test(statement) || /[^\x20-\x7e\n]/.test(statement)) throw new PgpProofError("Statement is not signable as plain text");
}
/** Why a key or a subkey is not usable now, in words the person can act on. */
async function explainInvalidKey(key, keyId, at, cfg, when) {
	const past = when === "signing" ? " when it signed" : "";
	if (await key.isRevoked(void 0, void 0, at, cfg).catch(() => false)) throw new PgpProofError(`This key has been revoked${past}. A revoked key proves nothing.`);
	try {
		await key.verifyPrimaryKey(at, void 0, cfg);
	} catch (e) {
		const expiry = await key.getExpirationTime(void 0, cfg).catch(() => null);
		if (expiry instanceof Date && expiry <= at) throw new PgpProofError(`This key expired on ${expiry.toISOString().slice(0, 10)}${past}. Extend its expiry (gpg --quick-set-expire) and export it again.`);
		throw new PgpProofError(`This key is not valid${past}: ${message(e)}`);
	}
	const sub = keyId ? key.getSubkeys(keyId)[0] : void 0;
	if (sub) {
		if (sub.revocationSignatures.length && await sub.verify(at, cfg).then(() => false, (e) => /revoked/i.test(message(e)))) throw new PgpProofError(`The subkey that signed (${sub.getFingerprint().toUpperCase()}) has been revoked${past}.`);
		const expiry = await sub.getExpirationTime(at, cfg).catch(() => null);
		if (expiry instanceof Date && expiry <= at) throw new PgpProofError(`The subkey that signed expired on ${expiry.toISOString().slice(0, 10)}${past}.`);
		throw new PgpProofError(`The subkey that signed is not a valid signing subkey${past}.`);
	}
	throw new PgpProofError(`The key that signed is not a valid signing key${past}.`);
}
var message = (e) => e instanceof Error ? e.message : String(e);
/** Parses exactly one public key; refuses private keys, v3/v5 keys and key rings. */
async function readOneKey(pgp, input) {
	const cfg = config(pgp);
	let keys;
	try {
		keys = "armored" in input ? await pgp.readKeys({
			armoredKeys: input.armored,
			config: cfg
		}) : await pgp.readKeys({
			binaryKeys: input.binary,
			config: cfg
		});
	} catch (e) {
		throw new PgpProofError(`Could not read this public key: ${message(e)}`);
	}
	if (keys.length !== 1) throw new PgpProofError("Paste one public key, not a key ring.");
	const [key] = keys;
	if (key.isPrivate()) throw new PgpProofError("This is a PRIVATE key. Ghostly only needs your public key (gpg --armor --export).");
	const version = key.keyPacket.version;
	if (version !== 4 && version !== 6) throw new PgpProofError(`OpenPGP v${version} keys are not accepted; use a v4 (RFC 4880) or v6 (RFC 9580) key.`);
	return key;
}
/** Valid, unrevoked, self-certified user IDs at `at`. */
async function validUserIds(key, at, cfg) {
	const valid = [];
	for (const user of key.users) {
		if (!user.userID || valid.length >= PGP_LIMITS.userIds) continue;
		if (await user.verify(at, cfg).then(() => true, () => false)) valid.push(user);
	}
	return valid;
}
/**
* The transferable key a contact receives: primary key and its direct/revocation
* signatures, valid user IDs with self-certifications only (third-party
* certifications and photos dropped), and the one subkey that signed.
*/
async function minimalKey(pgp, key, signer, at, cfg) {
	const packets = new pgp.PacketList();
	packets.push(key.keyPacket, ...key.revocationSignatures);
	const direct = key.directSignatures ?? [];
	packets.push(...direct);
	for (const user of await validUserIds(key, at, cfg)) packets.push(user.userID, ...user.selfCertifications, ...user.revocationSignatures);
	if (signer !== key) {
		const sub = signer;
		packets.push(sub.keyPacket, ...sub.bindingSignatures, ...sub.revocationSignatures);
	}
	const bytes = new pgp.PublicKey(packets).write();
	if (bytes.length > PGP_LIMITS.sharedKey) throw new PgpProofError("This key is too large to share, even without third-party certifications. Remove old user IDs or use a smaller key.");
	return bytes;
}
async function keyInfo(key, signer, algorithm, at, cfg) {
	const expiry = await key.getExpirationTime(void 0, cfg).catch(() => null);
	const subExpiry = signer !== key ? await signer.getExpirationTime(at, cfg).catch(() => null) : null;
	const expires = [secondsOf(expiry), secondsOf(subExpiry)].filter((x) => x !== null);
	return {
		fingerprint: key.getFingerprint().toUpperCase(),
		signingFingerprint: signer.getFingerprint().toUpperCase(),
		version: key.keyPacket.version,
		algorithm,
		createdAt: secondsOf(key.getCreationTime()),
		expiresAt: expires.length ? Math.min(...expires) : null,
		userIds: (await validUserIds(key, at, cfg)).map((u) => u.userID.userID)
	};
}
/** What a pasted public key is, before anything is signed: fingerprint and user IDs to show. */
async function readPgpPublicKey(armored, options = {}) {
	if (typeof armored !== "string" || armored.length > PGP_LIMITS.pastedKey) throw new PgpProofError("This public key is too large. Export it with --export-options export-minimal.");
	const { type, block } = armoredBlock(armored, "key");
	if (type !== "PUBLIC KEY BLOCK") throw new PgpProofError("Paste a public key block (gpg --armor --export).");
	const pgp = await loadOpenPgp();
	const cfg = config(pgp);
	const key = await readOneKey(pgp, { armored: block });
	const at = /* @__PURE__ */ new Date((options.now ?? nowSeconds()) * 1e3);
	allowedAlgorithm(key.keyPacket, false);
	let signer;
	try {
		signer = await key.getSigningKey(void 0, at, void 0, cfg);
	} catch {
		return explainInvalidKey(key, void 0, at, cfg, "now");
	}
	return keyInfo(key, signer, allowedAlgorithm(signer.keyPacket, true), at, cfg);
}
async function readSignaturePacket(pgp, input) {
	let sig;
	try {
		sig = "armored" in input ? await pgp.readSignature({
			armoredSignature: input.armored,
			config: config(pgp)
		}) : await pgp.readSignature({
			binarySignature: input.binary,
			config: config(pgp)
		});
	} catch (e) {
		throw new PgpProofError(`Could not read this signature: ${message(e)}`);
	}
	const packets = sig.packets.filterByTag(pgp.enums.packet.signature);
	if (sig.packets.length !== 1 || packets.length !== 1) throw new PgpProofError("Sign with one key only: this signature has several signers.");
	return packets[0];
}
/**
* The core check, shared by the person (on paste) and the contact (on receipt):
* one signature over the statement, by a key or signing subkey of `key` that is
* valid both when it signed and now, with allowed algorithms and hash.
*/
async function verifyPacket(pgp, key, sig, statement, options) {
	const cfg = config(pgp);
	const now = options.now ?? nowSeconds();
	const at = /* @__PURE__ */ new Date(now * 1e3);
	const { signature } = pgp.enums;
	if (sig.signatureType !== signature.text && sig.signatureType !== signature.binary) throw new PgpProofError("This is not a signature over a text or a file.");
	if (sig.hashAlgorithm === null || !ALLOWED_HASHES.has(sig.hashAlgorithm)) throw new PgpProofError("This signature uses a weak hash (SHA-1 or older). Sign again with gpg's default (SHA-256 or stronger): --digest-algo SHA256.");
	if (!sig.created) throw new PgpProofError("This signature has no creation time.");
	const signedAt = secondsOf(sig.created);
	if (signedAt > now + 300) throw new PgpProofError("This signature is dated in the future. Check the clock of the machine that signed.");
	if (options.expectedFingerprint !== void 0 && key.getFingerprint().toUpperCase() !== options.expectedFingerprint.toUpperCase()) throw new PgpProofError("This key is not the one the statement names.");
	const issuer = key.getKeys(sig.issuerKeyID)[0];
	if (!issuer) throw new PgpProofError(`This signature was made by another key (${sig.issuerKeyID.toHex().toUpperCase()}), not the public key given.`);
	if (sig.issuerFingerprint && hexOf(sig.issuerFingerprint) !== issuer.getFingerprint().toUpperCase()) throw new PgpProofError("This signature was made by another key, not the public key given.");
	allowedAlgorithm(key.keyPacket, false);
	let signer;
	try {
		signer = await key.getSigningKey(sig.issuerKeyID, at, void 0, cfg);
	} catch {
		return explainInvalidKey(key, sig.issuerKeyID, at, cfg, "now");
	}
	const algorithm = allowedAlgorithm(signer.keyPacket, true);
	const created = /* @__PURE__ */ new Date(Math.min(signedAt, now) * 1e3);
	try {
		await key.getSigningKey(sig.issuerKeyID, created, void 0, cfg);
	} catch {
		return explainInvalidKey(key, sig.issuerKeyID, created, cfg, "signing");
	}
	if (options.signedAfter !== void 0 && signedAt < options.signedAfter - 300) throw new PgpProofError("This signature is older than the statement it should sign.");
	const text = canonicalStatement(statement);
	const packets = new pgp.PacketList();
	packets.push(sig);
	const detached = new pgp.Signature(packets);
	let verified = false;
	for (const candidate of [
		text,
		`${text}\n`,
		`${text}\r\n`
	]) {
		const message = await pgp.createMessage({ binary: utf8Encode(candidate) });
		const result = await pgp.verify({
			message,
			signature: detached,
			verificationKeys: key,
			date: /* @__PURE__ */ new Date(Math.max(now, signedAt) * 1e3),
			config: cfg
		});
		if (result.signatures.length === 1 && await result.signatures[0].verified.then(() => true, () => false)) {
			verified = true;
			break;
		}
	}
	if (!verified) throw new PgpProofError("This signature is not over the Ghostly statement (it signs other text, or it was changed).");
	return {
		info: {
			...await keyInfo(key, signer, algorithm, at, cfg),
			signedAt
		},
		signer
	};
}
/**
* The person's side: checks what they pasted against the statement and
* produces the evidence to share. Either a clearsigned statement or an
* armored detached signature is accepted.
*/
async function preparePgpEvidence(input, options = {}) {
	if (typeof input.signature !== "string" || input.signature.length > PGP_LIMITS.pastedSignature) throw new PgpProofError("This signature is too large. Paste only the output of gpg --clearsign.");
	if (typeof input.publicKey !== "string" || input.publicKey.length > PGP_LIMITS.pastedKey) throw new PgpProofError("This public key is too large. Export it with --export-options export-minimal.");
	const { type, block } = armoredBlock(input.signature, "signature");
	const keyBlock = armoredBlock(input.publicKey, "key");
	if (keyBlock.type !== "PUBLIC KEY BLOCK") throw new PgpProofError("Paste a public key block (gpg --armor --export).");
	if (type === "MESSAGE") throw new PgpProofError("This is a signed message (gpg --sign). Use gpg --clearsign, or --detach-sign --armor.");
	if (type === "PUBLIC KEY BLOCK") throw new PgpProofError("This is a public key; paste it in the public key field and the signature here.");
	const pgp = await loadOpenPgp();
	const key = await readOneKey(pgp, { armored: keyBlock.block });
	let sig;
	if (type === "SIGNED MESSAGE") {
		let cleartext;
		try {
			cleartext = await pgp.readCleartextMessage({
				cleartextMessage: block,
				config: config(pgp)
			});
		} catch (e) {
			throw new PgpProofError(`Could not read this signed text: ${message(e)}`);
		}
		if (canonicalStatement(cleartext.getText()) !== canonicalStatement(input.statement)) throw new PgpProofError("This signs different text. Sign exactly the statement shown, without editing it.");
		const packets = cleartext.signature.packets;
		if (packets.length !== 1 || !(packets[0] instanceof pgp.SignaturePacket)) throw new PgpProofError("Sign with one key only: this signature has several signers.");
		sig = packets[0];
	} else if (type === "SIGNATURE") sig = await readSignaturePacket(pgp, { armored: block });
	else throw new PgpProofError("Paste the output of gpg --clearsign (or gpg --detach-sign --armor).");
	const { info, signer } = await verifyPacket(pgp, key, sig, input.statement, options);
	const single = new pgp.PacketList();
	single.push(sig);
	const signature = new pgp.Signature(single).write();
	if (signature.length > PGP_LIMITS.sharedSignature) throw new PgpProofError("This signature is too large to share.");
	const at = /* @__PURE__ */ new Date((options.now ?? nowSeconds()) * 1e3);
	return {
		evidence: {
			scheme: PGP_SCHEME,
			key: toBase64Url(await minimalKey(pgp, key, signer, at, config(pgp))),
			signature: toBase64Url(signature)
		},
		verified: info
	};
}
var b64 = /^[A-Za-z0-9_-]+$/;
/** Untrusted evidence off the wire: exact shape, bounded, canonical base64url. Checked before any OpenPGP parsing. */
function parsePgpEvidence(raw) {
	const e = raw;
	if (!e || typeof e !== "object" || Array.isArray(e) || e.scheme !== "openpgp/1" || Object.keys(e).sort().join(",") !== "key,scheme,signature" || typeof e.key !== "string" || typeof e.signature !== "string" || !b64.test(e.key) || !b64.test(e.signature) || e.key.length > Math.ceil(PGP_LIMITS.sharedKey * 4 / 3) || e.signature.length > Math.ceil(PGP_LIMITS.sharedSignature * 4 / 3)) throw new PgpProofError("Invalid OpenPGP proof");
	let canonical;
	try {
		canonical = toBase64Url(fromBase64Url(e.key)) === e.key && toBase64Url(fromBase64Url(e.signature)) === e.signature;
	} catch {
		canonical = false;
	}
	if (!canonical) throw new PgpProofError("Invalid OpenPGP proof encoding");
	return {
		scheme: PGP_SCHEME,
		key: e.key,
		signature: e.signature
	};
}
/** The contact's side: verifies shared evidence against the statement their own app built. */
async function verifyPgpEvidence(raw, statement, options = {}) {
	const evidence = parsePgpEvidence(raw);
	const keyBytes = fromBase64Url(evidence.key), sigBytes = fromBase64Url(evidence.signature);
	const pgp = await loadOpenPgp();
	return (await verifyPacket(pgp, await readOneKey(pgp, { binary: keyBytes }), await readSignaturePacket(pgp, { binary: sigBytes }), statement, options)).info;
}
/** Groups of four, as gpg prints fingerprints. */
function formatFingerprint(fingerprint) {
	return fingerprint.replace(/(.{4})/g, "$1 ").trim();
}
/** keys.openpgp.org publishes a user ID only after its owner confirms the email. */
var KEYSERVER = "https://keys.openpgp.org";
/**
* Fetches a public key from keys.openpgp.org. Only ever called when the person
* asks for it, after the UI said this contacts that server.
*/
async function fetchKeyFromKeyserver(query, options = {}) {
	const q = query.trim().replace(/\s+/g, "").replace(/^0x/i, "");
	let path;
	if (/^[A-Fa-f0-9]{40}$/.test(q) || /^[A-Fa-f0-9]{64}$/.test(q)) path = `/vks/v1/by-fingerprint/${q.toUpperCase()}`;
	else if (/^[^\s@<>]{1,64}@[^\s@<>]{1,190}$/.test(query.trim())) path = `/vks/v1/by-email/${encodeURIComponent(query.trim())}`;
	else throw new PgpProofError("Enter a full fingerprint (40 hex characters) or an email address.");
	const response = await (options.fetch ?? fetch)(`${KEYSERVER}${path}`, {
		signal: options.signal,
		credentials: "omit",
		referrerPolicy: "no-referrer",
		redirect: "error"
	});
	if (response.status === 404) throw new PgpProofError("keys.openpgp.org has no key for this. Paste your public key instead.");
	if (!response.ok) throw new PgpProofError(`keys.openpgp.org answered ${response.status}. Paste your public key instead.`);
	if (Number(response.headers.get("content-length") ?? 0) > PGP_LIMITS.keyserverResponse) throw new PgpProofError("The key from keys.openpgp.org is too large.");
	const armored = await response.text();
	if (armored.length > PGP_LIMITS.keyserverResponse) throw new PgpProofError("The key from keys.openpgp.org is too large.");
	return {
		armored,
		source: KEYSERVER,
		fetchedAt: options.now ?? nowSeconds()
	};
}
/**
* Emails keys.openpgp.org vouches for on this key: it publishes a user ID only
* once the email's owner confirmed it, so every user ID in its copy is one the
* keyserver checked. That is the keyserver's check, and says nothing about a name.
*/
async function keyserverVerifiedEmails(keyserverArmored, fingerprint, options = {}) {
	const info = await readPgpPublicKey(keyserverArmored, options);
	if (info.fingerprint !== fingerprint.toUpperCase()) throw new PgpProofError("keys.openpgp.org returned a different key.");
	const emails = info.userIds.map((u) => /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(u)?.[1] ?? (/^[^<>\s]+@[^<>\s]+$/.test(u) ? u : void 0));
	return [...new Set(emails.filter((e) => !!e).map((e) => e.toLowerCase()))];
}
//#endregion
//#region ../browser/src/proofs/providers/openpgp.ts
/**
* OpenPGP keys, signed with the person's own gpg — a YubiKey or another OpenPGP card works unchanged,
* since gpg drives it. The subject is the primary key's fingerprint. See docs/wisps/305-openpgp.md.
*/
/** A v4 (40 hex) or v6 (64 hex) fingerprint, as gpg prints it or not: spaces and 0x are dropped. */
function normalizeFingerprint(input) {
	const value = input.trim().replace(/^0x/i, "").replace(/\s+/g, "").toUpperCase();
	if (/^[A-F0-9]{40}$/.test(value) || /^[A-F0-9]{64}$/.test(value)) return value;
	if (/^[A-F0-9]{8}$|^[A-F0-9]{16}$/.test(value)) throw new PgpProofError("Use the full fingerprint, not a key ID: gpg --fingerprint shows it.");
	throw new PgpProofError("Enter your key's fingerprint: 40 hex characters (gpg --fingerprint).");
}
/** The user ID is its holder's own words: shown with that caveat, never as a checked name. */
var USER_ID_SOURCE = "User ID on the key, written by its holder: not proof that the name or email is theirs";
var KEYSERVER_SOURCE = "Email confirmed to keys.openpgp.org by its owner: the keyserver's check, not Ghostly's";
function steps(statement, exportKey) {
	assertSignableStatement(statement.text);
	if (statement.text.includes("'")) throw new PgpProofError("Statement is not signable as plain text");
	const fpr = normalizeFingerprint(statement.binding.subject);
	const sign = `gpg --local-user ${fpr} --clearsign --output - ghostly-identity.txt`;
	return {
		steps: [
			{
				text: "Save the statement to a file (it is one line, with no newline at the end):",
				copy: `printf '%s' '${statement.text}' > ghostly-identity.txt`
			},
			exportKey ? {
				text: "Sign it and export your public key, then copy everything this prints:",
				copy: `${sign} && gpg --armor --export --export-options export-minimal ${fpr}`
			} : {
				text: "Sign it, then copy everything this prints:",
				copy: sign
			},
			{
				text: "On a YubiKey or another OpenPGP card, gpg asks for the card's PIN, and for a touch if the card requires one. Without a shell, save the statement below in a text file and sign that file.",
				copy: statement.text
			}
		],
		paste: {
			label: exportKey ? "Signed statement and public key" : "Signed statement",
			placeholder: "-----BEGIN PGP SIGNED MESSAGE-----",
			multiline: true
		}
	};
}
async function evidenceFrom(statement, signature, publicKey) {
	const { evidence } = await preparePgpEvidence({
		statement: statement.text,
		signature,
		publicKey
	}, {
		expectedFingerprint: normalizeFingerprint(statement.binding.subject),
		signedAfter: statement.binding.issuedAt
	});
	return evidence;
}
var openpgp = {
	id: "openpgp",
	label: "OpenPGP key",
	category: "self-custodied",
	summary: "Sign with gpg and paste the result",
	description: "Proves you hold an OpenPGP key: sign the statement with gpg (a YubiKey works too) and paste the result.",
	limits: "Holding a key does not prove the names or emails in its user IDs.",
	platforms: [
		"web",
		"extension",
		"desktop"
	],
	subject: {
		label: "Key fingerprint",
		placeholder: "40 hex characters, from gpg --fingerprint",
		help: "The primary key's full fingerprint. Holding a key does not prove the names or emails in its user IDs.",
		normalize: normalizeFingerprint,
		short: (fpr) => `…${formatFingerprint(fpr.slice(-16))}`
	},
	publicUri: (fpr) => `openpgp4fpr:${fpr}`,
	validity: {
		defaultDays: 90,
		maxDays: 365
	},
	privacy: `Nothing: the signature is checked on this device. ${KEYSERVER.replace("https://", "")} is contacted only if you choose it for your key, or ask it to confirm emails.`,
	signers: [{
		id: "gpg",
		kind: "external-tool",
		label: "gpg",
		description: "Sign with gpg and paste what it prints, public key included. Nothing is looked up.",
		instructions: (statement) => steps(statement, true),
		async parse(pasted, statement) {
			const { signature, publicKey } = splitPgpPaste(pasted);
			if (!publicKey) throw new PgpProofError("Paste your public key too: the second command prints it (-----BEGIN PGP PUBLIC KEY BLOCK-----).");
			return evidenceFrom(statement, signature, publicKey);
		}
	}, {
		id: "gpg-keys-openpgp-org",
		kind: "external-tool",
		label: "gpg, key from keys.openpgp.org",
		description: "Sign with gpg and paste the signature; Ghostly then fetches your public key from keys.openpgp.org, which learns which key was looked up.",
		instructions: (statement) => steps(statement, false),
		async parse(pasted, statement) {
			const { signature, publicKey } = splitPgpPaste(pasted);
			return evidenceFrom(statement, signature, publicKey ?? (await fetchKeyFromKeyserver(statement.binding.subject)).armored);
		}
	}],
	lookupLabel: "Check emails with keys.openpgp.org",
	parseEvidence: (raw) => parsePgpEvidence(raw),
	async verify(statement, evidence, ctx) {
		ctx.signal.throwIfAborted();
		const { binding } = statement;
		const verified = await verifyPgpEvidence(evidence, statement.text, {
			now: ctx.now,
			signedAfter: binding.issuedAt,
			expectedFingerprint: normalizeFingerprint(binding.subject)
		});
		const subkey = verified.signingFingerprint !== verified.fingerprint;
		const [userId] = verified.userIds;
		return {
			subject: verified.fingerprint,
			source: `OpenPGP signature (${verified.algorithm}${subkey ? " signing subkey" : ""}, v${verified.version} key)`,
			...verified.expiresAt !== null && verified.expiresAt < binding.expiresAt ? { expiresAt: verified.expiresAt } : {},
			...userId ? { display: {
				name: userId,
				source: USER_ID_SOURCE,
				fetchedAt: ctx.now
			} } : {}
		};
	},
	/** On request only: which emails on this key keys.openpgp.org confirmed, and whether it holds a revocation. */
	async lookupDisplay(subject, { signal }) {
		const fpr = normalizeFingerprint(subject);
		const found = await fetchKeyFromKeyserver(fpr, { signal });
		const emails = await keyserverVerifiedEmails(found.armored, fpr);
		if (!emails.length) return void 0;
		return {
			name: emails[0],
			url: `${KEYSERVER}/search?q=${fpr}`,
			source: KEYSERVER_SOURCE,
			fetchedAt: found.fetchedAt
		};
	}
};
//#endregion
//#region ../browser/src/proofs/sshForges.ts
var SSH_FORGE_LABEL = {
	github: "GitHub",
	gitlab: "GitLab"
};
/** The only host each forge lookup contacts, for the privacy line. */
var SSH_FORGE_HOST = {
	github: "api.github.com",
	gitlab: "gitlab.com"
};
var MAX_BODY = 262144;
var MAX_KEYS = 200;
function validForgeLogin(forge, login) {
	if (typeof login !== "string") return false;
	return forge === "github" ? /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(login) : /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,63}$/.test(login) && !/\.(?:git|atom)$/i.test(login);
}
async function get(fetcher, url, signal) {
	const response = await fetcher(url, {
		maxBytes: MAX_BODY,
		signal
	});
	if (response.status === 404) return { status: 404 };
	if (response.status === 403 || response.status === 429) throw new Error(`${new URL(url).host} is limiting lookups; check again later`);
	if (response.status !== 200) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`);
	try {
		return {
			status: 200,
			body: JSON.parse(response.text)
		};
	} catch {
		throw new Error(`Unexpected answer from ${new URL(url).host}`);
	}
}
function keysFrom(body) {
	if (!Array.isArray(body)) throw new Error("Unexpected key list");
	const keys = [];
	for (const entry of body.slice(0, MAX_KEYS)) {
		const line = entry?.key;
		if (typeof line !== "string") continue;
		try {
			keys.push(parseSshPublicKey(line));
		} catch {}
	}
	return keys;
}
/** The account's published keys, or null when there is no such account. */
async function listKeys(forge, login, fetcher, signal) {
	if (forge === "github") {
		const r = await get(fetcher, `https://api.github.com/users/${encodeURIComponent(login)}/keys?per_page=100`, signal);
		return r.status === 404 ? null : keysFrom(r.body);
	}
	const users = await get(fetcher, `https://gitlab.com/api/v4/users?username=${encodeURIComponent(login)}`, signal);
	const user = (users.status === 200 && Array.isArray(users.body) ? users.body : []).find((u) => typeof u?.username === "string" && u.username.toLowerCase() === login.toLowerCase());
	if (!user) return null;
	if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new Error("Unexpected answer from gitlab.com");
	const r = await get(fetcher, `https://gitlab.com/api/v4/users/${user.id}/keys?per_page=100`, signal);
	return r.status === 404 ? null : keysFrom(r.body);
}
var inFlight = /* @__PURE__ */ new WeakMap();
/** Whether `key` is one of `login`'s published SSH keys. Throws when the forge cannot be asked. */
async function checkSshForge(forge, login, key, fetcher, signal) {
	if (!validForgeLogin(forge, login)) throw new Error(`Not a ${SSH_FORGE_LABEL[forge]} username`);
	let pending = inFlight.get(fetcher);
	if (!pending) inFlight.set(fetcher, pending = /* @__PURE__ */ new Map());
	const map = pending, id = `${forge}:${login.toLowerCase()}`;
	let lookup = map.get(id);
	if (!lookup) {
		lookup = listKeys(forge, login, fetcher, signal).finally(() => map.delete(id));
		map.set(id, lookup);
	}
	const keys = await lookup;
	if (!keys) return "no-account";
	return keys.some((k) => sameSshKey(k, key)) ? "linked" : "not-listed";
}
//#endregion
//#region ../browser/src/proofs/providers/ssh.ts
var FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
function normalizeKeySubject(input) {
	const value = input.trim();
	if (FINGERPRINT.test(value)) return value;
	try {
		return parseSshPublicKey(value).fingerprint;
	} catch (e) {
		if (e instanceof SshSigError && /^(Unsupported SSH key type|RSA keys must)/.test(e.message)) throw Object.assign(new Error(e.message), { cause: e });
		throw Object.assign(/* @__PURE__ */ new Error("Paste your public key (the one line in ~/.ssh/id_ed25519.pub) or its SHA256: fingerprint"), { cause: e });
	}
}
function normalizeLogin(forge, input) {
	const login = input.trim().replace(/^@/, "").toLowerCase();
	if (!validForgeLogin(forge, login)) throw new Error(`Enter a ${SSH_FORGE_LABEL[forge]} username`);
	return login;
}
/** The armor, re-wrapped canonically, so evidence is the same whatever the clipboard did to it. */
function canonicalArmor(pasted) {
	const parsed = parseSshSignature(pasted);
	if (parsed.namespace !== "ghostly") throw new Error(`That signature is for "${parsed.namespace}", not "${SSHSIG_NAMESPACE}": run the command with -n ${SSHSIG_NAMESPACE}`);
	return `-----BEGIN SSH SIGNATURE-----\n${pasted.replace(/\r\n/g, "\n").trim().split("\n").map((l) => l.trim()).slice(1, -1).join("").match(/.{1,70}/g).join("\n")}\n-----END SSH SIGNATURE-----\n`;
}
/** Exactly the statement; or with one trailing newline, which an editor adds when the statement is
* saved to a file and signed there (the Windows route). Nothing else is accepted. */
async function verifyStatementSignature(statement, evidence) {
	try {
		return await verifySshSignature(evidence.signature, statement.bytes);
	} catch (e) {
		if (!(e instanceof SshSigError) || !/does not match this statement/.test(e.message)) throw e;
		try {
			return await verifySshSignature(evidence.signature, utf8Encode(`${statement.text}\n`));
		} catch (again) {
			throw Object.assign(/* @__PURE__ */ new Error("The signature is not over this statement: copy the command again and sign exactly what it shows"), { cause: again });
		}
	}
}
var keyKind = (c) => c.securityKey ? `security key, touch${c.securityKey.userVerified ? " and PIN" : ""} confirmed` : c.key.type === "ssh-rsa" ? `RSA ${c.key.bits}` : c.key.type.replace(/^ssh-|^ecdsa-sha2-/, "");
function sshKeygenSigner(forAccount) {
	return {
		id: "ssh-keygen",
		kind: "external-tool",
		label: "ssh-keygen",
		description: forAccount ? `Sign with an SSH key that your ${SSH_FORGE_LABEL[forAccount]} account lists (Settings → SSH keys).` : "Sign with OpenSSH's ssh-keygen (8.1 or later): a key file, ssh-agent, or a FIDO security key.",
		instructions: (statement) => {
			let command;
			try {
				command = sshSignCommand(statement.text);
			} catch {
				command = void 0;
			}
			return {
				steps: [
					...command ? [{
						text: "Run this in a terminal (macOS, Linux, or Git Bash/WSL on Windows). If your key is not ~/.ssh/id_ed25519, change the path after -f; a .pub path works when the private key is in ssh-agent or on a security key.",
						copy: command
					}] : [],
					{
						text: `${command ? "Or save" : "Save"} this statement to a file, run ssh-keygen -Y sign -n ${SSHSIG_NAMESPACE} -f <your key> <file>, and paste the <file>.sig it writes.`,
						copy: statement.text
					},
					{ text: "Paste the whole signature it prints, from -----BEGIN SSH SIGNATURE----- to -----END SSH SIGNATURE-----. Your private key never leaves your computer." }
				],
				paste: {
					label: "SSH signature",
					placeholder: "-----BEGIN SSH SIGNATURE-----",
					multiline: true
				}
			};
		},
		parse(pasted, statement) {
			const signature = canonicalArmor(pasted);
			if (!forAccount) {
				const { key } = parseSshSignature(signature);
				if (key.fingerprint !== statement.binding.subject) throw new Error(`That signature was made by ${key.fingerprint}, not the key you entered (${statement.binding.subject})`);
			}
			return { signature };
		}
	};
}
function parseSshEvidence(raw) {
	const e = raw;
	if (!e || typeof e !== "object" || Array.isArray(e) || Object.keys(e).join(",") !== "signature" || typeof e.signature !== "string" || e.signature.length > 6144) throw new Error("That is not an SSH signature");
	return { signature: e.signature };
}
var shortFingerprint = (f) => `${f.slice(0, 15)}…${f.slice(-4)}`;
var ssh = {
	id: "ssh",
	label: "SSH key",
	category: "self-custodied",
	summary: "Sign once with ssh-keygen",
	description: "Proves you hold an SSH key, including FIDO security keys: sign the statement once with ssh-keygen and paste the signature.",
	platforms: [
		"web",
		"extension",
		"desktop"
	],
	subject: {
		label: "Public key",
		placeholder: "ssh-ed25519 AAAA… (or SHA256:…)",
		help: "Your public key, the one line in the .pub file. Contacts see its fingerprint.",
		normalize: normalizeKeySubject,
		short: shortFingerprint
	},
	validity: {
		defaultDays: 90,
		maxDays: 365
	},
	privacy: "Nothing: the signature is checked on this device. The key's fingerprint links every chat you share it in.",
	signers: [sshKeygenSigner()],
	parseEvidence: parseSshEvidence,
	async verify(statement, evidence) {
		const check = await verifyStatementSignature(statement, evidence);
		if (check.key.fingerprint !== statement.binding.subject) throw new Error("Signed by another SSH key");
		return {
			subject: statement.binding.subject,
			source: `SSH signature (${keyKind(check)})`
		};
	}
};
function forgeProvider(forge) {
	const label = SSH_FORGE_LABEL[forge], host = SSH_FORGE_HOST[forge];
	return {
		id: `ssh-${forge}`,
		label: `${label} (SSH key)`,
		category: "self-custodied",
		summary: `A key your ${label} account lists`,
		description: `Proves you hold an SSH key your ${label} account publishes: sign the statement once with ssh-keygen. No ${label} login.`,
		limits: `Does not prove a ${label} login: only that a key the account lists is yours, for as long as it stays listed.`,
		platforms: [
			"web",
			"extension",
			"desktop"
		],
		subject: {
			label: `${label} username`,
			placeholder: forge === "github" ? "octocat" : "username",
			normalize: (input) => normalizeLogin(forge, input)
		},
		publicUri: (login) => `https://${forge === "github" ? "github.com" : "gitlab.com"}/${login}`,
		validity: {
			defaultDays: 90,
			maxDays: 365
		},
		recheck: { afterSeconds: 600 },
		privacy: `Your contact's app asks ${host} for this account's public SSH keys, when you share it and on each re-check: ${label} learns the account was looked up, and from which IP address. So does this app when you add it.`,
		signers: [sshKeygenSigner(forge)],
		parseEvidence: parseSshEvidence,
		async verify(statement, evidence, ctx) {
			const login = statement.binding.subject;
			if (normalizeLogin(forge, login) !== login) throw new Error(`Not a ${label} username`);
			const check = await verifyStatementSignature(statement, evidence);
			const status = await checkSshForge(forge, login, check.key, ctx.fetch, ctx.signal);
			if (status === "no-account") throw new Error(`${label} has no account ${login}`);
			if (status === "not-listed") throw new Error(`${label}: ${login} does not list the key that signed (${check.key.fingerprint})`);
			return {
				subject: login,
				source: `${label}: ${login} (via published SSH key)`
			};
		}
	};
}
var sshGithub = forgeProvider("github");
var sshGitlab = forgeProvider("gitlab");
//#endregion
//#region ../browser/src/host.ts
var current = null;
function getBrowserHost() {
	if (!current) throw new Error("No browser host configured");
	return current;
}
//#endregion
//#region ../browser/src/proofs/oidc/providers.ts
var TEST_ISSUER = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.test$/;
var MICROSOFT_TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var OIDC_PROVIDERS = {
	google: {
		id: "google",
		name: "Google",
		issuer: "https://accounts.google.com",
		issuerAliases: ["accounts.google.com"],
		discovery: "https://accounts.google.com/.well-known/openid-configuration",
		authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
		jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
		algs: ["RS256"],
		responseType: "id_token",
		reveal: {
			email: { scope: "email" },
			profile: { scope: "profile" }
		},
		alwaysIncluded: "A Google account identifier.",
		extraParams: { prompt: "select_account" },
		clientIds: {
			web: "",
			extension: ""
		}
	},
	microsoft: {
		id: "microsoft",
		name: "Microsoft",
		issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
		discovery: "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration",
		authorizationEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
		jwksUri: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
		algs: ["RS256"],
		responseType: "id_token",
		reveal: {
			email: { scope: "email" },
			profile: { scope: "profile" }
		},
		alwaysIncluded: "A Microsoft account identifier and the directory (tenant) the account belongs to.",
		extraParams: {
			prompt: "select_account",
			response_mode: "fragment"
		},
		clientIds: {
			web: "",
			extension: ""
		}
	},
	apple: {
		id: "apple",
		name: "Apple",
		issuer: "https://appleid.apple.com",
		discovery: "https://appleid.apple.com/.well-known/openid-configuration",
		authorizationEndpoint: "https://appleid.apple.com/auth/authorize",
		jwksUri: "https://appleid.apple.com/auth/keys",
		algs: ["RS256"],
		responseType: "code id_token",
		reveal: {},
		alwaysIncluded: "An Apple ID identifier that only Ghostly sees. Apple cannot add your email here without a Ghostly server.",
		extraParams: { response_mode: "fragment" },
		clientIds: {
			web: "",
			extension: ""
		}
	},
	gitlab: {
		id: "gitlab",
		name: "GitLab",
		issuer: "https://gitlab.com",
		discovery: "https://gitlab.com/.well-known/openid-configuration",
		authorizationEndpoint: "https://gitlab.com/oauth/authorize",
		tokenEndpoint: "https://gitlab.com/oauth/token",
		revocationEndpoint: "https://gitlab.com/oauth/revoke",
		jwksUri: "https://gitlab.com/oauth/discovery/keys",
		algs: ["RS256"],
		responseType: "code",
		reveal: {
			email: { scope: "email" },
			profile: { scope: "profile" }
		},
		alwaysIncluded: "A GitLab.com user ID and the groups you belong to directly: GitLab adds them to every ID token.",
		clientIds: {
			web: "",
			extension: ""
		}
	},
	twitch: {
		id: "twitch",
		name: "Twitch",
		issuer: "https://id.twitch.tv/oauth2",
		discovery: "https://id.twitch.tv/oauth2/.well-known/openid-configuration",
		authorizationEndpoint: "https://id.twitch.tv/oauth2/authorize",
		jwksUri: "https://id.twitch.tv/oauth2/keys",
		algs: ["RS256"],
		responseType: "id_token",
		reveal: { profile: { claims: ["preferred_username"] } },
		alwaysIncluded: "A Twitch user ID.",
		extraParams: { force_verify: "true" },
		clientIds: {
			web: "",
			extension: ""
		}
	}
};
/**
* The local issuer the e2e suite runs (e2e/support/oidcIssuer.ts). It exists
* only in a build made with VITE_OIDC_TEST_ISSUER, and only on a `.test` host
* (a name reserved for testing, never a real issuer); a release build has no
* such provider, so a token from it is refused like any unknown issuer.
*/
function testProvider(issuer) {
	if (!TEST_ISSUER.test(issuer)) throw new Error("A test issuer lives on a .test host");
	const base = issuer;
	return {
		id: "test",
		name: "Test issuer",
		issuer: base,
		discovery: `${base}/.well-known/openid-configuration`,
		authorizationEndpoint: `${base}/authorize`,
		jwksUri: `${base}/jwks`,
		algs: ["RS256", "ES256"],
		responseType: "id_token",
		reveal: {
			email: { scope: "email" },
			profile: { scope: "profile" }
		},
		alwaysIncluded: "A test account identifier.",
		clientIds: {
			web: "ghostly-e2e",
			extension: "ghostly-e2e",
			desktop: "ghostly-e2e"
		}
	};
}
function configuredTestIssuer() {
	try {
		return;
	} catch {
		return;
	}
}
/** Every provider this build knows, configured or not. */
function oidcProviders(testIssuer = configuredTestIssuer()) {
	return [...Object.values(OIDC_PROVIDERS), ...testIssuer ? [testProvider(testIssuer)] : []];
}
/** Every client ID this provider has, on any platform: a contact may use another platform than the prover. */
function audiences(provider) {
	return [...new Set(Object.values(provider.clientIds).filter((id) => !!id))];
}
function clientIdFor(provider, platform) {
	return provider.clientIds[platform] || provider.clientIds.web || "";
}
/** A provider is offered only once its client ID for this platform exists. */
function isConfigured(provider, platform) {
	return !!clientIdFor(provider, platform);
}
/** The exact issuer a token from this provider must carry, or undefined when its claims do not name one. */
function issuerFor(provider, claims) {
	if (provider.id !== "microsoft") return [provider.issuer, ...provider.issuerAliases ?? []];
	return typeof claims.tid === "string" && MICROSOFT_TENANT.test(claims.tid) ? [provider.issuer.replace("{tenantid}", claims.tid)] : [];
}
/** The provider a proof's subject (an issuer, as `OidcProvider.issuer` spells it) names. */
function providerForIssuer(issuer, list = oidcProviders()) {
	return list.find((p) => p.issuer === issuer);
}
//#endregion
//#region ../browser/src/proofs/oidc/jwks.ts
var JWKS_MAX_BYTES = 65536;
var MIN_TTL_MS = 3e5;
var MAX_TTL_MS = 864e5;
var DEFAULT_TTL_MS = 36e5;
function allowedUrl(url) {
	try {
		const u = new URL(url);
		return u.protocol === "https:" && !u.username && !u.password && !u.hash;
	} catch {
		return false;
	}
}
function ttl(cacheControl) {
	const maxAge = /(?:^|[,\s])max-age=(\d+)/i.exec(cacheControl ?? "")?.[1];
	const ms = maxAge ? Number(maxAge) * 1e3 : DEFAULT_TTL_MS;
	return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, ms));
}
function parseKeys(text) {
	if (text.length > 65536) throw new Error("Provider key set too large");
	let doc;
	try {
		doc = JSON.parse(text);
	} catch {
		throw new Error("Invalid provider key set");
	}
	if (!doc || !Array.isArray(doc.keys) || doc.keys.length > 32) throw new Error("Invalid provider key set");
	return doc.keys.filter((k) => !!k && typeof k === "object" && typeof k.kty === "string");
}
var JwksCache = class {
	options;
	entries = /* @__PURE__ */ new Map();
	inflight = /* @__PURE__ */ new Map();
	constructor(options = {}) {
		this.options = options;
	}
	now() {
		return (this.options.now ?? Date.now)();
	}
	load(url, fetcher) {
		const running = this.inflight.get(url);
		if (running) return running;
		const task = (async () => {
			if (!allowedUrl(url)) throw new Error("Provider key URL refused");
			const response = await fetcher(url, { maxBytes: JWKS_MAX_BYTES });
			if (response.status !== 200) throw new Error(`Provider keys unavailable (${response.status})`);
			const keys = parseKeys(response.text);
			const fetched = this.now();
			const entry = {
				keys,
				fetched,
				expires: fetched + ttl(response.cacheControl)
			};
			this.entries.set(url, entry);
			return entry;
		})();
		this.inflight.set(url, task);
		return task.finally(() => this.inflight.delete(url));
	}
	/** The key with this `kid`, refetching once when it is unknown (rotation) or the cache expired. */
	async key(url, kid, fetcher) {
		let entry = this.entries.get(url);
		if (!entry || entry.expires <= this.now()) entry = await this.load(url, fetcher);
		let found = entry.keys.find((k) => k.kid === kid);
		if (!found && this.now() - entry.fetched >= 6e4) {
			entry = await this.load(url, fetcher);
			found = entry.keys.find((k) => k.kid === kid);
		}
		return found;
	}
	clear() {
		this.entries.clear();
	}
};
/** One cache per app: every contact's proofs share the providers' keys. */
var sharedJwksCache = new JwksCache();
/** An ID token that claims to live longer than a day is not a sign-in result. */
var MAX_LIFETIME = 86400;
var SEGMENT = /^[A-Za-z0-9_-]+$/;
var REFUSED_HEADERS = [
	"crit",
	"jku",
	"jwk",
	"x5u",
	"x5c",
	"zip",
	"enc"
];
var OidcVerificationError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "OidcVerificationError";
	}
};
var refuse = (message) => {
	throw new OidcVerificationError(message);
};
function segment(value) {
	if (!SEGMENT.test(value)) refuse("Malformed ID token");
	let bytes;
	try {
		bytes = fromBase64Url(value);
	} catch {
		return refuse("Malformed ID token");
	}
	if (toBase64Url(bytes) !== value) refuse("Malformed ID token");
	return bytes;
}
function json(value) {
	let parsed;
	try {
		parsed = JSON.parse(utf8Decode(segment(value)));
	} catch (e) {
		if (e instanceof OidcVerificationError) throw e;
		return refuse("Malformed ID token");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) refuse("Malformed ID token");
	return parsed;
}
var text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max ? value : void 0;
/** Splits and decodes without verifying anything. Only for display of a token already verified. */
function decodeIdToken(token) {
	if (typeof token !== "string" || token.length > 6144) refuse("ID token missing or too large");
	const parts = token.split(".");
	if (parts.length !== 3) refuse("Not a signed ID token");
	return {
		header: json(parts[0]),
		claims: json(parts[1]),
		signature: segment(parts[2]),
		signed: utf8Encode(`${parts[0]}.${parts[1]}`)
	};
}
async function verifySignature(alg, jwk, signed, signature) {
	if (jwk.use !== void 0 && jwk.use !== "sig") refuse("Provider key is not a signing key");
	if (jwk.alg !== void 0 && jwk.alg !== alg) refuse("Provider key is for another algorithm");
	if (jwk.key_ops !== void 0 && !(Array.isArray(jwk.key_ops) && jwk.key_ops.includes("verify"))) refuse("Provider key is not a signing key");
	let key;
	if (alg === "RS256") {
		if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") return refuse("Provider key does not match the token algorithm");
		const modulus = segment(jwk.n);
		const bits = (modulus.length - (modulus[0] === 0 ? 1 : 0)) * 8;
		if (bits < 2048 || bits > 8192) refuse("Provider key size refused");
		key = await crypto.subtle.importKey("jwk", {
			kty: "RSA",
			n: jwk.n,
			e: jwk.e,
			ext: true
		}, {
			name: "RSASSA-PKCS1-v1_5",
			hash: "SHA-256"
		}, false, ["verify"]);
		return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
	}
	if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") return refuse("Provider key does not match the token algorithm");
	if (signature.length !== 64) refuse("Invalid ID token signature");
	key = await crypto.subtle.importKey("jwk", {
		kty: "EC",
		crv: "P-256",
		x: jwk.x,
		y: jwk.y,
		ext: true
	}, {
		name: "ECDSA",
		namedCurve: "P-256"
	}, false, ["verify"]);
	return crypto.subtle.verify({
		name: "ECDSA",
		hash: "SHA-256"
	}, key, signature, signed);
}
/** Whether `iss` is this provider's, as it words it (Microsoft: with the token's own tenant). */
function issuerMatches(provider, claims) {
	const iss = text(claims.iss, 512);
	return !!iss && issuerFor(provider, claims).includes(iss);
}
async function verifyIdToken(token, options) {
	const { provider, nonce } = options;
	const now = options.now ?? Math.floor(Date.now() / 1e3);
	const { header, claims, signature, signed } = decodeIdToken(token);
	const alg = header.alg;
	if (typeof alg !== "string" || !provider.algs.includes(alg)) refuse(`Algorithm ${typeof alg === "string" ? alg : "missing"} is not accepted for ${provider.name}`);
	if (header.typ !== void 0 && (typeof header.typ !== "string" || header.typ.toUpperCase() !== "JWT")) refuse("Not an ID token");
	for (const name of REFUSED_HEADERS) if (name in header) refuse("ID token header refused");
	const kid = text(header.kid, 256) ?? refuse("ID token names no provider key");
	if (!issuerMatches(provider, claims)) refuse(`Token was not issued by ${provider.name}`);
	const iss = claims.iss;
	const expected = audiences(provider);
	if (!expected.length) refuse(`${provider.name} is not configured in this Ghostly build`);
	const aud = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) && claims.aud.every((a) => typeof a === "string") ? claims.aud : [];
	const audience = aud.find((a) => expected.includes(a)) ?? refuse("Token was issued to another app");
	if (aud.length > 1 && claims.azp !== audience) refuse("Token was issued to another app");
	if (claims.azp !== void 0 && claims.azp !== audience) refuse("Token was issued to another app");
	const iat = claims.iat, exp = claims.exp, nbf = claims.nbf;
	if (typeof iat !== "number" || typeof exp !== "number" || !Number.isFinite(iat) || !Number.isFinite(exp)) return refuse("Token has no validity window");
	if (exp <= iat || exp - iat > MAX_LIFETIME) refuse("Token validity window refused");
	if (iat > now + 60) refuse("Token is not valid yet");
	if (options.issuedWithin) {
		const [from, to] = options.issuedWithin;
		if (iat < from || iat > to) refuse("The sign-in does not belong to this proof: it happened at another time");
	} else {
		if (typeof nbf === "number" && nbf > now + 60) refuse("Token is not valid yet");
		if (exp + 60 < now) refuse("Token expired");
	}
	if (typeof claims.nonce !== "string" || claims.nonce !== nonce) refuse("Token answers another proof request");
	const subject = text(claims.sub, 255) ?? refuse("Token names no account");
	const jwk = await (options.jwks ?? sharedJwksCache).key(provider.jwksUri, kid, options.fetch) ?? refuse(`${provider.name} does not publish the key that signed this token`);
	if (provider.id === "microsoft" && jwk.issuer !== void 0 && jwk.issuer !== provider.issuer && jwk.issuer !== iss) refuse("Provider key belongs to another issuer");
	let valid = false;
	try {
		valid = await verifySignature(alg, jwk, signed, signature);
	} catch (e) {
		if (e instanceof OidcVerificationError) throw e;
		refuse("Invalid ID token signature");
	}
	if (!valid) refuse("Invalid ID token signature");
	const verified = claims.email_verified === true || claims.email_verified === "true" ? true : claims.email_verified === false || claims.email_verified === "false" ? false : void 0;
	return {
		provider: provider.id,
		issuer: iss,
		subject,
		audience,
		issuedAt: Math.floor(iat),
		expiresAt: Math.floor(exp),
		email: text(claims.email, 320),
		emailVerified: text(claims.email, 320) ? verified : void 0,
		name: text(claims.name, 200),
		username: text(claims.preferred_username, 200) ?? text(claims.nickname, 200),
		tenant: provider.id === "microsoft" ? text(claims.tid, 64) : void 0
	};
}
//#endregion
//#region ../browser/src/proofs/oidc/flow.ts
/** Optional platform prefix (desktop `d.<port>.`, Android deep link `a.`), then 32 random bytes. */
var STATE = /^(?:d\.\d{1,5}\.|a\.)?[A-Za-z0-9_-]{43}$/;
function scopeFor$1(provider, reveal) {
	const scopes = provider.id === "apple" ? [] : ["openid"];
	const claims = [];
	for (const r of reveal) {
		const option = provider.reveal[r];
		if (!option) continue;
		if (option.scope) scopes.push(option.scope);
		if (option.claims) claims.push(...option.claims);
	}
	return {
		scope: scopes.join(" "),
		claims: claims.length ? JSON.stringify({ id_token: Object.fromEntries(claims.map((c) => [c, null])) }) : void 0
	};
}
async function authorizationRequest(options) {
	const { provider } = options;
	const clientId = clientIdFor(provider, options.platform);
	if (!clientId) throw new Error(`${provider.name} sign-in is not set up in this Ghostly build yet.`);
	const { nonce } = options;
	if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new Error("Invalid sign-in nonce");
	const state = `${options.statePrefix ?? ""}${toBase64Url(randomBytes(32))}`;
	const url = new URL(provider.authorizationEndpoint);
	const { scope, claims } = scopeFor$1(provider, options.reveal);
	const params = {
		client_id: clientId,
		redirect_uri: options.redirectUri,
		response_type: provider.responseType,
		nonce,
		state,
		...scope ? { scope } : {},
		...claims ? { claims } : {},
		...provider.extraParams
	};
	let verifier;
	if (provider.responseType === "code") {
		verifier = toBase64Url(randomBytes(32));
		params.code_challenge = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8Encode(verifier))));
		params.code_challenge_method = "S256";
	}
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return {
		url: url.toString(),
		state,
		nonce,
		redirectUri: options.redirectUri,
		clientId,
		verifier
	};
}
/** Parameters from the redirect: the fragment for implicit responses, the query for `code`. */
function callbackParams$1(redirected, redirectUri) {
	const url = new URL(redirected), expected = new URL(redirectUri);
	if (url.origin !== expected.origin || url.pathname !== expected.pathname) throw new Error("Sign-in returned to an unexpected address.");
	const params = new URLSearchParams(url.hash.slice(1));
	for (const [k, v] of new URLSearchParams(url.search)) if (!params.has(k)) params.set(k, v);
	return params;
}
var PROVIDER_ERRORS = {
	access_denied: "Sign-in was cancelled.",
	login_required: "Sign in to your account and try again.",
	consent_required: "Consent was not given.",
	interaction_required: "The provider needs you to finish signing in.",
	unauthorized_client: "This provider has not accepted Ghostly’s sign-in yet.",
	invalid_request: "The provider refused the sign-in request."
};
async function exchangeCode(provider, request, code, doFetch) {
	if (!provider.tokenEndpoint || !request.verifier) throw new Error("This provider cannot finish sign-in here.");
	const response = await doFetch(provider.tokenEndpoint, {
		method: "POST",
		redirect: "error",
		credentials: "omit",
		referrerPolicy: "no-referrer",
		cache: "no-store",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json"
		},
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: request.redirectUri,
			client_id: request.clientId,
			code_verifier: request.verifier
		})
	});
	const body = await response.json().catch(() => ({}));
	for (const token of [body.refresh_token, body.access_token]) if (typeof token === "string" && provider.revocationEndpoint) doFetch(provider.revocationEndpoint, {
		method: "POST",
		redirect: "error",
		credentials: "omit",
		referrerPolicy: "no-referrer",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			token,
			client_id: request.clientId
		})
	}).catch(() => {});
	if (!response.ok || typeof body.id_token !== "string") throw new Error(`${provider.name} did not return an ID token.`);
	return body.id_token;
}
/** Turns the redirect into the ID token: state, provider error, code exchange if needed, and that it answers this request. */
async function completeSignIn(provider, request, redirected, options = {}) {
	const params = callbackParams$1(redirected, request.redirectUri);
	const state = params.get("state");
	if (!state || !STATE.test(state) || state !== request.state) throw new Error("Sign-in answer does not belong to this request.");
	const error = params.get("error");
	if (error) throw new Error(PROVIDER_ERRORS[error] ?? "The provider refused the sign-in.");
	let idToken;
	if (provider.responseType === "code") {
		const code = params.get("code");
		if (!code || code.length > 2048) throw new Error(`${provider.name} did not return a sign-in code.`);
		idToken = await exchangeCode(provider, request, code, options.fetch ?? fetch);
	} else idToken = params.get("id_token");
	if (!idToken) throw new Error(`${provider.name} did not return an ID token.`);
	const { claims } = decodeIdToken(idToken);
	if (claims.nonce !== request.nonce || !issuerMatches(provider, claims)) throw new Error(`${provider.name} answered another sign-in request.`);
	return idToken;
}
/** Everything the prover does: sign in on this platform and return the ID token for this nonce. */
async function signInForProof(options) {
	const { window: w } = options;
	try {
		options.signal.throwIfAborted();
		const request = await authorizationRequest({
			...options,
			redirectUri: w.redirectUri,
			statePrefix: w.statePrefix
		});
		const redirected = await w.authorize(request.url, options.signal);
		options.signal.throwIfAborted();
		return await completeSignIn(options.provider, request, redirected, options);
	} finally {
		w.close();
	}
}
//#endregion
//#region ../browser/src/proofs/providers/oidc.ts
/** How long after the statement the sign-in may have happened: time to pick an account and approve. */
var SIGN_IN_WINDOW = 900;
var TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
var SUB = /^[\x21-\x7e]{1,255}$/;
function currentHost$1() {
	try {
		return getBrowserHost().oidc;
	} catch {
		return;
	}
}
var hostOf$1 = (issuer) => {
	try {
		return new URL(issuer).host;
	} catch {
		return issuer;
	}
};
function createOidcIdentityProvider(options = {}) {
	const providers = options.providers ?? (() => oidcProviders());
	const host = options.host ?? currentHost$1;
	const configured = () => providers().filter((p) => audiences(p).length > 0);
	const signer = (id, label, description, reveal) => ({
		id,
		kind: "redirect",
		label,
		description,
		available: () => {
			const h = host();
			return !!h && providers().some((p) => isConfigured(p, h.platform));
		},
		start(statement, ctx) {
			const h = host();
			const opening = h?.open();
			return (async () => {
				if (!h || !opening) throw new Error("Signing in with a provider is not available here.");
				const provider = providerForIssuer(statement.binding.subject, providers());
				if (!provider || !isConfigured(provider, h.platform)) {
					opening.then((w) => w.close(), () => {});
					throw new Error("This provider is not set up in this Ghostly build.");
				}
				ctx.onProgress(`Sign in with ${provider.name} in the window that opened.`);
				return { token: await signInForProof({
					provider,
					platform: h.platform,
					nonce: statement.id,
					window: await opening,
					signal: ctx.signal,
					fetch: options.fetch,
					reveal: reveal.filter((r) => provider.reveal[r])
				}) };
			})();
		}
	});
	return {
		id: "oidc",
		label: "Account at a provider",
		category: "provider-attested",
		summary: "Sign in with Google, Microsoft, Apple…",
		description: "Sign in with Google, Microsoft, Apple, GitLab or Twitch: the provider vouches to Ghostly, with a signed token, that the account is yours.",
		limits: "Attested by the provider, not by a key you hold: your contact trusts that company.",
		platforms: [
			"web",
			"extension",
			"desktop"
		],
		subject: {
			label: "Provider",
			help: "Your contact sees your account’s identifier at that provider, plus what you choose to add. GitLab also adds the groups you belong to directly; Apple never gives Ghostly your email.",
			get options() {
				return configured().map((p) => ({
					value: p.issuer,
					label: p.name
				}));
			},
			normalize(input) {
				const provider = providerForIssuer(input.trim(), configured());
				if (!provider) throw new Error("Choose a provider");
				return provider.issuer;
			},
			short: (subject) => providerForIssuer(subject, providers())?.name ?? hostOf$1(subject)
		},
		validity: {
			defaultDays: 7,
			maxDays: 14
		},
		privacy: "Your contact’s app downloads the provider’s public keys (for example from www.googleapis.com), so the provider sees that some app checked a sign-in, not whose. Your contact sees the account identifier and what you chose to share.",
		signers: [
			signer("oidc-account", "Sign in: share the account only", "The token carries the provider’s identifier for your account, nothing else.", []),
			signer("oidc-email", "Sign in: share the account and email", "Adds your email address, where the provider offers it.", ["email"]),
			signer("oidc-profile", "Sign in: share the account, email and name", "Adds your email address and name or username, where the provider offers them.", ["email", "profile"])
		],
		parseEvidence(raw) {
			const e = raw;
			if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).join(",") !== "token" || typeof e.token !== "string" || e.token.length > 6144 || !TOKEN.test(e.token)) throw new Error("Invalid sign-in token");
			return { token: e.token };
		},
		async verify(statement, { token }, ctx) {
			const provider = providerForIssuer(statement.binding.subject, providers());
			if (!provider) throw new Error("This app does not know this provider");
			const id = await verifyIdToken(token, {
				provider,
				nonce: statement.id,
				now: ctx.now,
				jwks: options.jwks ?? sharedJwksCache,
				fetch: async (url, { maxBytes }) => {
					const r = await ctx.fetch(url, {
						maxBytes,
						signal: ctx.signal
					});
					return {
						status: r.status,
						text: r.text
					};
				},
				issuedWithin: [statement.binding.issuedAt - 300, statement.binding.issuedAt + SIGN_IN_WINDOW]
			});
			if (!SUB.test(id.subject)) throw new Error("The provider’s account identifier cannot be shown");
			const attester = hostOf$1(provider.issuer);
			const person = id.name ?? id.username;
			const name = id.email ? person && `${person} · ${id.email}`.length <= 64 ? `${person} · ${id.email}` : id.email : person;
			const url = id.username && /^[A-Za-z0-9_.-]{1,64}$/.test(id.username) ? provider.id === "gitlab" ? `https://gitlab.com/${id.username}` : provider.id === "twitch" ? `https://www.twitch.tv/${id.username}` : void 0 : void 0;
			return {
				subject: `${provider.id === "microsoft" ? id.issuer : provider.issuer}#${id.subject}`,
				attester,
				source: `ID token signed by ${attester}`,
				...name || url ? { display: {
					...name ? { name } : {},
					...url ? { url } : {},
					fetchedAt: id.issuedAt,
					source: `Signed by ${provider.name}${id.email ? id.emailVerified ? `; email verified by ${provider.name}` : `; email not verified by ${provider.name}` : ""}`
				} } : {}
			};
		}
	};
}
var oidc = createOidcIdentityProvider();
//#endregion
//#region ../browser/src/proofs/did.ts
/** Resolutions are shared for this long: back-to-back checks and the add dialog's preview, never a stale key for long. */
var CACHE_MS = 3e4;
var cache = /* @__PURE__ */ new Map();
/** The last document seen per DID, without expiry, for the signer's instructions (which cannot wait). */
var seen = /* @__PURE__ */ new Map();
/** What this app last resolved for `did`, if anything: the add dialog's instructions name its keys. */
var lastDidResolution = (did) => seen.get(did);
async function fetchDidWeb(did, url, maxBytes, options) {
	const host = didWebHost(did);
	try {
		await assertPublicHost(host, {
			fetch: options.fetch,
			signal: options.signal,
			resolver: options.resolver ?? chosenResolver().id,
			now: options.now
		});
	} catch (e) {
		throw e instanceof DomainCheckError ? new DidError(e.message) : e;
	}
	let response;
	try {
		response = await options.fetch(url, {
			headers: { accept: "application/did+json, application/json" },
			maxBytes,
			signal: options.signal,
			redirect: "error"
		});
	} catch (e) {
		if (options.signal?.aborted) throw e;
		throw new DidError(/too large/i.test(String(e)) ? `${url} is too large` : `${host} could not be reached. It must serve ${url} over HTTPS, without a redirect, with the header Access-Control-Allow-Origin: *`);
	}
	if (response.status === 404 || response.status === 410) return void 0;
	if (response.status >= 300 && response.status < 400) throw new DidError(`${host} answered with a redirect; it must serve exactly ${url}`);
	if (response.status !== 200) throw new DidError(`${host} answered ${response.status} for ${url}`);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(response.bytes);
	} catch {
		throw new DidError(`${url} is not text`);
	}
}
async function resolve(did, method, options) {
	if (method === "key" || method === "jwk") return {
		method,
		document: staticDidDocument(did)
	};
	if (method === "web") {
		const documentUrl = didWebDocumentUrl(did);
		const text = await fetchDidWeb(did, documentUrl, DID_DOCUMENT_MAX_BYTES, options);
		if (text === void 0) throw new DidError(`No DID document at ${documentUrl}`);
		let raw;
		try {
			raw = JSON.parse(text);
		} catch {
			throw new DidError(`${documentUrl} is not JSON`);
		}
		return {
			method,
			document: parseDidDocument(did, raw),
			host: didWebHost(did),
			documentUrl
		};
	}
	const found = await (options.dht ?? resolveDidDht)(did, {
		fetch: options.fetch,
		signal: options.signal
	});
	if (found.metadata.deactivated) throw new DidError("This DID is deactivated: its owner retired it");
	return {
		method,
		document: parseDidDocument(did, found.document),
		relay: found.relay
	};
}
/** A DID's document as far as Ghostly uses it. Concurrent and back-to-back resolutions share one lookup. */
async function resolveDid(input, options) {
	const { did, method } = parseDid(input);
	const now = options.now ?? Date.now;
	const hit = cache.get(did);
	if (hit && hit.until > now()) return hit.result;
	const entry = {
		until: now() + CACHE_MS,
		result: resolve(did, method, options)
	};
	cache.set(did, entry);
	if (cache.size > 64) cache.delete(cache.keys().next().value);
	try {
		const result = await entry.result;
		seen.delete(did);
		seen.set(did, result);
		if (seen.size > 16) seen.delete(seen.keys().next().value);
		return result;
	} catch (e) {
		if (cache.get(did) === entry) cache.delete(did);
		throw e;
	}
}
/** The statement file a did:web publishes for proof `proofId`; undefined when the server says it is not there. */
async function fetchDidWebFile(did, proofId, options) {
	return fetchDidWeb(did, didWebFileUrl(did, proofId), DID_FILE_MAX_BYTES, options);
}
//#endregion
//#region ../browser/src/proofs/providers/did.ts
var VM = /^did:[a-z0-9]+:[\x21-\x7e]+#[\x21-\x7e]+$/;
var SIG = /^[A-Za-z0-9_-]{86}$/;
var exactKeys$1 = (raw, keys) => !!raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).sort().join(",") === keys;
var validVm = (vm) => typeof vm === "string" && vm.length <= 640 && VM.test(vm);
/** The add dialog's checks run in the UI, with the same bounded fetch the engine uses. */
var uiFetch = boundedIdentityFetch({ online: () => globalThis.navigator?.onLine !== false });
/** `#key-1`, shortened when a multibase fragment is long. */
var fragment = (id) => {
	const f = id.slice(id.indexOf("#"));
	return f.length > 20 ? `${f.slice(0, 11)}…${f.slice(-4)}` : f;
};
function shortDid(did) {
	if (did.length <= 30) return did;
	const { method, id } = parseDidSafe(did);
	if (method === "web") return `did:web:${id.split(":")[0]}${id.includes(":") ? ":…" : ""}`;
	return `did:${method}:${id.slice(0, 8)}…${id.slice(-4)}`;
}
var parseDidSafe = (did) => {
	try {
		return parseDid(did);
	} catch {
		return {
			did,
			method: did.split(":")[1] ?? "",
			id: did.split(":").slice(2).join(":")
		};
	}
};
/** Keys the instructions can name before anything is fetched: the identifier's own, or what the preview resolved. */
function knownKeys(did) {
	const { method } = parseDid(did);
	if (method === "key" || method === "jwk") return signingKeys(staticDidDocument(did));
	const seen = lastDidResolution(did);
	return seen ? signingKeys(seen.document) : [];
}
var NOBLE = {
	Ed25519: {
		name: "ed25519",
		module: "ed25519.js"
	},
	secp256k1: {
		name: "secp256k1",
		module: "secp256k1.js"
	},
	"P-256": {
		name: "p256",
		module: "nist.js"
	}
};
function joseScript(statement, kid) {
	return [
		"// npm install jose; then: node sign.mjs your-private-key.jwk.json",
		"import { readFileSync } from \"node:fs\";",
		"import { CompactSign, importJWK } from \"jose\";",
		`const statement = ${JSON.stringify(statement)};`,
		"const jwk = JSON.parse(readFileSync(process.argv[2], \"utf8\"));",
		"const alg = { Ed25519: \"EdDSA\", \"P-256\": \"ES256\" }[jwk.crv];",
		"const jws = await new CompactSign(new TextEncoder().encode(statement))",
		`  .setProtectedHeader({ alg${kid ? `, kid: ${JSON.stringify(kid)}` : ""} })`,
		"  .sign(await importJWK(jwk, alg));",
		"console.log(jws);"
	].join("\n");
}
function nobleScript(statement, curve) {
	const lib = NOBLE[curve];
	return [
		"// npm install @noble/curves; then: node sign.mjs your-private-key.hex",
		"import { readFileSync } from \"node:fs\";",
		`import { ${lib.name} } from "@noble/curves/${lib.module}";`,
		`const statement = new TextEncoder().encode(${JSON.stringify(statement)});`,
		"const secret = Uint8Array.from(Buffer.from(readFileSync(process.argv[2], \"utf8\").trim(), \"hex\"));",
		`console.log(Buffer.from(${lib.name}.sign(statement, secret)).toString("hex"));`
	].join("\n");
}
function opensslCommand(statement, curve) {
	const save = `printf '%s' '${statement}' > statement.txt`;
	return curve === "Ed25519" ? `${save} && openssl pkeyutl -sign -rawin -inkey key.pem -in statement.txt | xxd -p | tr -d '\\n'` : `${save} && openssl dgst -sha256 -sign key.pem statement.txt | xxd -p | tr -d '\\n'`;
}
var signer = {
	id: "sign",
	kind: "external-tool",
	label: "Sign with a key of the DID",
	description: "Sign the statement with a key your DID document lists for authentication or assertionMethod, and paste a JWS or the raw signature. The private key never enters Ghostly.",
	instructions(statement) {
		const did = statement.binding.subject;
		if (statement.text.includes("'")) throw new DidError("Statement is not signable as plain text");
		const keys = knownKeys(did);
		const key = keys.length === 1 ? keys[0] : void 0;
		const curve = key?.curve ?? keys[0]?.curve ?? "Ed25519";
		return {
			steps: [
				{
					text: `Sign this statement with the private key of ${keys.length ? keys.map((k) => `${fragment(k.id)} (${k.curve})`).join(", ") : "a key listed under authentication or assertionMethod"}. It is one line, with no newline at the end:`,
					copy: statement.text
				},
				...curve === "secp256k1" ? [] : [{
					text: `With jose (Node.js 20 or later), a JWS: save this as sign.mjs and run it with your ${curve} private key as a JWK file.`,
					copy: joseScript(statement.text, key?.id)
				}],
				{
					text: `With @noble/curves (Node.js), a raw signature: save this as sign.mjs and run it with your ${curve} private key in hex.`,
					copy: nobleScript(statement.text, curve)
				},
				{
					text: `Or with OpenSSL 3 and your ${curve} key in PEM:`,
					copy: opensslCommand(statement.text, curve)
				},
				{ text: `Paste what it prints: a compact JWS (${didJwsAlg(curve)}, attached or detached), or the signature in hex or base64. If your DID lists several keys, you may write the key id first: #key-1 <signature>.` }
			],
			paste: {
				label: "JWS or signature",
				placeholder: "eyJhbGciOi… or the signature in hex",
				multiline: true
			}
		};
	},
	async parse(pasted, statement) {
		const did = statement.binding.subject;
		const paste = parseDidSignaturePaste(pasted);
		const { document } = await resolveDid(did, { fetch: uiFetch });
		const messages = didSignedMessages(statement.text);
		if (paste.kind === "jws") return {
			method: "jws",
			vm: checkDidJws(paste.jws, messages, document).key.id,
			jws: paste.jws
		};
		const check = checkDidSignature(paste.signature, messages, document, paste.vm);
		return {
			method: "sig",
			vm: check.key.id,
			sig: toBase64Url(check.signature)
		};
	}
};
var webOnly = (statement) => {
	const did = statement.binding.subject;
	if (parseDid(did).method !== "web") throw new DidError("Publishing works for did:web only: sign the statement instead");
	return did;
};
var fileSigner = {
	id: "file",
	kind: "publish",
	label: "Publish a file beside did.json",
	description: "did:web only: upload a small file next to your did.json. Contacts' apps download both from your server.",
	instructions(statement) {
		const did = webOnly(statement);
		return { steps: [
			{
				text: "Create this file on your web server, beside your did.json:",
				copy: didWebFileUrl(did, statement.id)
			},
			{
				text: "With exactly this content:",
				copy: didWebFile(did, statement.text)
			},
			{
				text: "Serve it over HTTPS at exactly that address, without any redirect, and with this header so browsers may read it (your did.json needs it too):",
				copy: "Access-Control-Allow-Origin: *"
			},
			{ text: "Then press Check. The file stays public while the proof is in use; deleting it withdraws this proof from every contact at their next check." }
		] };
	},
	evidence: () => ({ method: "file" })
};
var serviceSigner = {
	id: "service",
	kind: "publish",
	label: "Add a service to did.json",
	description: "did:web only: add one entry to the service list of your did.json. Contacts' apps read it there.",
	instructions(statement) {
		const did = webOnly(statement);
		const seen = lastDidResolution(did);
		return { steps: [{
			text: `Add this entry to the "service" list of your did.json${seen?.documentUrl ? ` (${seen.documentUrl})` : ""}:`,
			copy: JSON.stringify(didGhostlyServiceEntry(did, statement.binding.key, statement.id), null, 2)
		}, { text: "Then press Check. Removing the entry withdraws this proof from every contact at their next check." }] };
	},
	evidence: () => ({ method: "service" })
};
function previewOf(r) {
	const keys = signingKeys(r.document);
	const unusable = r.document.keys.length - keys.length + r.document.skipped;
	if (!keys.length && r.method !== "web") throw new DidError("This DID lists no Ed25519, secp256k1 or P-256 key for authentication or assertionMethod, so it cannot sign");
	const facts = [{
		label: "Method",
		value: `did:${r.method}${r.method === "key" || r.method === "jwk" ? ", the key is the identifier" : ""}`
	}];
	if (r.host) facts.push({
		label: "Domain",
		value: r.host
	});
	if (r.documentUrl) facts.push({
		label: "Document",
		value: r.documentUrl
	});
	if (r.relay) facts.push({
		label: "Relay",
		value: r.relay.replace(/^https:\/\//, "")
	});
	facts.push({
		label: keys.length === 1 ? "Key" : "Keys",
		value: keys.length ? keys.map((k) => `${fragment(k.id)} (${k.curve})`).join(", ") : "none that can sign: publish instead"
	});
	if (unusable > 0) facts.push({
		label: "Not usable",
		value: `${unusable} ${unusable === 1 ? "key" : "keys"}: another curve, or not for authentication or assertionMethod`
	});
	return {
		facts,
		signers: r.method === "web" ? [
			...keys.length ? ["sign"] : [],
			"file",
			"service"
		] : ["sign"]
	};
}
var did = {
	id: "did",
	label: "DID",
	category: "self-custodied",
	summary: "did:key, did:jwk, did:dht or did:web",
	description: "Proves you control a decentralized identifier (W3C DID): sign the statement with a key its DID document lists, or, for did:web, publish it beside your did.json.",
	limits: "Does not prove who controls the DID, only that whoever added the proof held one of its keys (or its website).",
	platforms: [
		"web",
		"extension",
		"desktop"
	],
	advanced: true,
	experimental: true,
	subject: {
		label: "DID",
		placeholder: "did:key:z6Mk… or did:web:example.com",
		help: "did:key, did:jwk, did:dht or did:web. Contacts see the whole DID, and the key that signed.",
		normalize(input) {
			const canonical = normalizeDid(input);
			if (canonical === ownDid()) throw new DidError("That is this profile's own Ghostly DID: your contacts already see your Ghostly identity. Add another DID.");
			return canonical;
		},
		short: shortDid,
		preview: async (subject, { signal }) => previewOf(await resolveDid(subject, {
			fetch: uiFetch,
			signal
		}))
	},
	publicUri: (subject) => subject,
	validity: {
		defaultDays: 90,
		maxDays: 365
	},
	recheck: { afterSeconds: 86400 },
	privacy: "did:key and did:jwk: nothing, checked on this device. did:web: the contact's app asks its DNS-over-HTTPS resolver for your domain and downloads your did.json, so your web server sees the contact's IP address. did:dht: a Pkarr relay learns which DID was looked up.",
	signers: [
		signer,
		fileSigner,
		serviceSigner
	],
	parseEvidence(raw) {
		const e = raw;
		if (exactKeys$1(raw, "jws,method,vm") && e.method === "jws" && typeof e.jws === "string" && e.jws.length <= 4096 && validVm(e.vm)) return {
			method: "jws",
			vm: e.vm,
			jws: e.jws
		};
		if (exactKeys$1(raw, "method,sig,vm") && e.method === "sig" && typeof e.sig === "string" && SIG.test(e.sig) && validVm(e.vm)) return {
			method: "sig",
			vm: e.vm,
			sig: e.sig
		};
		if (exactKeys$1(raw, "method") && (e.method === "file" || e.method === "service")) return { method: e.method };
		throw new Error("That is not DID proof evidence");
	},
	async verify(statement, evidence, ctx) {
		const subject = statement.binding.subject;
		const { method } = parseDid(subject);
		if (normalizeDid(subject) !== subject) throw new DidError("The DID is not in canonical form");
		if ((evidence.method === "file" || evidence.method === "service") && method !== "web") throw new DidError("Only a did:web can publish its proof");
		const options = {
			fetch: ctx.fetch,
			signal: ctx.signal,
			now: () => ctx.now * 1e3
		};
		const { document, host } = await resolveDid(subject, options);
		const messages = didSignedMessages(statement.text);
		if (evidence.method === "jws" || evidence.method === "sig") {
			const check = evidence.method === "jws" ? checkDidJws(evidence.jws, messages, document) : checkDidSignature(strictBase64Url(evidence.sig), messages, document, evidence.vm);
			if (check.key.id !== evidence.vm) throw new DidError("Signed by another key than the proof names");
			return {
				subject,
				source: `did:${method} · ${evidence.method === "jws" ? `${check.alg} JWS` : `${check.alg} signature`} by ${fragment(check.key.id)}`
			};
		}
		if (evidence.method === "service") {
			if (!document.services.some((s) => s.proof === statement.id && s.key === statement.binding.key)) throw new DidError("The did.json has no Ghostly service for this proof: it was removed, or not added yet");
			return {
				subject,
				source: `did:web · service in the did.json of ${host}`
			};
		}
		const text = await fetchDidWebFile(subject, statement.id, options);
		if (text === void 0) throw new DidError(`${didWebFileUrl(subject, statement.id)} was not found: it was deleted, or not uploaded yet`);
		if (!didWebFileNames(text, subject, statement.text)) throw new DidError(`${didWebFileUrl(subject, statement.id)} is not the statement of this proof`);
		return {
			subject,
			source: `did:web · statement file beside the did.json of ${host}`
		};
	}
};
//#endregion
//#region ../browser/src/proofs/atproto/oauth.ts
/**
* The prover's half of AT Protocol proofs: AT Protocol OAuth (PAR + PKCE + DPoP, through the official
* `@atproto/oauth-client`) against the person's own server, then one record written or deleted. Every
* flow gets a fresh client whose stores live in memory only: the DPoP key (a non-extractable WebCrypto
* key), the PKCE verifier and the tokens exist for this one flow, are never logged or persisted, and the
* session is revoked (signOut) as soon as the record is written. Nothing is kept for later: removing
* the proof asks the person again.
*
* The client is identified by the URL of its metadata document (no registration with anyone):
* https://ghostly.tools/oauth/client-metadata.json, which is ATPROTO_CLIENT_METADATA verbatim
* (apps/website/public/oauth/client-metadata.json; a unit test keeps the two equal). A web app served from
* a loopback address (development, the e2e suite) uses AT Protocol's `http://localhost` development
* client instead, which needs no document.
*/
var ATPROTO_CLIENT_ID = "https://ghostly.tools/oauth/client-metadata.json";
var ATPROTO_REDIRECTS = {
	/** The web app's static callback page (shared with OpenID Connect): the answer stays in the fragment. */
	web: "https://app.ghostly.tools/oidc-callback.html",
	/** chrome.identity.launchWebAuthFlow catches it without loading it. */
	extension: `https://nbedaagicniejlmfcncndfjcejaidbcf.chromiumapp.org/atproto`,
	/** The desktop app's one-shot listener on 127.0.0.1; the port is not part of the match. */
	desktop: "http://127.0.0.1/oidc-callback"
};
/**
* `native` because the desktop app's loopback redirect is only allowed for native clients; HTTPS
* redirects (web, extension) are allowed for them too. No `refresh_token` grant: Ghostly never keeps
* a session, so it never gets a refresh token to lose.
*/
var ATPROTO_CLIENT_METADATA = {
	client_id: ATPROTO_CLIENT_ID,
	client_name: "Ghostly",
	client_uri: "https://ghostly.tools",
	logo_uri: "https://ghostly.tools/icon-192.png",
	application_type: "native",
	grant_types: ["authorization_code"],
	response_types: ["code"],
	scope: ATPROTO_DECLARED_SCOPE,
	token_endpoint_auth_method: "none",
	dpop_bound_access_tokens: true,
	redirect_uris: [
		ATPROTO_REDIRECTS.web,
		ATPROTO_REDIRECTS.extension,
		ATPROTO_REDIRECTS.desktop
	]
};
/** AT Protocol's development client: no document, loopback redirects only, any port. */
function loopbackClientMetadata(redirectUri) {
	const registered = new URL(redirectUri);
	registered.port = "";
	return {
		client_id: `http://localhost?${new URLSearchParams({
			redirect_uri: registered.href,
			scope: ATPROTO_DECLARED_SCOPE
		})}`,
		application_type: "native",
		grant_types: ["authorization_code"],
		response_types: ["code"],
		scope: ATPROTO_DECLARED_SCOPE,
		token_endpoint_auth_method: "none",
		dpop_bound_access_tokens: true,
		redirect_uris: [registered.href]
	};
}
var isLoopback = (url) => {
	try {
		const u = new URL(url);
		return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "[::1]");
	} catch {
		return false;
	}
};
var withoutPort = (url) => {
	const u = new URL(url);
	u.port = "";
	return u.href;
};
/**
* The client for a redirect: the published one, or the development client on a loopback web app. A
* loopback redirect is registered without its port (servers match any port), but the library checks
* the exact address locally, so the one in use is added to the copy it gets; the server only ever sees
* the client id and reads the registered addresses itself.
*/
function clientMetadataFor(platform, redirectUri) {
	const base = platform === "web" && isLoopback(redirectUri) ? loopbackClientMetadata(redirectUri) : ATPROTO_CLIENT_METADATA;
	const registered = base.redirect_uris;
	if (!(registered.includes(redirectUri) || isLoopback(redirectUri) && registered.includes(withoutPort(redirectUri)))) throw new Error("This Ghostly build cannot sign in to an AT Protocol server here (its return address is not registered).");
	return {
		...base,
		redirect_uris: [.../* @__PURE__ */ new Set([redirectUri, ...registered])]
	};
}
var scopeFor = (access) => access === "full" ? ATPROTO_FULL_SCOPE : ATPROTO_PROOF_SCOPE;
/** The server refused the narrow permission: it predates granular scopes. */
var AtprotoScopeError = class extends Error {};
/** The account a handle (or a DID typed as is) names, with its document. */
async function lookupAtprotoAccount(input, options) {
	const value = input.trim();
	if (value.startsWith("did:")) return resolveAtprotoDid(value, options);
	const handle = options.normalize(value);
	if (!handle) throw new Error("That is not a handle (like alice.bsky.social)");
	const did = await resolveAtprotoHandle(handle, options);
	if (!did) throw new Error(`${handle} does not point to an AT Protocol account`);
	const doc = await resolveAtprotoDid(did, options);
	if (doc.handle !== handle) throw new Error(`${handle} points to an account that names another handle`);
	return doc;
}
var MESSAGES = {
	access_denied: "You declined on your server. Nothing was published.",
	login_required: "Log in on your server and try again.",
	consent_required: "Your server needs your approval to continue."
};
/** The redirect's parameters: the fragment (Ghostly asks for fragment responses), then the query. */
function callbackParams(redirected, redirectUri) {
	const url = new URL(redirected), expected = new URL(redirectUri);
	if (url.origin !== expected.origin || url.pathname !== expected.pathname) throw new Error("Sign-in returned to an unexpected address.");
	const params = new URLSearchParams(url.hash.slice(1));
	for (const [k, v] of new URLSearchParams(url.search)) if (!params.has(k)) params.set(k, v);
	return params;
}
var pdsHost = (pds) => new URL(pds).host;
/** Runs OAuth for `account`, hands `work` a session scoped to this flow, and always revokes it afterwards. */
async function withSession(options, work) {
	const { window: w, account, signal } = options;
	signal.throwIfAborted();
	const [{ OAuthClient }, { WebcryptoKey }] = await Promise.all([import("@atproto/oauth-client"), import("@atproto/jwk-webcrypto")]);
	const states = /* @__PURE__ */ new Map(), sessions = /* @__PURE__ */ new Map();
	let state;
	const memory = (map, onSet) => ({
		async get(key) {
			return map.get(key);
		},
		async set(key, value) {
			onSet?.(key);
			map.set(key, value);
		},
		async del(key) {
			map.delete(key);
		}
	});
	const client = new OAuthClient({
		responseMode: "fragment",
		clientMetadata: clientMetadataFor(options.platform, w.redirectUri),
		stateStore: memory(states, (key) => {
			state = key;
		}),
		sessionStore: memory(sessions),
		runtimeImplementation: {
			createKey: (algs) => WebcryptoKey.generate(algs),
			getRandomValues: (length) => crypto.getRandomValues(new Uint8Array(length)),
			digest: async (data, { name }) => new Uint8Array(await crypto.subtle.digest(`SHA-${name.slice(3)}`, data))
		},
		identityResolver: { async resolve(input) {
			const did = input.startsWith("did:") ? input : await resolveAtprotoHandle(input, options.resolve);
			if (!did) throw new Error("The account could not be resolved");
			const doc = await fetchDidJson(did, options.resolve);
			return {
				did,
				didDoc: doc.json,
				handle: doc.parsed.handle ?? "handle.invalid"
			};
		} },
		fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
		allowHttp: false
	});
	let url;
	try {
		url = await client.authorize(account.did, {
			scope: scopeFor(options.access),
			redirect_uri: w.redirectUri,
			signal
		});
	} catch (e) {
		const text = String(e?.error ?? e?.message ?? e);
		if (/invalid_scope/i.test(text) || /scope/i.test(String(e?.errorDescription ?? ""))) throw new AtprotoScopeError("Your server does not offer a permission limited to Ghostly's records: it only offers full access to your account. Choose \"Your server, full access\" to continue anyway; Ghostly still only writes this one record.");
		throw new Error(`Your server (${pdsHost(account.pds)}) refused to start the sign-in.`);
	}
	if (!state) throw new Error("The sign-in could not start.");
	options.onProgress(`Approve on ${pdsHost(account.pds)} in the window that opened…`);
	const redirected = await w.authorize(url.href, state, signal);
	signal.throwIfAborted();
	const params = callbackParams(redirected, w.redirectUri);
	const error = params.get("error");
	if (error) throw new Error(MESSAGES[error] ?? "Your server refused the sign-in.");
	let session;
	try {
		({session} = await client.callback(params, { redirect_uri: w.redirectUri }));
	} catch {
		throw new Error("The sign-in could not be completed. Nothing was published.");
	}
	try {
		if (session.did !== account.did) throw new Error("You logged in to another account than the one you typed. Nothing was published.");
		return await work(session);
	} finally {
		await session.signOut().catch(() => {});
		sessions.clear();
		states.clear();
	}
}
/** A DID's document, checked, and the JSON the library reads its services from. */
async function fetchDidJson(did, options) {
	let json;
	const recording = async (url, init) => {
		const response = await options.fetch(url, init);
		try {
			json = JSON.parse(response.text);
		} catch {}
		return response;
	};
	return {
		parsed: await resolveAtprotoDid(did, {
			...options,
			fetch: recording
		}),
		json
	};
}
async function xrpcError(response) {
	const body = await response.json().catch(() => ({}));
	return `${body.error ?? response.status}${body.message ? `: ${body.message}` : ""}`;
}
/** Writes the proof record (rkey = the proof key) and returns once the server has it. */
async function publishAtprotoProof(statement, options) {
	await withSession(options, async (session) => {
		options.onProgress(`Publishing the proof on ${pdsHost(options.account.pds)}…`);
		const response = await session.fetchHandler("/xrpc/com.atproto.repo.createRecord", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				repo: session.did,
				collection: ATPROTO_PROOF_COLLECTION,
				rkey: atprotoProofRkey(statement.binding.key),
				record: atprotoProofRecord(statement, /* @__PURE__ */ new Date())
			})
		});
		if (response.status === 403) throw new AtprotoScopeError("Your server did not let Ghostly write its record. Choose \"Your server, full access\" to try again.");
		if (!response.ok) throw new Error(`Your server did not publish the record (${await xrpcError(response)}).`);
	});
}
/** Deletes the proof record. Deleting a record that is not there succeeds. */
async function unpublishAtprotoProof(proofKey, options) {
	await withSession(options, async (session) => {
		options.onProgress(`Deleting the record on ${pdsHost(options.account.pds)}…`);
		const response = await session.fetchHandler("/xrpc/com.atproto.repo.deleteRecord", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				repo: session.did,
				collection: ATPROTO_PROOF_COLLECTION,
				rkey: atprotoProofRkey(proofKey)
			})
		});
		if (response.status === 403) throw new AtprotoScopeError("Your server did not let Ghostly delete its record.");
		if (!response.ok) throw new Error(`Your server did not delete the record (${await xrpcError(response)}).`);
	});
}
//#endregion
//#region ../browser/src/proofs/providers/atproto.ts
/** The proof CAR: a commit, the tree path and one small record. Real repositories' paths are a few KiB. */
var RECORD_PROOF_MAX_BYTES = 262144;
function currentHost() {
	try {
		return getBrowserHost().atproto;
	} catch {
		return;
	}
}
var hostOf = (url) => new URL(url).host;
function createAtprotoIdentityProvider(options = {}) {
	const host = options.host ?? currentHost;
	const uiFetch = () => options.fetch ?? boundedIdentityFetch({ online: () => true });
	const resolveOptions = (fetch, signal) => ({
		fetch,
		signal,
		resolver: chosenResolver().id,
		...options.plc ? { plc: options.plc } : {}
	});
	/** Opens the window from the click, looks the account up, then runs OAuth for `work`; always closes the window. */
	function signIn(input, access, ctx, work) {
		const h = host();
		const opening = h?.open();
		return (async () => {
			if (!h || !opening) throw new Error("Signing in to an AT Protocol server is not available here.");
			const w = await opening;
			try {
				const resolve = resolveOptions(uiFetch(), ctx.signal);
				ctx.onProgress(`Looking up ${input.trim()}…`);
				const account = await lookupAtprotoAccount(input, {
					...resolve,
					normalize: normalizeAtprotoHandle
				});
				ctx.signal.throwIfAborted();
				return await work({
					platform: h.platform,
					window: w,
					account,
					access,
					signal: ctx.signal,
					resolve,
					onProgress: ctx.onProgress,
					fetch: options.oauthFetch
				});
			} finally {
				w.close();
			}
		})();
	}
	const signer = (id, access, label, description) => ({
		id,
		kind: "in-app",
		label,
		description,
		action: access === "full" ? "Continue on your server (full access)" : "Continue on your server",
		available: () => !!host(),
		fields: [{
			name: "handle",
			label: "Handle",
			kind: "text",
			placeholder: "alice.bsky.social",
			help: "Your Bluesky handle, your own domain if you use one, or your DID."
		}],
		run(ctx, work) {
			return signIn(ctx.values.handle ?? "", access, ctx, (flow) => work({
				subject: async () => flow.account.did,
				sign: async (statement) => {
					await publishAtprotoProof(statement, flow);
					return {};
				}
			}));
		}
	});
	const fullAccessServers = /* @__PURE__ */ new Set();
	return {
		id: "atproto",
		label: "Bluesky / AT Protocol",
		category: "self-custodied",
		summary: "Publish a record on your Bluesky server",
		description: "Proves you control a Bluesky (AT Protocol) account: approve on your server, and Ghostly publishes one record in your account's repository. It is public, like the rest of your repository: anyone can see this account made a Ghostly proof, not who you share it with. Contacts check it without logging in.",
		limits: "Signed with your account's key, which your server usually holds. It proves control of the account, not who you are; the handle is shown only while it points back to the account.",
		platforms: [
			"web",
			"extension",
			"desktop"
		],
		subject: {
			label: "Account (DID)",
			placeholder: "did:plc:…",
			normalize(input) {
				const did = input.trim();
				if (!isAtprotoDid(did)) throw new Error("Not an AT Protocol account (did:plc or did:web)");
				return did;
			},
			short: shortAtprotoDid
		},
		publicUri: (did) => `at://${did}`,
		validity: {
			defaultDays: 90,
			maxDays: 365
		},
		recheck: { afterSeconds: 3600 },
		privacy: "Your contact's app asks the PLC directory (or your did:web host) for your account's document, your server for the record, and its DNS-over-HTTPS resolver or your handle's website for your handle, so they learn this account was checked.",
		signers: [signer("atproto-oauth", "proof-records", "Your server (Bluesky or another PDS)", "Opens your server's login page. Ghostly asks only to create and delete its own proof records: never to post, read your messages or edit your profile."), signer("atproto-oauth-full", "full", "Your server, full access (older servers)", "Only if your server says it cannot limit Ghostly's permission: it then asks for access to your whole account. Ghostly still only writes this one record, and gives the access back right away.")],
		parseEvidence(raw) {
			if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length) throw new Error("Invalid AT Protocol evidence");
			return {};
		},
		async verify(statement, _evidence, ctx) {
			const did = statement.binding.subject;
			if (!isAtprotoDid(did)) throw new Error("Not an AT Protocol account");
			const resolve = resolveOptions(ctx.fetch, ctx.signal);
			const doc = await resolveAtprotoDid(did, resolve);
			await assertPublicServer(hostOf(doc.pds).replace(/:\d+$/, ""), resolve);
			const rkey = atprotoProofRkey(statement.binding.key);
			const url = `${doc.pds}/xrpc/com.atproto.sync.getRecord?${new URLSearchParams({
				did,
				collection: ATPROTO_PROOF_COLLECTION,
				rkey
			})}`;
			let response;
			try {
				response = await ctx.fetch(url, {
					headers: { accept: "application/vnd.ipld.car" },
					maxBytes: RECORD_PROOF_MAX_BYTES,
					signal: ctx.signal,
					redirect: "error"
				});
			} catch (e) {
				throw new Error(/too large/i.test(String(e)) ? "The account's server sent a proof that is too large" : `The account's server (${hostOf(doc.pds)}) could not be reached`);
			}
			if (response.status !== 200) {
				let code = "";
				try {
					code = String(JSON.parse(response.text).error ?? "");
				} catch {}
				if (code === "RecordNotFound") throw new Error("The record is no longer in the account's repository");
				if (/^Repo(NotFound|Deactivated|Takendown|Suspended)$/.test(code)) throw new Error("The account is no longer on its server");
				throw new Error(`The account's server (${hostOf(doc.pds)}) did not send the record`);
			}
			let proof;
			try {
				proof = verifyAtprotoRecordProof(response.bytes, {
					did,
					key: doc.key,
					collection: ATPROTO_PROOF_COLLECTION,
					rkey
				});
			} catch (e) {
				throw new Error(e instanceof AtprotoProofError ? `The account's repository does not prove the record: ${e.message}` : "The account's repository could not be read");
			}
			if (!proof.record) throw new Error("The record is no longer in the account's repository");
			checkAtprotoProofRecord(proof.record.value, statement);
			const handle = await verifiedAtprotoHandle(doc, resolve);
			return {
				subject: did,
				source: `Record signed with the account's key, from ${hostOf(doc.pds)}`,
				display: {
					...handle ? { name: `@${handle}` } : {},
					url: `https://bsky.app/profile/${did}`,
					source: handle ? "Handle checked both ways: it points to this account" : "The account's handle does not point back to it, so it is not shown",
					fetchedAt: ctx.now
				}
			};
		},
		unpublish: {
			description: "Also deletes the record on your server: your server asks you to approve.",
			run(proof, ctx) {
				return signIn(proof.subject, "proof-records", ctx, async (flow) => {
					const access = fullAccessServers.has(flow.account.pds) ? "full" : "proof-records";
					try {
						await unpublishAtprotoProof(proof.key, {
							...flow,
							access
						});
					} catch (e) {
						if (e instanceof AtprotoScopeError && access !== "full") {
							fullAccessServers.add(flow.account.pds);
							throw new Error("Your server only offers full access to your account. Try again to approve that; Ghostly only deletes this one record.");
						}
						throw e;
					}
				});
			}
		}
	};
}
var atproto = createAtprotoIdentityProvider();
//#endregion
//#region ../browser/src/proofs/pubky.ts
/**
* Pubky, browser side: reading a key's records and files the way a contact's app does (through the proof
* contract's bounded `ctx.fetch` only), and asking the person to approve one Pubky auth request in Pubky Ring or
* Pubky Passport (https://github.com/pubky/pubky-passport/blob/main/docs/integration.md). See WISP 302.
*/
/** Pkarr relays the records are read from: Pubky's own, the ones the Pubky SDK uses. */
var PUBKY_RELAYS = ["https://pkarr.pubky.org", "https://pkarr.pubky.app"];
/**
* The newest DNS packet the relays hold for `key`, its signature checked against `key`. Every relay is asked; one
* that is down, answers garbage or holds an older packet does not count. Throws when none has a valid one.
*/
async function pubkyRecords(key, fetch, signal, relays = PUBKY_RELAYS) {
	const failed = [];
	const newest = (await Promise.all(relays.map(async (relay) => {
		let r;
		try {
			r = await fetch(`${relay.replace(/\/+$/, "")}/${key}`, {
				maxBytes: RELAY_PAYLOAD_MAX_BYTES,
				signal
			});
		} catch (e) {
			failed.push(e);
			return;
		}
		try {
			return r.status === 200 ? openRelayPayload(key, r.bytes) : void 0;
		} catch {
			return;
		}
	}))).filter((a) => !!a).sort((a, b) => b.seq > a.seq ? 1 : b.seq < a.seq ? -1 : 0)[0];
	if (!newest && failed.length === relays.length && failed[0] instanceof Error) throw failed[0];
	if (!newest) throw new Error("This Pubky key has no records on the Pkarr relays");
	return newest.dnsPacket;
}
/** Where `key`'s homeserver answers browsers: its `_pubky` record, then the homeserver's own HTTPS record. */
async function pubkyHomeserver(key, fetch, signal, relays) {
	const homeserver = pubkyHomeserverOf(await pubkyRecords(key, fetch, signal, relays), key);
	if (!homeserver) throw new Error("This Pubky key names no homeserver");
	const endpoint = homeserverWebEndpoint(await pubkyRecords(homeserver, fetch, signal, relays), homeserver);
	if (!endpoint) throw new Error("The homeserver of this Pubky key publishes no address a browser can reach");
	return {
		homeserver,
		endpoint
	};
}
/**
* A public file of `key` at `path`, from the homeserver its own records name: bounded, no redirects, the owner in the
* `pubky-host` header the way the SDK addresses it. `undefined` when the homeserver says it is not there.
*
* The key's owner chooses that host, so it is contacted only on port 443 and only once its addresses are all public
* (the name is resolved first through the chosen DNS-over-HTTPS resolver): a proof never makes a contact's app knock
* on its own network. Failures on the way there are IdentityCheckUnavailable, which the contact is not told about.
*/
async function readPubkyFile(key, path, fetch, signal, relays, resolver = chosenResolver().id) {
	const { endpoint: { host, port } } = await pubkyHomeserver(key, fetch, signal, relays);
	if (port !== void 0) throw new IdentityCheckUnavailable(`The homeserver ${host} answers on port ${port}; only port 443 is contacted`);
	try {
		await assertPublicHost(host, {
			fetch,
			signal,
			resolver
		});
	} catch (e) {
		throw new IdentityCheckUnavailable(`The homeserver ${host} was not contacted: ${e instanceof Error ? e.message : String(e)}`);
	}
	let r;
	try {
		r = await fetch(`https://${host}${path}`, {
			headers: { "pubky-host": key },
			maxBytes: PUBKY_PROOF_MAX_BYTES,
			signal
		});
	} catch (e) {
		if (/too large/i.test(String(e))) throw e;
		throw new IdentityCheckUnavailable(`The homeserver ${host} could not be reached`);
	}
	if (r.status === 404) return {
		text: void 0,
		host
	};
	if (r.status !== 200) throw new IdentityCheckUnavailable(`The homeserver ${host} answered ${r.status}`);
	return {
		text: r.text,
		host
	};
}
/** The app identifier Pubky Ring and Passport list the grant under. */
var PUBKY_CLIENT_ID = "ghostly.tools";
var PASSPORT_ORIGIN = "https://passport.pubky.app";
/** How long one request waits: Pubky's relay keeps a message about five minutes. */
var APPROVAL_TIMEOUT = 3e5;
var POLL_EVERY = 1e3;
/**
* Passport's authorize page for a request. The authorization URL carries the relay secret: it goes in the fragment
* (never sent to a server), encoded exactly once, and is never logged.
*/
var passportUrl = (authorizationUrl) => `${PASSPORT_ORIGIN}/authorize#d=${encodeURIComponent(authorizationUrl)}`;
/** Messages from the SDK may quote the request: nothing that looks like one reaches the UI or a log. */
var redact = (text) => text.replace(/pubkyauth:\/\/\S*/gi, "(request)").replace(/#d=\S*/g, "#d=(request)");
var failure = (what, e) => /* @__PURE__ */ new Error(`${what}${e instanceof Error && e.message ? `: ${redact(e.message)}` : ""}`);
/**
* Opens a Passport window from the click that calls it. It must run synchronously in the click handler, before
* anything is awaited, or the browser blocks the popup; the desktop app opens the system browser instead.
*/
function openPassportWindow(url) {
	let host;
	try {
		host = getBrowserHost();
	} catch {
		host = void 0;
	}
	if (host?.openPubkyPassport) {
		host.openPubkyPassport(url).catch(() => {});
		return;
	}
	return window.open(url, "pubky-passport", "popup,width=520,height=760");
}
/** A 401 or 403 from the homeserver: the session it was given is not one it accepts. */
var refused = (e) => {
	const status = e?.data?.statusCode;
	return status === 401 || status === 403;
};
/**
* Polls every request until one of them is approved and resolves with that session and its request; a cancel, the
* deadline or a failed poll ends the wait for all of them. Each request is freed once its last poll has settled
* (never while one is in flight), and a session that lands after the end is signed out at once; `onSettled` runs
* once all of that is done.
*/
function firstApproval(requests, signal, timeoutMs, onSettled) {
	return new Promise((resolve, reject) => {
		let over = false;
		let polling = requests.length;
		const wakers = /* @__PURE__ */ new Set();
		const end = (settle) => {
			if (over) return;
			over = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", cancel);
			for (const wake of wakers) wake();
			settle();
		};
		const cancel = () => end(() => reject(signal.reason));
		const timer = setTimeout(() => end(() => reject(/* @__PURE__ */ new Error("Nobody approved the request in time. Start again for a new one."))), timeoutMs);
		if (signal.aborted) cancel();
		else signal.addEventListener("abort", cancel, { once: true });
		const pause = () => new Promise((done) => {
			const wake = () => {
				clearTimeout(t);
				wakers.delete(wake);
				done();
			};
			const t = setTimeout(wake, POLL_EVERY);
			wakers.add(wake);
		});
		const poll = async (request) => {
			try {
				while (!over) {
					let session;
					try {
						session = await request.tryPollOnce();
					} catch (e) {
						end(() => reject(failure("The Pubky request failed", e)));
						return;
					}
					if (session && over) {
						try {
							await session.signout();
						} catch {} finally {
							session.free();
						}
						return;
					}
					if (session) {
						const approved = session;
						end(() => resolve({
							session: approved,
							request
						}));
						return;
					}
					if (!over) await pause();
				}
			} finally {
				request.free();
				if (--polling === 0) onSettled();
			}
		};
		for (const request of requests) poll(request);
	});
}
/**
* A request of a cookie session (Ring's approval) to its homeserver: its `/session` or a file of its storage
* (`/storage/<key>/pub/…`, or `/pub/…` where the homeserver does not address storage by path), sent with the
* browser's credentials. A grant session's requests carry an `Authorization` header instead, and the relay's
* and the Pkarr relays' are elsewhere: those stay the page's.
*/
var cookieSessionRequest = (request) => request.credentials === "include" && !request.headers.has("authorization") && /^\/(?:session$|storage\/|pub\/)/.test(new URL(request.url).pathname);
/** Statuses a Response carries no body with. */
var NO_BODY = /* @__PURE__ */ new Set([
	204,
	205,
	304
]);
/**
* Sends the SDK's cookie-session requests through `transport` until the returned function runs. The SDK fetches with
* the global fetch, so this wraps it; everything else goes on to the page's fetch as it was. The cookie the
* homeserver sets stays in the transport: the page, and so the SDK, never sees it.
*/
function routeCookieSession(transport) {
	const pageFetch = globalThis.fetch;
	let closed = false;
	const routed = async (input, init) => {
		const request = input instanceof Request && init === void 0 ? input : new Request(input, init);
		if (closed || !cookieSessionRequest(request)) return pageFetch(request);
		request.signal.throwIfAborted();
		const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
		let answer;
		try {
			answer = await transport.fetch({
				url: request.url,
				method: request.method,
				headers: [...request.headers],
				body
			});
		} catch (e) {
			throw Object.assign(new TypeError(e instanceof Error ? e.message : String(e)), { cause: e });
		}
		const response = new Response(NO_BODY.has(answer.status) ? null : answer.body, {
			status: answer.status,
			headers: answer.headers
		});
		Object.defineProperty(response, "url", { value: request.url });
		return response;
	};
	globalThis.fetch = routed;
	return () => {
		if (closed) return;
		closed = true;
		if (globalThis.fetch === routed) globalThis.fetch = pageFetch;
		transport.close();
	};
}
/** The host's way around a page that drops the homeserver's cookie, if it has one. */
function cookieSessionTransport() {
	try {
		return getBrowserHost().pubkyCookieSession?.();
	} catch {
		return;
	}
}
/**
* Starts one request for `capability` in each of the two forms Pubky signers read (a grant request for Passport, a
* cookie request for Ring's QR code: see below), shows both on one screen, and waits for whichever is approved
* first, then runs `work` with that session. The session lives only in this renderer's memory while `work` runs,
* and is signed out afterwards; nothing about it is stored. An approval that arrives after the end is signed out.
*/
async function withPubkyApproval(options, work) {
	const { signal } = options;
	signal.throwIfAborted();
	const { AuthFlow, GrantAuthFlow, AuthFlowKind } = await import("@synonymdev/pubky");
	signal.throwIfAborted();
	const relay = options.relay ?? null;
	let grant, cookie;
	try {
		grant = GrantAuthFlow.start(options.capability, AuthFlowKind.signin(), {
			clientId: PUBKY_CLIENT_ID,
			relay,
			xCallback: { xSource: "Ghostly" }
		});
	} catch (e) {
		throw failure("Could not start a Pubky request", e);
	}
	try {
		cookie = AuthFlow.start(options.capability, AuthFlowKind.signin(), relay, { xSource: "Ghostly" });
	} catch (e) {
		grant.free();
		throw failure("Could not start a Pubky request", e);
	}
	const opened = {};
	options.onApproval({
		open: {
			label: "Approve in your browser (Pubky Passport)",
			description: "Opens Pubky Passport. No Passport identity yet? It offers “Continue with Google” and makes one.",
			run: () => {
				const window = (options.openPassport ?? openPassportWindow)(passportUrl(grant.authorizationUrl));
				opened.window = window ?? null;
				if (window === null) options.onProgress("Your browser blocked the Passport window: allow pop-ups for Ghostly and press the button again, or scan the code with Pubky Ring.");
			}
		},
		qr: {
			value: cookie.authorizationUrl,
			label: "Or scan with Pubky Ring"
		},
		notes: ["An identity Passport makes with Google is recovered with Google plus Passport: both are needed, neither alone can.", "The code is your request: scan it yourself, and do not share it."]
	});
	const transport = cookieSessionTransport();
	const unroute = transport ? routeCookieSession(transport) : () => {};
	let settled;
	const polled = new Promise((done) => {
		settled = done;
	});
	try {
		return await approveAndWork(options, work, {
			grant,
			cookie,
			opened,
			settled,
			cookieKept: !!transport
		});
	} finally {
		polled.then(unroute);
	}
}
/**
* The rest of `withPubkyApproval`, once both requests are shown: the wait, the check, and the work. `cookieKept`: the
* host keeps a cookie session's cookie, so a refusal is not the page's cookie policy.
*/
async function approveAndWork(options, work, { grant, cookie, opened, settled, cookieKept }) {
	const { signal } = options;
	let session, viaCookie;
	try {
		const first = await firstApproval([grant, cookie], signal, options.timeoutMs ?? APPROVAL_TIMEOUT, settled);
		session = first.session;
		viaCookie = first.request === cookie;
	} finally {
		options.onApproval(null);
		try {
			if (opened.window && !opened.window.closed) opened.window.close();
		} catch {}
	}
	options.onProgress("Approved. Checking what Pubky granted…");
	let key;
	try {
		const info = session.info;
		const publicKey = info.publicKey;
		try {
			key = publicKey.z32();
			const granted = info.capabilities;
			if (granted.length !== 1 || granted[0] !== options.capability) throw new Error("The signer granted different permissions than Ghostly asked for (one proof folder). Nothing was written.");
		} finally {
			publicKey.free();
			info.free();
		}
	} catch (e) {
		await session.signout().catch(() => {});
		session.free();
		throw e;
	}
	const fail = (what) => (e) => {
		if (viaCookie && !cookieKept && refused(e)) throw new Error("Pubky Ring approved, but this browser blocks your homeserver's sign-in cookie (Vanadium and Safari block cookies from other sites), so nothing was written. Approve with Pubky Passport instead, or use Firefox or the Ghostly desktop app.");
		throw failure(what, e);
	};
	const approved = session;
	try {
		return await work({
			key,
			put: (path, text) => approved.storage.putText(path, text).catch(fail("Could not write to your homeserver")),
			delete: (path) => approved.storage.delete(path).catch(fail("Could not delete from your homeserver"))
		});
	} finally {
		try {
			await approved.signout();
		} catch {}
		approved.free();
	}
}
//#endregion
//#region ../browser/src/proofs/providers/pubky.ts
var short = (key) => `pubky${key.slice(0, 4)}…${key.slice(-4)}`;
/** Strict: exactly `{ folder }`, 64 hex characters. Nothing else, so no evidence can name a host or another path. */
function parseEvidence(raw) {
	const e = raw;
	if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).join(",") !== "folder" || !isPubkyProofFolder(e.folder)) throw new Error("That is not Pubky proof evidence");
	return { folder: e.folder };
}
function createPubkyIdentityProvider(options = {}) {
	const approve = (capability, ctx, work) => {
		if (!ctx.onApproval) throw new Error("This screen cannot show a Pubky request");
		return withPubkyApproval({
			...options.approval,
			capability,
			signal: ctx.signal,
			onApproval: ctx.onApproval,
			onProgress: ctx.onProgress
		}, work);
	};
	return {
		id: "pubky",
		label: "Pubky",
		category: "self-custodied",
		summary: "Approve in Pubky Ring or Passport",
		description: "Proves you hold a Pubky key: approve one request in Pubky Ring or Pubky Passport, and Ghostly writes a small proof file to your homeserver. Contacts’ apps read it back through your key’s own records.",
		limits: "The file is on your homeserver: whoever runs it could write there too. It does not prove who holds the key.",
		platforms: [
			"web",
			"extension",
			"desktop"
		],
		subject: {
			label: "Pubky key",
			placeholder: "pubky…",
			help: "Comes from Pubky Ring or Passport when you approve.",
			normalize: normalizePubkyKey,
			short
		},
		validity: {
			defaultDays: 90,
			maxDays: 365
		},
		recheck: { afterSeconds: 86400 },
		privacy: "Your contact’s app reads your key’s records from Pubky’s Pkarr relays (pkarr.pubky.org, pkarr.pubky.app), looks up your homeserver’s address through its DNS-over-HTTPS resolver (or the next one when that cannot be reached; it only contacts a public address, on port 443), and reads the proof file from your homeserver, which sees the contact’s IP address.",
		signers: [{
			id: "pubky-auth",
			kind: "in-app",
			label: "Pubky Ring or Pubky Passport",
			action: "Continue",
			description: "One request: approve it in Pubky Passport in your browser, or scan it with Pubky Ring. Ghostly only asks to write one small file to a new folder of your homeserver.",
			run(ctx, work) {
				const folder = newPubkyProofFolder();
				return approve(pubkyProofCapability(folder), ctx, async (session) => {
					let written;
					try {
						return await work({
							subject: async () => session.key,
							async sign(statement) {
								if (statement.binding.subject !== session.key) throw new Error("That is another Pubky identity");
								ctx.onProgress("Writing the proof to your homeserver…");
								const path = pubkyProofPath(folder, statement.id);
								await session.put(path, pubkyProofFile(statement));
								written = path;
								return { folder };
							}
						});
					} catch (e) {
						if (written) await session.delete(written).catch(() => {});
						throw e;
					}
				});
			}
		}],
		publicUri: (key) => `pubky://${key}`,
		parseEvidence,
		async verify(statement, { folder }, ctx) {
			const key = statement.binding.subject;
			if (!isPubkyKey(key)) throw new Error("That is not a Pubky key");
			const { text, host } = await readPubkyFile(key, pubkyProofPath(folder, statement.id), ctx.fetch, ctx.signal, options.relays);
			if (text === void 0) throw new Error("The proof file is not on the homeserver");
			if (text !== pubkyProofFile(statement)) throw new Error("The file on the homeserver is not this proof");
			return {
				subject: key,
				source: `File on the homeserver ${host}, found through the key’s own Pkarr records`
			};
		},
		unpublish: {
			description: "Also deletes the proof file on your homeserver: that takes one more approval in Pubky Ring or Passport, since Ghostly kept no access to it.",
			async run({ id, subject, evidence }, ctx) {
				const { folder } = parseEvidence(evidence);
				const path = pubkyProofPath(folder, id);
				return approve(pubkyProofCapability(folder), ctx, async (session) => {
					if (session.key !== subject) throw new Error("That is another Pubky identity: approve with the one this proof is for");
					ctx.onProgress("Deleting the proof file from your homeserver…");
					await session.delete(path);
				});
			}
		}
	};
}
var pubky = createPubkyIdentityProvider();
//#endregion
//#region ../browser/src/proofs/testing.ts
/**
* Fake identity providers, for unit tests and e2e. No network, no real accounts. They are in the
* registry only when `localStorage["ghostly-test-identities"] === "1"` (or a test passes them itself).
*
*  - fake-key      self-custodied: an Ed25519 key held by a fake in-app signer, or signed "outside" and pasted.
*  - fake-account  provider-attested: a fake issuer signs a token whose nonce is the statement id (like OIDC).
*  - fake-record   self-custodied, published: a record the verifier fetches through `ctx.fetch` (like DNS).
*/
var TEST_IDENTITIES_FLAG = "ghostly-test-identities";
var testIdentitiesEnabled = () => {
	try {
		return globalThis.localStorage?.getItem(TEST_IDENTITIES_FLAG) === "1";
	} catch {
		return false;
	}
};
var HEX64 = /^[a-f0-9]{64}$/;
var hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
var unhex = (s) => Uint8Array.from(s.match(/../g), (x) => parseInt(x, 16));
var normalizeHexKey = (input) => {
	const v = input.trim().toLowerCase();
	if (!HEX64.test(v)) throw new Error("Enter 64 hex characters");
	return v;
};
var exactKeys = (raw, keys) => !!raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).sort().join(",") === keys;
/** The key behind the fake in-app signer. Tests may replace it. */
var fakeKeyring = { seed: ed25519.utils.randomSecretKey() };
var fakeKeySubject = (seed = fakeKeyring.seed) => hex(ed25519.getPublicKey(seed));
var fakeKeySign = (statement, seed = fakeKeyring.seed) => ({ sig: toBase64Url(ed25519.sign(statement.bytes, seed)) });
var fakeKey = {
	id: "fake-key",
	label: "Test key",
	category: "self-custodied",
	summary: "Sign with the test key",
	description: "A test identity: an Ed25519 key held by this page. For tests only.",
	platforms: [
		"web",
		"extension",
		"desktop"
	],
	subject: {
		label: "Public key",
		placeholder: "64 hex characters",
		normalize: normalizeHexKey,
		short: (k) => `${k.slice(0, 8)}…${k.slice(-4)}`
	},
	publicUri: (k) => `urn:ghostly-test:${k}`,
	validity: {
		defaultDays: 30,
		maxDays: 365
	},
	privacy: "Nothing: checked on this device.",
	signers: [{
		id: "fake-signer",
		kind: "in-app",
		label: "Test signer",
		fields: [{
			name: "refuse",
			label: "Refuse",
			kind: "text",
			optional: true
		}],
		run: async (ctx, work) => {
			ctx.signal.throwIfAborted();
			if (ctx.values.refuse) throw new Error("The test signer refused");
			return work({
				subject: async () => fakeKeySubject(),
				sign: async (statement) => fakeKeySign(statement)
			});
		}
	}, {
		id: "fake-tool",
		kind: "external-tool",
		label: "Sign outside Ghostly",
		instructions: (statement) => ({
			steps: [{
				text: "Sign this statement with your test key:",
				copy: statement.text
			}],
			paste: { label: "Signature (base64url)" }
		}),
		parse: (pasted) => {
			const sig = pasted.trim();
			if (!/^[A-Za-z0-9_-]{86}$/.test(sig)) throw new Error("That is not a test signature");
			return { sig };
		}
	}],
	parseEvidence(raw) {
		const e = raw;
		if (!exactKeys(raw, "sig") || typeof e.sig !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(e.sig)) throw new Error("Invalid test evidence");
		return { sig: e.sig };
	},
	async verify(statement, evidence) {
		let ok;
		try {
			ok = ed25519.verify(fromBase64Url(evidence.sig), statement.bytes, unhex(statement.binding.subject));
		} catch {
			ok = false;
		}
		if (!ok) throw new Error("Invalid test signature");
		return {
			subject: statement.binding.subject,
			source: "Test signature (Ed25519)"
		};
	}
};
/** The fake issuer's key. Its public half is what fake-account trusts, like a provider's JWKS. */
var ISSUER_SEED = unhex("7a".repeat(32));
var FAKE_ISSUER = "https://issuer.ghostly.test";
/** What the fake login page signs: iss, sub, nonce (= statement id), iat. */
function fakeAccountToken(statement, account = "alice", seed = ISSUER_SEED, iat = statement.binding.issuedAt) {
	const payload = toBase64Url(utf8Encode(JSON.stringify({
		iss: FAKE_ISSUER,
		sub: account,
		nonce: statement.id,
		iat
	})));
	return { token: `${payload}.${toBase64Url(ed25519.sign(utf8Encode(payload), seed))}` };
}
var fakeAccount = {
	id: "fake-account",
	label: "Test account",
	category: "provider-attested",
	summary: "Log in to the test issuer",
	description: "A test login provider that vouches for an account. For tests only.",
	platforms: [
		"web",
		"extension",
		"desktop"
	],
	subject: {
		label: "Provider",
		options: [{
			value: FAKE_ISSUER,
			label: "Test issuer"
		}],
		normalize: (input) => {
			if (input.trim() !== "https://issuer.ghostly.test") throw new Error("Unknown test issuer");
			return FAKE_ISSUER;
		}
	},
	validity: {
		defaultDays: 30,
		maxDays: 90
	},
	privacy: "Nothing: the issuer's signature is checked on this device.",
	signers: [{
		id: "fake-login",
		kind: "redirect",
		label: "Log in to the test issuer",
		start: async (statement, ctx) => {
			ctx.signal.throwIfAborted();
			return fakeAccountToken(statement, ctx.values.account || "alice");
		}
	}],
	parseEvidence(raw) {
		const e = raw;
		if (!exactKeys(raw, "token") || typeof e.token !== "string" || e.token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/.test(e.token)) throw new Error("Invalid test token");
		return { token: e.token };
	},
	async verify(statement, { token }) {
		const [payload, sig] = token.split(".");
		if (!ed25519.verify(fromBase64Url(sig), utf8Encode(payload), ed25519.getPublicKey(ISSUER_SEED))) throw new Error("Not signed by the test issuer");
		const claims = JSON.parse(utf8Decode(fromBase64Url(payload)));
		if (claims.iss !== statement.binding.subject) throw new Error("Token from another issuer");
		if (claims.nonce !== statement.id) throw new Error("Token for another statement");
		if (typeof claims.sub !== "string" || !/^[a-z0-9]{1,64}$/.test(claims.sub)) throw new Error("Invalid account");
		return {
			subject: `${claims.iss}#${claims.sub}`,
			attester: "issuer.ghostly.test",
			source: "Token signed by the test issuer",
			display: {
				name: claims.sub,
				source: "Test issuer profile",
				fetchedAt: statement.binding.issuedAt
			}
		};
	}
};
/** fake-record's records: subject → published text. The verifier reads `https://records.ghostly.test/<subject>`. */
var FAKE_RECORD_HOST = "https://records.ghostly.test/";
var fakeRecordText = (statement) => `ghostly-proof=${statement.id}`;
var FAKE_IDENTITY_PROVIDERS = [
	fakeKey,
	fakeAccount,
	{
		id: "fake-record",
		label: "Test record",
		category: "self-custodied",
		summary: "Publish a test record",
		description: "A test record published where the verifier looks it up, like DNS. For tests only.",
		platforms: [
			"web",
			"extension",
			"desktop"
		],
		subject: {
			label: "Name",
			placeholder: "alice",
			normalize: (input) => {
				const v = input.trim().toLowerCase();
				if (!/^[a-z0-9-]{1,63}$/.test(v)) throw new Error("Letters, digits and dashes");
				return v;
			}
		},
		validity: {
			defaultDays: 30,
			maxDays: 365
		},
		recheck: { afterSeconds: 3600 },
		privacy: "The verifier asks records.ghostly.test for the record: that server learns the name was checked.",
		signers: [{
			id: "fake-publish",
			kind: "publish",
			label: "Publish a record",
			instructions: (statement) => ({ steps: [{
				text: `Publish this record for ${statement.binding.subject}:`,
				copy: fakeRecordText(statement)
			}] }),
			evidence: () => ({})
		}],
		parseEvidence(raw) {
			if (!exactKeys(raw, "")) throw new Error("Invalid test evidence");
			return {};
		},
		async verify(statement, _evidence, ctx) {
			const response = await ctx.fetch(`${FAKE_RECORD_HOST}${statement.binding.subject}`, {
				maxBytes: 4096,
				signal: ctx.signal
			});
			if (response.status !== 200 || !response.text.split("\n").includes(fakeRecordText(statement))) throw new Error("The record is not published");
			return {
				subject: statement.binding.subject,
				source: "Record published at records.ghostly.test"
			};
		}
	}
];
//#endregion
//#region ../browser/src/proofs/registry.ts
/**
* Every identity-proof provider built into Ghostly. Adding one is adding its module under `providers/`
* and ONE line here; see PROOFS.md. The order is the order of the picker on the Identities page. A
* provider written outside the app registers through `plugins/registry.ts` (the SDK) and comes after.
*/
var IDENTITY_PROVIDERS = [
	nostr,
	pubky,
	domain,
	openpgp,
	bitcoin,
	ssh,
	sshGithub,
	sshGitlab,
	oidc,
	did,
	atproto
];
reserveAdapterIds("identity", IDENTITY_PROVIDERS.map((p) => p.id));
var warned = /* @__PURE__ */ new Set();
/** The built-in providers, then the ones plugins registered (a built-in's id wins), then the fakes when this browser asked for them (e2e). */
function identityProviders() {
	const external = registeredIdentityProviders().filter((p) => {
		const taken = IDENTITY_PROVIDERS.some((b) => b.id === p.id);
		if (taken && !warned.has(p.id)) {
			warned.add(p.id);
			console.error(`[ghostly] identity provider ${p.id} from a plugin is ignored: a built-in has that id`);
		}
		return !taken;
	});
	return [
		...IDENTITY_PROVIDERS,
		...external,
		...testIdentitiesEnabled() ? FAKE_IDENTITY_PROVIDERS : []
	];
}
function identityProvider(id, providers = identityProviders()) {
	return providers.find((p) => p.id === id);
}
//#endregion
export { identityProvider as n, identityProviders as r, IDENTITY_PROVIDERS as t };

//# sourceMappingURL=registry-B6ICWeJm.js.map