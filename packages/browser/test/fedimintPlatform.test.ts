import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER } from "../src/engine/paymentAdapters/fedimintSdk";
// covers: wallet.fedimint.backup

/** The origin-private file system with one way to answer `getFileHandle`. */
function storage(getFileHandle: (name: string) => Promise<unknown>) {
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getFileHandle }) } });
}
const file = (size: number) => async () => ({ getFile: async () => ({ size }) });

afterEach(() => { vi.unstubAllGlobals(); });

describe("the browser's Fedimint databases", () => {
  it("one is there when its file holds something, not there when it is empty or not found", async () => {
    storage(file(4096));
    expect(await BROWSER.exists("ghostly-fedimint-a.db")).toBe(true);
    storage(file(0));
    expect(await BROWSER.exists("ghostly-fedimint-a.db")).toBe(false);
    storage(async () => { throw new DOMException("no such file", "NotFoundError"); });
    expect(await BROWSER.exists("ghostly-fedimint-a.db")).toBe(false);
  });

  it("a file that could not be looked at is no answer: it throws, never \"not there\"", async () => {
    // A restored federation whose database is not there is joined again, and a failed join removes the database by
    // name: a read error taken for "not there" would remove a funded one.
    storage(async () => { throw new DOMException("could not read it", "NotReadableError"); });
    await expect(BROWSER.exists("ghostly-fedimint-a.db")).rejects.toMatchObject({ name: "NotReadableError" });
    storage(async () => ({ getFile: async () => { throw new DOMException("busy", "InvalidStateError"); } }));
    await expect(BROWSER.exists("ghostly-fedimint-a.db")).rejects.toMatchObject({ name: "InvalidStateError" });
  });
});
