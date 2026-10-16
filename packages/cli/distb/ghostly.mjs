#!/usr/bin/env node
import { enableCompileCache } from "node:module";
//#region src/runtime/webStorage.ts
/**
* Node 25 and newer define `globalThis.localStorage` as a getter that, without `--localstorage-file`, answers
* `undefined` and writes an ExperimentalWarning on stderr the first time it is read. The engine reads it where a
* browser keeps a setting (`globalThis.localStorage?.getItem(...)`), so every command that opens a profile printed the
* warning. Without the flag the CLI has no localStorage, as on Node 22: the getter is replaced by `undefined` before
* anything reads it. With the flag, Node's storage stays.
*/
function quietWebStorage(scope = globalThis, execArgv = process.execArgv, nodeOptions = process.env.NODE_OPTIONS) {
	const own = Object.getOwnPropertyDescriptor(scope, "localStorage");
	if (!own?.get || !own.configurable) return;
	const flag = (arg) => arg === "--localstorage-file" || arg.startsWith("--localstorage-file=");
	if (execArgv.some(flag) || (nodeOptions ?? "").split(/\s+/).some(flag)) return;
	Object.defineProperty(scope, "localStorage", {
		value: void 0,
		writable: true,
		configurable: true,
		enumerable: false
	});
}
//#endregion
//#region src/bin.ts
quietWebStorage();
enableCompileCache();
var { run } = await import("./assets/main-_5fsRch3.js");
run(process.argv.slice(2));
//#endregion
export {};

//# sourceMappingURL=ghostly.mjs.map