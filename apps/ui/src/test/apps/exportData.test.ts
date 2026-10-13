import { describe, expect, it, vi } from "vitest";
import type { AppDataExport } from "@ghostly/browser/engine/apps";
import { saveAppData } from "../../lib/apps/exportData";

// covers: apps.engine.storage

const saved: { blob: Blob; name: string }[] = [];
vi.mock("../../lib/fileDownload", () => ({
  saveMade: async (_platform: unknown, blob: Blob, name: string) => { saved.push({ blob, name }); return "downloaded"; },
}));

const REF = `${"k".repeat(52)}/chess`;

/** A value as deep as the broker takes (64), around a list of small numbers: about 40 KiB as JSON. */
const nested = () => {
  let value: unknown = Array.from({ length: 20_000 }, (_, i) => i % 10);
  for (let depth = 0; depth < 60; depth++) value = [value];
  return value as AppDataExport["entries"][string];
};

describe("the export offered before an uninstall", () => {
  it("is every scope's data as JSON, one entry a line, never more than a little over its size", async () => {
    saved.length = 0;
    const exports: AppDataExport[] = [
      { ghostlyAppData: 1, app: REF, scope: "alone", entries: { b: { c: true } } },
      { ghostlyAppData: 1, app: REF, scope: "chat-1", entries: Object.defineProperty({ a: [1, 2], "x\"y": "z" }, "__proto__", { value: 7, enumerable: true }) },
    ];
    await saveAppData(REF, exports);
    expect(saved.map((s) => s.name)).toEqual(["chess-data.json"]);
    const text = await saved[0]!.blob.text();
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(exports)));
    expect(Object.keys((JSON.parse(text) as AppDataExport[])[1]!.entries)).toEqual(["a", "x\"y", "__proto__"]);
    expect(text.split("\n")).toContain("\"a\":[1,2],");
  });

  it("takes data in two chats nested as deep as the broker allows: indented, it passed the longest string the page can make", async () => {
    // 85 values a chat of about 40 KiB: within the 5 MiB a chat counts. Indented 60 deep, each number takes its own
    // line of 120 spaces: 69 times the data, a RangeError at two chats, and Uninstall the only way left.
    saved.length = 0;
    const entries = () => Object.fromEntries(Array.from({ length: 85 }, (_, i) => [`k${i}`, nested()]));
    const exports: AppDataExport[] = [
      { ghostlyAppData: 1, app: REF, scope: "chat-1", entries: entries() },
      { ghostlyAppData: 1, app: REF, scope: "chat-2", entries: entries() },
    ];
    const compact = JSON.stringify(exports).length;
    await saveAppData(REF, exports);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.blob.size).toBeLessThan(compact * 1.01);
    const back = JSON.parse(await saved[0]!.blob.text()) as AppDataExport[];
    expect(back.map((file) => [file.scope, Object.keys(file.entries).length])).toEqual([["chat-1", 85], ["chat-2", 85]]);
  });

  it("saves nothing for an app that kept nothing", async () => {
    saved.length = 0;
    await saveAppData(REF, []);
    expect(saved).toEqual([]);
  });
});
