//#region ../browser/src/engine/paymentAdapters/providers/types.ts
var PROVIDER_PLATFORMS = [
	"web",
	"extension",
	"desktop"
];
var PROVIDER_NETWORKS = [
	"bitcoin",
	"signet",
	"testnet",
	"regtest",
	"mutinynet"
];
var networkMode = (network) => network === "bitcoin" ? "mainnet" : "testnet";
/** A provider can be offered here: it runs on this platform and on a network of this mode. */
var offeredIn = (descriptor, platform, mode) => descriptor.platforms.includes(platform) && descriptor.networks.some((network) => networkMode(network) === mode);
var FIELD_KINDS = [
	"text",
	"url",
	"secret",
	"select",
	"textarea"
];
/** What is stored with the profile and sent on the wire in journals: stable, short, lowercase. */
var PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;
/**
* Problems with a provider descriptor, empty when it is well-formed. The registry refuses a descriptor
* with any; the contract suite checks the same list, so an author sees them before the app does.
*/
function providerDescriptorProblems(d) {
	const problems = [];
	if (!PROVIDER_ID.test(d.id ?? "")) problems.push("id must match ^[a-z][a-z0-9-]{0,31}$");
	if (!d.label?.trim()) problems.push("label is empty");
	if (d.kind !== "lightning" && d.kind !== "onchain") problems.push("kind must be lightning or onchain");
	if (!d.description?.trim()) problems.push("description is empty: say what it is and who holds the money");
	if (!Array.isArray(d.networks) || !d.networks.length) problems.push("no networks");
	else for (const n of d.networks) if (!PROVIDER_NETWORKS.includes(n)) problems.push(`unknown network ${String(n)}`);
	if (!Array.isArray(d.platforms) || !d.platforms.length) problems.push("no platforms");
	else for (const p of d.platforms) if (!PROVIDER_PLATFORMS.includes(p)) problems.push(`unknown platform ${String(p)}`);
	if (!Array.isArray(d.fields)) problems.push("fields must be a list (empty when there is nothing to configure)");
	else {
		const names = d.fields.map((f) => f.name);
		if (new Set(names).size !== names.length) problems.push("field names are not unique");
		for (const f of d.fields) {
			if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(f.name ?? "")) problems.push(`field ${String(f.name)} has an invalid name`);
			if (!f.label?.trim()) problems.push(`field ${f.name} has no label`);
			if (!FIELD_KINDS.includes(f.kind)) problems.push(`field ${f.name} has an unknown kind`);
			if (f.kind === "select" && !f.options?.length) problems.push(`field ${f.name} is a select without options`);
			if (f.suggestions !== void 0 && (!Array.isArray(f.suggestions) || f.suggestions.some((o) => typeof o?.value !== "string" || typeof o?.label !== "string"))) problems.push(`field ${f.name} has malformed suggestions`);
			if (f.changeable && (f.kind === "secret" || f.kind === "select")) problems.push(`field ${f.name} cannot be changeable: only a server address can`);
		}
	}
	if (typeof d.create !== "function") problems.push("create is not a function");
	if (d.validate !== void 0 && typeof d.validate !== "function") problems.push("validate is not a function");
	return problems;
}
/** Only these fields reach the UI, whatever else a provider module keeps on its descriptor. */
var describeProvider = ({ id, label, kind, description, networks, platforms, fields, custodial, experimental }) => ({
	id,
	label,
	kind,
	description,
	networks,
	platforms,
	fields,
	custodial,
	experimental
});
/**
* The provider proved that nothing left the wallet (refused before sending, no route found before any
* HTLC, a transaction that was never broadcast). Safe to try again, with this or another source.
*
* Any other error from a spend means the outcome is UNKNOWN: the payment may be in flight or done. It is
* recorded as such and only reconciled (asked about), never retried. When in doubt, do not throw this.
*/
var NothingSpentError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "NothingSpentError";
	}
};
/**
* The source could not be reached: no answer, a time-out, a refused connection, a server error. The
* engine keeps trying by itself (with backoff) and shows the source as connecting meanwhile.
*/
var SourceUnreachableError = class extends Error {
	constructor(message, cause) {
		super(message);
		this.name = "SourceUnreachableError";
		if (cause !== void 0) Object.assign(this, { cause });
	}
};
/**
* A setting of the source is wrong (a server on another network, a phrase that makes no wallet): trying
* again changes nothing until the setting does. The engine shows it as unavailable at once.
*/
var SourceConfigError = class extends Error {
	constructor(message, cause) {
		super(message);
		this.name = "SourceConfigError";
		if (cause !== void 0) Object.assign(this, { cause });
	}
};
var sourceProblem = (error) => error instanceof Error && error.name === "SourceUnreachableError" ? "unreachable" : error instanceof Error && error.name === "SourceConfigError" ? "config" : "other";
/**
* Whether an error says nothing was spent. By name, not by class: a provider built outside the app (an
* SDK plugin bundled with its own copy of `NothingSpentError`) must be understood the same way.
*/
var isNothingSpentError = (error) => error instanceof NothingSpentError || error instanceof Error && error.name === "NothingSpentError";
/**
* An error message fit to show and store: every secret the source was given is blanked out, in case a
* library echoed a URI or a key back.
*/
function redact(error, secrets = {}) {
	let message = error instanceof Error ? error.message : String(error);
	for (const value of Object.values(secrets)) if (value && value.length >= 4) message = message.split(value).join("•••");
	return message.slice(0, 300);
}
//#endregion
export { describeProvider as a, offeredIn as c, sourceProblem as d, SourceUnreachableError as i, providerDescriptorProblems as l, PROVIDER_PLATFORMS as n, isNothingSpentError as o, SourceConfigError as r, networkMode as s, NothingSpentError as t, redact as u };

//# sourceMappingURL=types-C4_KafL_.js.map