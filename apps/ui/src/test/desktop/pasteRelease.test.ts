import { afterEach, describe, expect, it, vi } from "vitest";

// covers: app.composer.paste-files

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  listen: async () => () => {},
  getIdentifier: async () => "tools.ghostly.app",
  convertFileSrc: (path: string) => path,
  Channel: class {},
}));
// The options the host is made with, as they are.
vi.mock("@ghostly/browser/inPageHost", () => ({ createInPageHost: (options: unknown) => options }));

import { invoke } from "@tauri-apps/api/core";
import type { ClipboardFile } from "@ghostly/browser/host";
import { createDesktopHost } from "../../desktop/host";
import { PLATFORM_PASTE_MAX, readPlatformFiles } from "../../lib/pastedFiles";

/*
 * A paste the Desktop app reads itself (apps/desktop/src/clipboard.rs) keeps its bytes in Rust, read by token. Once
 * the page has them in a File of its own (or gave up on them), it says so, and Rust lets them go: a pasted picture's
 * PNG does not stay in the app's memory for as long as it runs.
 */

type Held = { token: string; name: string | null; size: number; mime: string | null };
const called = vi.mocked(invoke) as unknown as ReturnType<typeof vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>>;
const read = () => (createDesktopHost("1.2.0") as unknown as { readClipboardFiles(): Promise<ClipboardFile[]> }).readClipboardFiles();
/** The tokens the page said it is done with, in the order it said so. */
const released = () => called.mock.calls.filter(([command]) => command === "incoming_share_done").flatMap(([, args]) => args!.tokens as string[]);

/** Rust's side of a paste: what it holds by token, and what was read of it when. */
function shelf(held: Held[], bytes: Record<string, number[]>, fail?: string) {
  const order: string[] = [];
  called.mockImplementation(async (command, args) => {
    if (command === "read_clipboard_files") return held;
    if (command === "read_pasted_bytes") {
      const { token, offset, length } = args as { token: string; offset: number; length: number };
      order.push(`read ${token}`);
      if (token === fail) throw new Error("That paste is gone. Paste it again.");
      return bytes[token].slice(offset, offset + length);
    }
    if (command === "incoming_share_done") order.push(...(args!.tokens as string[]).map((token) => `done ${token}`));
    return undefined;
  });
  return order;
}

afterEach(() => { called.mockReset(); called.mockImplementation(async () => undefined); });

describe("a paste the Desktop app read lets go of its bytes in Rust", () => {
  it("once the page has every file, each token is released, after its last read", async () => {
    const order = shelf(
      [{ token: "picture", name: null, size: 4, mime: "image/png" }, { token: "scan", name: "scan.pdf", size: 2, mime: null }],
      { picture: [137, 80, 78, 71], scan: [37, 80] },
    );
    const files = await readPlatformFiles(await read());
    expect(files.map((file) => [file.type, file.size])).toEqual([["image/png", 4], ["application/pdf", 2]]);
    expect([...new Uint8Array(await files[0].arrayBuffer())]).toEqual([137, 80, 78, 71]);
    expect([...released()].sort()).toEqual(["picture", "scan"]);
    expect(order.indexOf("done picture")).toBeGreaterThan(order.lastIndexOf("read picture"));
    expect(order.indexOf("done scan")).toBeGreaterThan(order.lastIndexOf("read scan"));
  });

  it("a read that fails releases every token of the paste, the ones never read too", async () => {
    shelf(
      [{ token: "picture", name: null, size: 4, mime: "image/png" }, { token: "scan", name: "scan.pdf", size: 2, mime: null }],
      { picture: [137, 80, 78, 71], scan: [37, 80] },
      "picture",
    );
    await expect(readPlatformFiles(await read())).rejects.toThrow("That paste is gone. Paste it again.");
    expect([...released()].sort()).toEqual(["picture", "scan"]);
  });

  it("a paste too large to bring into the page is released unread", async () => {
    shelf([{ token: "film", name: "film.mkv", size: PLATFORM_PASTE_MAX + 1, mime: null }], {});
    await expect(readPlatformFiles(await read())).rejects.toThrow("That is too large to paste. Send it with + → Document.");
    expect(released()).toEqual(["film"]);
    expect(called).not.toHaveBeenCalledWith("read_pasted_bytes", expect.anything());
  });

  it("a paste whose files are too large together is released unread, each of them under the limit or not", async () => {
    const third = Math.ceil(PLATFORM_PASTE_MAX / 3) + 1;
    shelf(["a", "b", "c"].map((token) => ({ token, name: `${token}.mkv`, size: third, mime: null })), {});
    await expect(readPlatformFiles(await read(), new Date(), true)).rejects.toThrow("That is too large to paste. Send it with + → Document.");
    expect([...released()].sort()).toEqual(["a", "b", "c"]);
    expect(called).not.toHaveBeenCalledWith("read_pasted_bytes", expect.anything());
  });

  it("files that fit together are read, up to the limit itself", async () => {
    // Sizes as Rust says them; the bytes here are a few, which is all a read hands back.
    shelf(
      [{ token: "a", name: "a.bin", size: PLATFORM_PASTE_MAX - 2, mime: null }, { token: "b", name: "b.bin", size: 2, mime: null }],
      { a: [], b: [1, 2] },
    );
    expect((await readPlatformFiles(await read(), new Date(), true)).map((file) => file.name)).toEqual(["a.bin", "b.bin"]);
  });

  it("a release Rust refuses does not fail the paste", async () => {
    shelf([{ token: "picture", name: null, size: 2, mime: "image/png" }], { picture: [1, 2] });
    const answer = called.getMockImplementation()!;
    called.mockImplementation(async (command, args) => {
      if (command === "incoming_share_done") throw new Error("Not allowed from this window");
      return answer(command, args);
    });
    expect((await readPlatformFiles(await read())).map((file) => file.size)).toEqual([2]);
  });
});
