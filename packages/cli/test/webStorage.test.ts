import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { quietWebStorage } from "../src/runtime/webStorage";
import { ghostly, ok } from "./support/cli";
// covers: headless.cli

/**
 * Node 25 and newer give every process a `localStorage` getter that warns on stderr when no `--localstorage-file` was
 * given. The engine looks for a localStorage (`globalThis.localStorage?.getItem`), so every command that opens a
 * profile printed that warning. The CLI has no localStorage, as on Node 22: the getter is never reached.
 */
describe("Node's localStorage", () => {
  const warning = () => {
    const scope = {} as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(scope, "localStorage", { get: () => { reads++; return undefined; }, configurable: true, enumerable: false });
    return { scope, reads: () => reads };
  };

  it("without --localstorage-file, the CLI has none and never reads Node's warning getter", () => {
    const { scope, reads } = warning();
    quietWebStorage(scope, [], undefined);
    expect(scope.localStorage).toBeUndefined();
    expect((scope.localStorage as Storage | undefined)?.getItem("x")).toBeUndefined();
    expect(reads()).toBe(0);
  });

  it("with --localstorage-file (on the command line or in NODE_OPTIONS), Node's own stays", () => {
    for (const [argv, options] of [[["--localstorage-file=/x"], undefined], [["--localstorage-file", "/x"], undefined], [[], "--max-old-space-size=99 --localstorage-file=/x"]] as const) {
      const { scope } = warning();
      quietWebStorage(scope, argv, options);
      expect(Object.getOwnPropertyDescriptor(scope, "localStorage")?.get).toBeTypeOf("function");
    }
  });

  it("an older Node, or one without web storage, is left as it is", () => {
    const none = {} as Record<string, unknown>;
    quietWebStorage(none, [], undefined);
    expect("localStorage" in none).toBe(false);
    const plain = { localStorage: "mine" } as Record<string, unknown>;
    quietWebStorage(plain, [], undefined);
    expect(plain.localStorage).toBe("mine");
  });

  it("a command that opens a profile writes nothing on stderr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostly-webstorage-"));
    const status = await ghostly(["--home", dir, "status"]);
    expect(ok(status)).toMatchObject({ mode: "one-shot" });
    expect(status.stderr).toBe("");
  });
});
