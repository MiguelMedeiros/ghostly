/**
 * Node 25 and newer define `globalThis.localStorage` as a getter that, without `--localstorage-file`, answers
 * `undefined` and writes an ExperimentalWarning on stderr the first time it is read. The engine reads it where a
 * browser keeps a setting (`globalThis.localStorage?.getItem(...)`), so every command that opens a profile printed the
 * warning. Without the flag the CLI has no localStorage, as on Node 22: the getter is replaced by `undefined` before
 * anything reads it. With the flag, Node's storage stays.
 */
export function quietWebStorage(scope: object = globalThis, execArgv: readonly string[] = process.execArgv, nodeOptions: string | undefined = process.env.NODE_OPTIONS): void {
  const own = Object.getOwnPropertyDescriptor(scope, "localStorage");
  if (!own?.get || !own.configurable) return;
  const flag = (arg: string) => arg === "--localstorage-file" || arg.startsWith("--localstorage-file=");
  if (execArgv.some(flag) || (nodeOptions ?? "").split(/\s+/).some(flag)) return;
  Object.defineProperty(scope, "localStorage", { value: undefined, writable: true, configurable: true, enumerable: false });
}
