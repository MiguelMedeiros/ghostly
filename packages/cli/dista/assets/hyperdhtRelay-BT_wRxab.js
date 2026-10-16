//#region ../browser/src/shared/hyperdhtRelay.ts
/** Only `wss://`, or `ws://` to this machine (a relay for tests or development). */
function hyperdhtRelayProblem(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return "Enter a relay address (wss://…)";
	}
	if (parsed.protocol === "wss:") return null;
	if (parsed.protocol === "ws:" && [
		"127.0.0.1",
		"localhost",
		"[::1]"
	].includes(parsed.hostname)) return null;
	return "Use a wss:// relay address";
}
//#endregion
export { hyperdhtRelayProblem as t };

//# sourceMappingURL=hyperdhtRelay-BT_wRxab.js.map