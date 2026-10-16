//#region ../browser/src/engine/joinTrace.ts
var sink = null;
/** Where the lines go besides the console; `null` removes it. */
function setJoinTraceSink(next) {
	sink = next;
}
function traceJoin(group, step, detail) {
	const console_ = globalThis.__ghostlyJoinTrace;
	if (!console_ && !sink) return;
	const line = JSON.stringify({
		t: Date.now(),
		g: group,
		step,
		...detail
	});
	if (console_) console.debug(`[ghostly:join] ${line}`);
	try {
		sink?.(line);
	} catch {}
}
//#endregion
export { traceJoin as n, setJoinTraceSink as t };

//# sourceMappingURL=joinTrace-CjRDFy85.js.map