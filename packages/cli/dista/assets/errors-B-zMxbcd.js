//#region src/errors.ts
var EXIT = {
	engine: 1,
	refused: 1,
	unavailable: 1,
	bad_request: 1,
	busy: 1,
	internal: 1,
	usage: 2,
	not_found: 3,
	timeout: 4,
	confirm: 5
};
var CliError = class extends Error {
	code;
	details;
	constructor(code, message, details) {
		super(message);
		this.code = code;
		this.details = details;
		this.name = "CliError";
	}
	toJSON() {
		return {
			code: this.code,
			message: this.message,
			...this.details ? { details: this.details } : {}
		};
	}
};
/** Anything thrown, as the error a bot sees: the engine's own refusals keep their words. */
function asCliError(error) {
	if (error instanceof CliError) return error;
	if (error && typeof error === "object" && "code" in error && "message" in error && typeof error.code === "string" && Object.hasOwn(EXIT, error.code)) return new CliError(error.code, String(error.message));
	if (error instanceof Error && error.code === "unreachable") return new CliError("unavailable", error.message);
	const known = engineKnown(error);
	if (known) return known;
	const local = localFileError(error);
	if (local) return local;
	const unopened = profileOpenError(error);
	if (unopened) return unopened;
	const message = error instanceof Error ? error.message : String(error);
	if (/real money|confirmedReal|Mainnet/i.test(message) && /confirm/i.test(message)) return new CliError("confirm", message);
	if (/other network|cross-network|network does not match/i.test(message)) return new CliError("refused", message);
	return new CliError("engine", message);
}
/**
* The engine's known errors (`EngineError`, packages/core engineErrors.ts) a bot branches on, by their `engineCode`: a
* host or the network not answering is `unavailable` (try again later), one too slow `timeout`, a value the person gave
* `bad_request`, money that is not there `refused`. Any other keeps `engine`. Read by its shape, as `profileOpenError`.
*/
var ENGINE_CODES = {
	mintUnreachable: "unavailable",
	lnurlUnreachable: "unavailable",
	hostUnreachable: "unavailable",
	networkUnreachable: "unavailable",
	usdtRpcUnavailable: "unavailable",
	hostTimedOut: "timeout",
	networkTimedOut: "timeout",
	invalidMintUrl: "bad_request",
	mintNotHttps: "bad_request",
	invalidMaxFee: "bad_request",
	notEnoughSats: "refused",
	ecashAlreadySpent: "refused"
};
function engineKnown(error) {
	if (!(error instanceof Error)) return void 0;
	const { engineCode, values } = error;
	if (typeof engineCode !== "string" || !Object.hasOwn(ENGINE_CODES, engineCode)) return void 0;
	if (engineCode === "lnurlUnreachable" && typeof values?.host === "string") return new CliError("unavailable", `Could not reach ${values.host}`);
	return new CliError(ENGINE_CODES[engineCode], error.message);
}
/**
* The profile's database did not open (the engine's `ProfileOpenError`, packages/browser/src/shared/idb.ts): `engine`
* (exit 1) with the engine's own words, which name the versions when a newer ghostly stored it, and the reason and
* the versions in `details` for a bot. Read by its shape: this module is also the thin client's, which loads no engine.
*/
function profileOpenError(error) {
	if (!(error instanceof Error) || error.name !== "ProfileOpenError") return void 0;
	const failure = error.failure;
	if (!failure || typeof failure.reason !== "string") return void 0;
	return new CliError("engine", error.message, {
		reason: failure.reason === "newer" ? "newer_profile" : `profile_${failure.reason}`,
		...typeof failure.storedVersion === "number" ? { storedVersion: failure.storedVersion } : {},
		...typeof failure.supportedVersion === "number" ? { supportedVersion: failure.supportedVersion } : {}
	});
}
/**
* A file or folder on this machine the command could not open (`file save --dir`, `profile backup --out`): the
* person's path, not the engine refusing, so it says so with the code a bot branches on. Before, a folder that did
* not exist was `engine` (exit 1) with Node's `ENOENT: no such file or directory, open '…'`. `file`: the path read, for
* an error that names none (a folder read as a file).
*/
function localFileError(error, file) {
	if (!error || typeof error !== "object" || typeof error.syscall !== "string") return void 0;
	const { code, path } = error;
	const where = typeof path === "string" ? path : file ?? "the path";
	if (code === "ENOENT" || code === "ENOTDIR") return new CliError("not_found", `No such file or folder: ${where}`);
	if (code === "EACCES" || code === "EPERM" || code === "EROFS") return new CliError("refused", `Not allowed to write or read ${where}`);
	if (code === "EISDIR") return new CliError("bad_request", `${where} is a folder: name a file`);
	if (code === "ENAMETOOLONG") return new CliError("bad_request", `A name in ${where} is too long for this file system (at most 255 bytes)`);
}
//#endregion
export { localFileError as i, EXIT as n, asCliError as r, CliError as t };

//# sourceMappingURL=errors-B-zMxbcd.js.map