import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { installFileFetch } from "../src/runtime/fileFetch";
// covers: headless.engine-passthrough

/** `fetch` of `file:` URLs, for the wallet SDKs' WebAssembly: a `.wasm` file and nothing else. */
const dir = mkdtempSync(join(tmpdir(), "gh-fetch-"));
const original = globalThis.fetch;
afterAll(() => { globalThis.fetch = original; rmSync(dir, { recursive: true, force: true }); });

describe("file: fetch", () => {
  it("reads a .wasm file, and refuses any other file, a query or a fragment dressed as one", async () => {
    installFileFetch();
    writeFileSync(join(dir, "m.wasm"), "wasm");
    writeFileSync(join(dir, "secret.txt"), "secret");
    const wasm = pathToFileURL(join(dir, "m.wasm")).href;
    const secret = pathToFileURL(join(dir, "secret.txt")).href;
    expect(await (await fetch(wasm)).text()).toBe("wasm");
    await expect(fetch(secret)).rejects.toThrow(/Refusing/);
    await expect(fetch(`${secret}?.wasm`)).rejects.toThrow(/Refusing/);
    await expect(fetch(`${secret}#.wasm`)).rejects.toThrow(/Refusing/);
  });
});
