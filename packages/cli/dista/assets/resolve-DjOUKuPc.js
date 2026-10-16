import { At as parseAtprotoDidDocument, Bi as wellKnownUrl, Di as DOMAIN_FILE_MAX_BYTES, Dl as toBase64Url, Fi as normalizeDomain, Ii as recordsFromTxt, Li as recordsFromWellKnown, Mi as encodeDnsQuery, Ni as isPublicAddress, Oi as decodeDnsResponse, Ot as isAtprotoDid, Pi as nip05RootKey, Ri as recordsName, Xi as boundVerifiedIdentity, ki as dnsProofName, wt as atprotoDidMethod, zi as txtValue } from "./src-dfGE33hw.js";
import { l as providerDescriptorProblems } from "./types-C4_KafL_.js";
//#region ../browser/src/proofs/verify.ts
var DAY = 86400;
/**
* The checks every proof goes through, whatever its provider: known provider, validity within the
* provider's limit, bounded evidence, strict parsing, the provider's own check, and the category rule
* (a self-custodied proof proves exactly the subject it names; an attested one says who attests it).
* The engine verifies a contact's proof, and the person's own proof before saving it, only through this.
*/
async function verifyIdentity(providers, statement, evidence, ctx) {
	const { binding } = statement;
	const provider = providers.find((p) => p.id === binding.provider);
	if (!provider) throw new Error("This app cannot verify this kind of identity");
	if (binding.expiresAt - binding.issuedAt > Math.min(provider.validity.maxDays * DAY, 3456e4)) throw new Error("The proof lasts longer than this kind of identity allows");
	if (JSON.stringify(evidence ?? null).length > 16384) throw new Error("Evidence too large");
	const parsed = provider.parseEvidence(evidence);
	const verified = boundVerifiedIdentity(await provider.verify(statement, parsed, ctx));
	if (provider.category === "self-custodied" && verified.subject !== binding.subject) throw new Error("The evidence is for another identity");
	if (provider.category === "provider-attested" && !verified.attester) throw new Error("The evidence does not say who attests it");
	return verified;
}
/** Problems with a provider's descriptor, empty when it is well-formed. The registry and the contract suite use it. */
function descriptorProblems(p) {
	const problems = [];
	if (!/^[a-z][a-z0-9-]{0,31}$/.test(p.id)) problems.push("id must match ^[a-z][a-z0-9-]{0,31}$");
	if (!p.label?.trim()) problems.push("label is empty");
	if (!p.description?.trim()) problems.push("description is empty");
	if (!p.privacy?.trim()) problems.push("privacy is empty: say what verify contacts");
	if (p.category !== "self-custodied" && p.category !== "provider-attested") problems.push("category is unknown");
	if (!p.platforms.length) problems.push("no platforms");
	const { defaultDays, maxDays } = p.validity;
	if (!(Number.isInteger(defaultDays) && Number.isInteger(maxDays) && defaultDays >= 1 && defaultDays <= maxDays && maxDays * DAY <= 3456e4)) problems.push("validity must be whole days, 1 ≤ default ≤ max ≤ 400");
	if (p.recheck && !(Number.isInteger(p.recheck.afterSeconds) && p.recheck.afterSeconds >= 60)) problems.push("recheck.afterSeconds must be at least 60");
	if (!p.signers.length) problems.push("no signers");
	const ids = p.signers.map((s) => s.id);
	if (new Set(ids).size !== ids.length) problems.push("signer ids are not unique");
	for (const s of p.signers) {
		if (![
			"in-app",
			"external-tool",
			"redirect",
			"publish"
		].includes(s.kind)) problems.push(`signer ${s.id} has an unknown kind`);
		if (s.kind === "in-app" && typeof s.run !== "function") problems.push(`signer ${s.id} has no run()`);
		if (s.kind === "external-tool" && (typeof s.instructions !== "function" || typeof s.parse !== "function")) problems.push(`signer ${s.id} needs instructions() and parse()`);
		if (s.kind === "redirect" && typeof s.start !== "function") problems.push(`signer ${s.id} has no start()`);
		if (s.kind === "publish" && (typeof s.instructions !== "function" || typeof s.evidence !== "function")) problems.push(`signer ${s.id} needs instructions() and evidence()`);
	}
	return problems;
}
/**
* The engine's `ctx.fetch`: HTTPS GET only, no credentials or referrer, a time-out, a size cap,
* redirects refused unless asked for.
* `online` false refuses everything (the person turned the network off).
*/
function boundedIdentityFetch(options = { online: () => true }) {
	return async (url, { headers, maxBytes = 65536, signal, redirect = "error" } = {}) => {
		if (!options.online()) throw new Error("Offline: this identity cannot be checked now");
		const target = new URL(url);
		if (target.protocol !== "https:" || target.username || target.password) throw new Error("Identity checks use HTTPS only");
		const timeout = AbortSignal.timeout(options.timeoutMs ?? 1e4);
		const response = await (options.fetcher ?? fetch)(target.href, {
			headers,
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			credentials: "omit",
			referrerPolicy: "no-referrer",
			cache: "no-store",
			redirect
		});
		if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("Identity check response too large");
		const reader = response.body?.getReader();
		const parts = [];
		let length = 0;
		if (reader) try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				length += value.length;
				if (length > maxBytes) throw new Error("Identity check response too large");
				parts.push(value);
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const part of parts) {
			bytes.set(part, offset);
			offset += part.length;
		}
		return {
			status: response.status,
			contentType: response.headers.get("content-type") ?? "",
			text: new TextDecoder().decode(bytes),
			bytes
		};
	};
}
//#endregion
//#region ../browser/src/plugins/bundled.ts
/**
* The adapter plugins compiled into this build. Empty unless the build lists some: `GHOSTLY_PLUGINS`
* names their modules (comma-separated paths from the repository root, each default-exporting a
* `GhostlyAdapterPlugin`), and the Vite plugin in `packages/browser/vite-plugin.ts` swaps this module
* for one that imports them. Release builds never set it; the e2e build carries the SDK example.
*/
var BUNDLED_PLUGINS = [];
var PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
var KEY = Symbol.for("ghostly.adapters/1");
function store() {
	const g = globalThis;
	return g[KEY] ??= {
		plugins: /* @__PURE__ */ new Map(),
		reserved: {
			lightning: /* @__PURE__ */ new Set(),
			onchain: /* @__PURE__ */ new Set(),
			identity: /* @__PURE__ */ new Set()
		},
		listeners: /* @__PURE__ */ new Set(),
		seeded: false
	};
}
var ids = (kind, plugin) => {
	const list = kind === "identity" ? plugin.identities : kind === "lightning" ? plugin.lightning : plugin.onchain;
	return Array.isArray(list) ? list.map((a) => a?.id) : [];
};
var KINDS = [
	"lightning",
	"onchain",
	"identity"
];
/** Problems with a plugin, empty when it can be registered. Does not look at what is already registered. */
function pluginProblems(plugin) {
	const problems = [];
	if (!plugin || typeof plugin !== "object") return ["not a plugin object"];
	if (!PLUGIN_ID.test(plugin.id ?? "")) problems.push("plugin id must match ^[a-z][a-z0-9-]{0,63}$");
	if (plugin.sdk !== 1) problems.push(`plugin was written for SDK API ${String(plugin.sdk)}; this app speaks 1`);
	if (plugin.version !== void 0 && (typeof plugin.version !== "string" || plugin.version.length > 64)) problems.push("version must be a short string");
	for (const kind of ["lightning", "onchain"]) {
		const list = plugin[kind];
		if (list === void 0) continue;
		if (!Array.isArray(list)) {
			problems.push(`${kind} must be a list of descriptors`);
			continue;
		}
		for (const d of list) {
			if (!d || typeof d !== "object") {
				problems.push(`${kind} ${String(d)}: not a descriptor`);
				continue;
			}
			const own = providerDescriptorProblems(d);
			if (d?.kind && d.kind !== kind) own.push(`is listed under ${kind} but says kind ${String(d.kind)}`);
			problems.push(...own.map((p) => `${kind} ${String(d?.id)}: ${p}`));
		}
	}
	if (plugin.identities !== void 0) {
		if (!Array.isArray(plugin.identities)) problems.push("identities must be a list of providers");
		else for (const p of plugin.identities) if (!p || typeof p !== "object") problems.push(`identity ${String(p)}: not a provider`);
		else problems.push(...descriptorProblems(p).map((m) => `identity ${String(p.id)}: ${m}`));
	}
	for (const kind of KINDS) {
		const list = ids(kind, plugin);
		if (new Set(list).size !== list.length) problems.push(`${kind} ids are not unique within the plugin`);
	}
	if (!KINDS.some((kind) => ids(kind, plugin).length)) problems.push("the plugin brings no adapter");
	return problems;
}
/** The built-in registries say which ids are theirs. A plugin using one is refused. */
function reserveAdapterIds(kind, list) {
	const s = store();
	for (const id of list) s.reserved[kind].add(id);
}
/**
* Registers a plugin's adapters. Throws, registering nothing, when the plugin is malformed, its id or
* one of its adapters' ids is taken (by a built-in or by another plugin), or its contract generation
* is another one. Returns the function that unregisters it.
*/
function registerAdapters(plugin) {
	const problems = pluginProblems(plugin);
	const s = store();
	if (!problems.length) {
		if (s.plugins.has(plugin.id)) problems.push(`a plugin with id ${plugin.id} is already registered`);
		for (const kind of KINDS) for (const id of ids(kind, plugin)) {
			if (s.reserved[kind].has(id)) problems.push(`${kind} ${id} is a built-in of this app`);
			for (const other of s.plugins.values()) if (ids(kind, other).includes(id)) problems.push(`${kind} ${id} is already registered by plugin ${other.id}`);
		}
	}
	if (problems.length) throw new Error(`Cannot register plugin ${String(plugin?.id)}: ${problems.join("; ")}`);
	s.plugins.set(plugin.id, plugin);
	notify(s);
	return () => {
		if (s.plugins.get(plugin.id) === plugin) {
			s.plugins.delete(plugin.id);
			notify(s);
		}
	};
}
function notify(s) {
	for (const listener of s.listeners) try {
		listener();
	} catch {}
}
/** Called when a plugin registers or unregisters: the engine re-reads the lists. */
function onAdaptersChanged(listener) {
	const s = store();
	s.listeners.add(listener);
	return () => {
		s.listeners.delete(listener);
	};
}
/** Every registered plugin, in registration order (bundled ones first). */
function registeredPlugins() {
	seed();
	return [...store().plugins.values()];
}
function registeredLightningProviders() {
	return registeredPlugins().flatMap((p) => p.lightning ?? []);
}
function registeredOnchainProviders() {
	return registeredPlugins().flatMap((p) => p.onchain ?? []);
}
function registeredIdentityProviders() {
	return registeredPlugins().flatMap((p) => p.identities ?? []);
}
/**
* The plugins compiled into this build register once, when they are first asked for. A broken one is
* reported and skipped rather than taking the app down with it; the e2e that expects it fails instead.
*/
function seed() {
	const s = store();
	if (s.seeded) return;
	s.seeded = true;
	for (const plugin of BUNDLED_PLUGINS) try {
		registerAdapters(plugin);
	} catch (error) {
		console.error(`[ghostly] a bundled adapter plugin was not loaded: ${error instanceof Error ? error.message : String(error)}`);
	}
}
//#endregion
//#region ../browser/src/proofs/ownDid.ts
/**
* The profile's own Ghostly did:dht, which the DID provider refuses as an external identity. The UI and the engine each
* set where to read it. Here, not in the provider, so setting it does not load the providers.
*/
var source = () => void 0;
function setOwnDidSource(read) {
	source = read;
}
var ownDid = () => source();
//#endregion
//#region ../browser/src/proofs/domain.ts
/** Public resolvers that answer RFC 8484 wire-format GETs with CORS (checked 2026-09-23). */
var DOH_RESOLVERS = [
	{
		id: "quad9",
		name: "Quad9",
		url: "https://dns.quad9.net/dns-query"
	},
	{
		id: "cloudflare",
		name: "Cloudflare",
		url: "https://cloudflare-dns.com/dns-query"
	},
	{
		id: "google",
		name: "Google",
		url: "https://dns.google/dns-query"
	}
];
var resolverById = (id) => DOH_RESOLVERS.find((r) => r.id === id) ?? DOH_RESOLVERS.find((r) => r.id === "quad9");
/** The person's resolver choice, per browser profile (UI and engine share the origin). */
var RESOLVER_SETTING = "ghostly-doh-resolver";
function chosenResolver() {
	try {
		return resolverById(globalThis.localStorage?.getItem(RESOLVER_SETTING));
	} catch {
		return resolverById(void 0);
	}
}
var DNS_MAX_BYTES = 16384;
/**
* Lookups are shared between checks for the DNS TTL, capped: never staler than the resolver itself would
* be, so a re-check sees a removal as soon as DNS does. Files have no TTL and are only shared in flight.
*/
var CACHE_MAX_MS = 3e4;
var CACHE_FILE_MS = 0;
/** A check that did not confirm the record, with a message for people. */
var DomainCheckError = class extends Error {};
/** A resolver that gave no DNS answer at all: not reached, or it refused the request. The next one may answer. */
var ResolverUnavailable = class extends DomainCheckError {};
/** One RFC 8484 GET to one resolver. The query has ID 0 and no client subnet, so it carries only the name. */
async function askResolver(resolver, name, type, options) {
	let response;
	try {
		response = await options.fetch(`${resolver.url}?dns=${toBase64Url(encodeDnsQuery(name, type))}`, {
			headers: { accept: "application/dns-message" },
			maxBytes: DNS_MAX_BYTES,
			signal: options.signal,
			redirect: "error"
		});
	} catch (e) {
		throw /too large/i.test(String(e)) ? new DomainCheckError(`${resolver.name} sent an answer that is too large`) : new ResolverUnavailable(`${resolver.name} could not be reached`);
	}
	if (response.status !== 200 || !/^application\/dns-message\b/i.test(response.contentType)) throw new ResolverUnavailable(`${resolver.name} refused the lookup`);
	let answer;
	try {
		answer = decodeDnsResponse(response.bytes, name, type);
	} catch {
		throw new DomainCheckError(`${resolver.name} sent an unusable answer`);
	}
	if (answer.rcode !== 0 && answer.rcode !== 3) throw new DomainCheckError(`${resolver.name} could not resolve ${name}`);
	return answer;
}
/**
* A lookup through the chosen resolver, and through the others in turn (in list order) only when it gives no DNS
* answer at all. Quad9, for one, cannot be read from WebKit (the Mac desktop app, Safari): its HTTP/3 answers carry
* no CORS header. An answer, even "no such name" or a failure, is never asked again elsewhere. `resolver`: who answered.
*/
async function dohQuery(name, type, options) {
	const chosen = resolverById(options.resolver);
	let first;
	for (const resolver of [chosen, ...DOH_RESOLVERS.filter((r) => r !== chosen)]) try {
		return {
			...await askResolver(resolver, name, type, options),
			resolver: resolver.id
		};
	} catch (e) {
		if (!(e instanceof ResolverUnavailable) || options.signal?.aborted) throw e;
		first ??= e;
	}
	throw first;
}
/**
* Refuses a domain whose addresses are not all public before its web server is
* contacted, so a proof cannot make a contact's app probe their own network.
* The browser resolves again when it fetches; a name that changes its answer in
* between (rebinding) is not fully excluded by this check — see the draft.
*/
async function assertPublicHost(domain, options) {
	const [v4, v6] = await Promise.all([dohQuery(domain, "A", options), dohQuery(domain, "AAAA", options)]);
	const addresses = [...v4.answers, ...v6.answers].map((a) => a.data);
	if (!addresses.length) throw new DomainCheckError(`${domain} has no address`);
	if (!addresses.every(isPublicAddress)) throw new DomainCheckError(`${domain} points to a private network address, so it was not contacted`);
}
/** A well-known file: https only, no redirects, bounded. `undefined` when the server says it is not there. */
async function fetchWellKnown(domain, method, options) {
	await assertPublicHost(domain, options);
	const url = wellKnownUrl(domain, method);
	let response;
	try {
		response = await options.fetch(url, {
			headers: { accept: "application/json" },
			maxBytes: DOMAIN_FILE_MAX_BYTES,
			signal: options.signal,
			redirect: "error"
		});
	} catch (e) {
		throw new DomainCheckError(/too large/i.test(String(e)) ? `${url} is too large` : `${domain} could not be reached. The file must be served at exactly this address, without a redirect, with the header Access-Control-Allow-Origin: *`);
	}
	if (response.status === 404 || response.status === 410) return;
	if (response.status >= 300 && response.status < 400) throw new DomainCheckError(`${domain} answered with a redirect; the file must be served at exactly ${url}`);
	if (response.status !== 200) throw new DomainCheckError(`${domain} answered ${response.status}`);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(response.bytes);
	} catch {
		throw new DomainCheckError(`${url} is not text`);
	}
}
async function lookup(domain, method, options) {
	const resolver = resolverById(options.resolver).id;
	if (method === "dns") {
		const answer = await dohQuery(dnsProofName(domain), "TXT", options);
		const values = [];
		for (const record of answer.answers.slice(0, 32)) try {
			values.push(txtValue(record.data));
		} catch {}
		const ttlMs = answer.answers.length ? Math.min(...answer.answers.map((a) => a.ttl)) * 1e3 : 0;
		return {
			domain,
			method,
			resolver: answer.resolver,
			records: recordsFromTxt(values),
			found: answer.answers.length > 0,
			dnssec: answer.authenticated,
			ttlMs
		};
	}
	const text = await fetchWellKnown(domain, method, options);
	const base = {
		domain,
		method,
		resolver,
		dnssec: false,
		records: [],
		ttlMs: CACHE_FILE_MS
	};
	if (text === void 0) return {
		...base,
		found: false
	};
	try {
		return method === "nip05" ? {
			...base,
			found: true,
			nostrKey: nip05RootKey(text)
		} : {
			...base,
			found: true,
			records: recordsFromWellKnown(text)
		};
	} catch {
		throw new DomainCheckError(`${wellKnownUrl(domain, method)} is not a valid ${method === "nip05" ? "NIP-05" : "Ghostly"} file`);
	}
}
var cache = /* @__PURE__ */ new Map();
/** What a domain publishes by one method. Concurrent and back-to-back checks share one lookup. */
async function lookupDomain(domainInput, method, options) {
	const domain = normalizeDomain(domainInput), now = options.now ?? Date.now, resolver = resolverById(options.resolver).id;
	const id = `${resolver}|${method}|${domain}`;
	const hit = cache.get(id);
	if (hit && hit.until > now()) {
		const { ttlMs: _ttl, ...result } = await hit.result;
		return result;
	}
	const started = now();
	const entry = {
		until: started + CACHE_MAX_MS,
		result: lookup(domain, method, {
			...options,
			resolver
		})
	};
	cache.set(id, entry);
	if (cache.size > 128) cache.delete(cache.keys().next().value);
	try {
		const { ttlMs, ...result } = await entry.result;
		entry.until = started + Math.min(CACHE_MAX_MS, ttlMs);
		return result;
	} catch (e) {
		if (cache.get(id) === entry) cache.delete(id);
		throw e;
	}
}
/** Throws unless `domain` publishes `record` by `method` (DNS or HTTPS). Returns what was found. */
async function assertDomainRecord(domain, method, record, options) {
	const found = await lookupDomain(domain, method, options);
	if (recordsName(found.records, record)) return found;
	const where = method === "dns" ? `The TXT record at ${dnsProofName(domain)}` : wellKnownUrl(domain);
	if (found.records.some((r) => r.key === record.key)) throw new DomainCheckError(`${where} is for another proof of this key`);
	if (found.records.length) throw new DomainCheckError(`${where} names another Ghostly key: this proof was replaced or removed`);
	throw new DomainCheckError(method === "dns" ? `No Ghostly TXT record at ${dnsProofName(domain)}${found.found ? "" : " (DNS changes can take a few minutes)"}` : found.found ? `${wellKnownUrl(domain)} names no Ghostly proof` : `${wellKnownUrl(domain)} was not found`);
}
/** Throws unless the domain's NIP-05 root name is `nostrKey`. */
async function assertNip05(domain, nostrKey, options) {
	const found = await lookupDomain(domain, "nip05", options);
	if (found.nostrKey === nostrKey) return found;
	const url = wellKnownUrl(domain, "nip05");
	throw new DomainCheckError(!found.found ? `${url} was not found` : found.nostrKey ? `${url} names another Nostr key for ${domain}` : `${url} has no root name "_" for ${domain}`);
}
//#endregion
//#region ../browser/src/proofs/atproto/resolve.ts
/**
* AT Protocol identity resolution, the network half: a DID to its document (the PLC directory for
* did:plc, the host's `/.well-known/did.json` for did:web), and a handle to a DID (DNS TXT
* `_atproto.<handle>` through the person's DNS-over-HTTPS resolver, then
* `https://<handle>/.well-known/atproto-did`). Every request goes through the contract's bounded
* fetch: HTTPS only, no redirects, a size cap, a time-out. URLs are built here from the DID or the
* handle, never taken from a proof.
*/
var PLC_DIRECTORY = "https://plc.directory";
/** DID documents are small; a large answer is not one. */
var DID_DOCUMENT_MAX_BYTES = 32768;
var HANDLE_DID_MAX_BYTES = 2048;
/**
* The PLC directory. A build made for the e2e suite with VITE_ATPROTO_TEST_PLC may point it at a
* `.test` host (a name reserved for testing); a release build always uses plc.directory.
*/
function plcDirectory() {
	try {
		return PLC_DIRECTORY;
	} catch {
		return PLC_DIRECTORY;
	}
}
/** Where a DID's document lives. */
function didDocumentUrl(did, plc = plcDirectory()) {
	const method = atprotoDidMethod(did);
	if (method === "plc") return `${plc}/${did}`;
	if (method === "web") return `https://${did.slice(8)}/.well-known/did.json`;
	throw new Error("Not an AT Protocol DID");
}
/**
* Refuses a host the account chose (a did:web host, the PDS its document names) that points to a private
* network address: a contact's app never knocks on its own local network for someone else's proof.
*/
async function assertPublicServer(host, options) {
	try {
		await assertPublicHost(host, {
			fetch: options.fetch,
			signal: options.signal,
			resolver: options.resolver
		});
	} catch (e) {
		throw new Error(`The account's server ${host} was not contacted: ${e instanceof Error ? e.message : String(e)}`);
	}
}
/** A DID's document, checked (parseAtprotoDidDocument). Throws a message people can read. */
async function resolveAtprotoDid(did, options) {
	const url = didDocumentUrl(did, options.plc);
	if (atprotoDidMethod(did) === "web") await assertPublicServer(did.slice(8), options);
	let response;
	try {
		response = await options.fetch(url, {
			headers: { accept: "application/did+ld+json, application/json" },
			maxBytes: DID_DOCUMENT_MAX_BYTES,
			signal: options.signal,
			redirect: "error"
		});
	} catch (e) {
		throw new Error(/too large/i.test(String(e)) ? "The account's DID document is too large" : "The account's DID could not be resolved");
	}
	if (response.status === 404 || response.status === 410) throw new Error("The account's DID is not registered, or was deactivated");
	if (response.status !== 200) throw new Error("The account's DID could not be resolved");
	let doc;
	try {
		doc = JSON.parse(response.text);
	} catch {
		throw new Error("The account's DID document is malformed");
	}
	return parseAtprotoDidDocument(doc, did);
}
/**
* The DID a handle points to, or null when it points nowhere (or to two different DIDs). DNS first,
* then HTTPS, as the handle spec says. The HTTPS lookup first checks the handle's addresses are public,
* so a handle cannot make a contact's app knock on its local network.
*/
async function resolveAtprotoHandle(handle, options) {
	const lookup = {
		fetch: options.fetch,
		signal: options.signal,
		resolver: options.resolver
	};
	try {
		const answer = await dohQuery(`_atproto.${handle}`, "TXT", lookup);
		const dids = /* @__PURE__ */ new Set();
		for (const a of answer.answers) {
			if (a.type !== 16) continue;
			let text;
			try {
				text = txtValue(a.data);
			} catch {
				continue;
			}
			if (text.startsWith("did=")) dids.add(text.slice(4));
		}
		if (dids.size > 1) return null;
		const [did] = dids;
		if (did) return isAtprotoDid(did) ? did : null;
	} catch {}
	try {
		await assertPublicHost(handle, lookup);
		const response = await options.fetch(`https://${handle}/.well-known/atproto-did`, {
			headers: { accept: "text/plain" },
			maxBytes: HANDLE_DID_MAX_BYTES,
			signal: options.signal,
			redirect: "error"
		});
		if (response.status !== 200) return null;
		const did = response.text.trim();
		return isAtprotoDid(did) ? did : null;
	} catch {
		return null;
	}
}
/**
* The handle to show for a DID: the one its document claims, and only if that handle resolves back to
* the same DID. Otherwise nothing: the card shows the DID. Never throws.
*/
async function verifiedAtprotoHandle(doc, options) {
	if (!doc.handle) return void 0;
	try {
		return await resolveAtprotoHandle(doc.handle, options) === doc.did ? doc.handle : void 0;
	} catch {
		return;
	}
}
//#endregion
export { reserveAdapterIds as _, DomainCheckError as a, assertPublicHost as c, ownDid as d, setOwnDidSource as f, registeredOnchainProviders as g, registeredLightningProviders as h, verifiedAtprotoHandle as i, chosenResolver as l, registeredIdentityProviders as m, resolveAtprotoDid as n, assertDomainRecord as o, onAdaptersChanged as p, resolveAtprotoHandle as r, assertNip05 as s, assertPublicServer as t, resolverById as u, boundedIdentityFetch as v, verifyIdentity as y };

//# sourceMappingURL=resolve-DjOUKuPc.js.map