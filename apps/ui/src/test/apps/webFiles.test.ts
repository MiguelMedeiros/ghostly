import { afterEach, describe, expect, it } from "vitest";
import { MINI_APP_LIMITS } from "@ghostly/core/miniApp";
import { pickSheetText, webLinkedFiles, type PickSheetText, type PickedFile } from "../../lib/apps/webFiles";
import { translatorFor } from "../../locales";

// covers: apps.linked-files

/**
 * Linked files on the web (WISP 1200 · Linked files): the client asks with its own sheet, keeps links to what the person
 * picked (never copies, per app), and reads them in ranges by the ids it chose.
 */
const text: PickSheetText = {
  ask: (app, folder) => `${app} asks to read ${folder ? "a folder" : "files"}`,
  choose: (folder) => (folder ? "Choose a folder" : "Choose files"),
  note: (app) => `Nothing is copied: ${app} reads what you pick.`,
  cancel: "Cancel",
};
const file = (body: string | Uint8Array, lastModified = 1) => new File([body as BlobPart], "x", { lastModified });
const REF = "pubkeyalpha/cinema";

afterEach(() => { document.body.replaceChildren(); });

describe("picking", () => {
  it("asks with the client's sheet, whose button opens the browser's picker; Cancel picks nothing", async () => {
    const asked: [boolean, string[]][] = [];
    const host = webLinkedFiles({ text: () => text, picker: async (folder, accept) => { asked.push([folder, accept]); return [{ path: "Films/Up.mp4", file: file("abc", 7) }]; } });
    const pick = host.pick(REF, "Cinema", { folder: true, accept: ["mp4"] });
    const sheet = document.querySelector("[data-testid=app-files-sheet]")!;
    expect(sheet.textContent).toContain("Cinema asks to read a folder");
    expect(sheet.textContent).toContain("Nothing is copied: Cinema reads what you pick.");
    expect(asked).toEqual([]);
    (document.querySelector("[data-testid=app-files-choose]") as HTMLButtonElement).click();
    const [entry] = await pick;
    expect(asked).toEqual([[true, ["mp4"]]]);
    expect(entry).toMatchObject({ path: "Films/Up.mp4", size: 3, modified: 7, available: true });
    expect(entry!.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(document.querySelector("[data-testid=app-files-sheet]")).toBeNull();

    const cancelled = host.pick(REF, "Cinema", { folder: false, accept: [] });
    expect(document.querySelector("[data-testid=app-files-sheet]")!.textContent).toContain("Cinema asks to read files");
    (document.querySelector("[data-testid=app-files-cancel]") as HTMLButtonElement).click();
    await expect(cancelled).rejects.toThrow(/^cancelled: /);
  });

  it("the picker closed without a pick is cancelled too", async () => {
    const host = webLinkedFiles({ text: () => text, picker: async () => null });
    const pick = host.pick(REF, "Cinema", { folder: true, accept: [] });
    (document.querySelector("[data-testid=app-files-choose]") as HTMLButtonElement).click();
    await expect(pick).rejects.toThrow(/^cancelled: /);
  });

  it("leaves out hidden files and folders, and what accept does not name", async () => {
    const picked: PickedFile[] = ["Films/Up.mp4", "Films/Up.SRT", "Films/.DS_Store", "Films/.trash/old.mp4", "Films/notes.txt"].map((path) => ({ path, file: file("x") }));
    const host = webLinkedFiles({ text: () => text, ask: async () => picked });
    expect((await host.pick(REF, "Cinema", { folder: true, accept: ["mp4", "srt"] })).map((e) => e.path)).toEqual(["Films/Up.mp4", "Films/Up.SRT"]);
    expect((await host.pick("other/app", "Other", { folder: true, accept: [] })).map((e) => e.path)).toEqual(["Films/Up.mp4", "Films/Up.SRT", "Films/notes.txt"]);
  });

  it("keeps links per app, and never more than the limit", async () => {
    const host = webLinkedFiles({ text: () => text, ask: async () => [{ path: "a.mp4", file: file("a") }] });
    await host.pick(REF, "Cinema", { folder: false, accept: [] });
    expect(await host.list(REF)).toHaveLength(1);
    expect(await host.list("other/app")).toEqual([]);
    const many = webLinkedFiles({ text: () => text, ask: async () => Array.from({ length: MINI_APP_LIMITS.filesEntries + 1 }, (_, i) => ({ path: `${i}.mp4`, file: file("") })) });
    await expect(many.pick(REF, "Cinema", { folder: true, accept: [] })).rejects.toThrow(/^too-large: /);
    expect(await many.list(REF)).toEqual([]);
  });
});

describe("reading and forgetting", () => {
  it("reads a range, fewer bytes at the end, none past it", async () => {
    const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);
    const host = webLinkedFiles({ text: () => text, ask: async () => [{ path: "film.mp4", file: file(bytes) }] });
    const [entry] = await host.pick(REF, "Cinema", { folder: false, accept: [] });
    expect(await host.read(REF, entry!.id, 10, 3)).toEqual(Uint8Array.from([10, 11, 12]));
    expect((await host.read(REF, entry!.id, 98, 50)).length).toBe(2);
    expect((await host.read(REF, entry!.id, 100, 5)).length).toBe(0);
    // Another app cannot read it by its id.
    await expect(host.read("other/app", entry!.id, 0, 1)).rejects.toThrow(/^gone: /);
  });

  it("a file the browser can no longer read is changed, or gone", async () => {
    const broken = (name: string) => ({ size: 10, lastModified: 1, slice: () => ({ arrayBuffer: () => Promise.reject(Object.assign(new Error("x"), { name })) }) }) as unknown as Blob;
    const host = webLinkedFiles({ text: () => text, ask: async () => [{ path: "a.mp4", file: broken("NotReadableError") }, { path: "b.mp4", file: broken("NotFoundError") }] });
    const [a, b] = await host.pick(REF, "Cinema", { folder: false, accept: [] });
    await expect(host.read(REF, a!.id, 0, 1)).rejects.toThrow(/^changed: /);
    await expect(host.read(REF, b!.id, 0, 1)).rejects.toThrow(/^gone: /);
  });

  it("forgets one link, or all of an app's", async () => {
    const host = webLinkedFiles({ text: () => text, ask: async () => [{ path: "a.mp4", file: file("a") }, { path: "b.mp4", file: file("b") }] });
    const [a] = await host.pick(REF, "Cinema", { folder: false, accept: [] });
    await host.forget(REF, a!.id);
    expect((await host.list(REF)).map((e) => e.path)).toEqual(["b.mp4"]);
    await host.forget(REF, "all");
    expect(await host.list(REF)).toEqual([]);
  });
});

describe("the sheet's words", () => {
  it("are the person's language", () => {
    const pt = pickSheetText(translatorFor("pt"));
    expect(pt.ask("Cinema", true)).toBe("Cinema pede para ler uma pasta");
    expect(pt.choose(false)).toBe("Escolher arquivos");
    expect(pt.cancel).toBe("Cancelar");
    expect(pickSheetText(translatorFor("en")).note("Cinema")).toBe("Nothing is copied: Cinema reads what you pick, on this device.");
  });
});
