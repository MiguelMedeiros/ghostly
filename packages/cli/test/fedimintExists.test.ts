import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeFedimintSdk } from "../src/runtime/fedimint";
// covers: wallet.fedimint.backup

describe("a profile's Fedimint databases on Node", () => {
  it("one is there when its file holds something, not there when it is empty or missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostly-fedimint-exists-"));
    const sdk = await nodeFedimintSdk(dir)();
    expect(await sdk.exists("ghostly-fedimint-missing.db")).toBe(false);
    writeFileSync(join(dir, "ghostly-fedimint-empty.db"), "");
    expect(await sdk.exists("ghostly-fedimint-empty.db")).toBe(false);
    writeFileSync(join(dir, "ghostly-fedimint-full.db"), "x");
    expect(await sdk.exists("ghostly-fedimint-full.db")).toBe(true);
  });

  // Root reads any folder: nothing to refuse it.
  it.skipIf(process.getuid?.() === 0)("a file that could not be looked at is no answer: it throws, never \"not there\"", async () => {
    // A restored federation whose database is not there is joined again, and a failed join removes the database by
    // name: a read error taken for "not there" would remove a funded one.
    const dir = join(mkdtempSync(join(tmpdir(), "ghostly-fedimint-exists-")), "fedimint");
    mkdirSync(dir);
    const sdk = await nodeFedimintSdk(dir)();
    writeFileSync(join(dir, "ghostly-fedimint-full.db"), "x");
    chmodSync(dir, 0o000);
    try {
      await expect(sdk.exists("ghostly-fedimint-full.db")).rejects.toMatchObject({ code: "EACCES" });
    } finally { chmodSync(dir, 0o700); }
  });
});
