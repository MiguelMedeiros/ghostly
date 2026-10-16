import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MINI_APP_LIMITS } from "@ghostly/core/miniApp";
import { handlePicker, idbPickStore, pickSheetText, webLinkedFiles, type PickSheetText, type PickStore, type PickedFile, type StoredPick } from "../../lib/apps/webFiles";
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
  askAgain: (app, name, more) => `${app} asks to read “${name}”${more ? ` and ${more} more` : ""} again`,
  allow: "Allow",
  notNow: "Not now",
};
const file = (body: string | Uint8Array, lastModified = 1) => new File([body as BlobPart], "x", { lastModified });
const REF = "pubkeyalpha/cinema";
/** An element of the client's sheet, once it shows (a pick reads the kept ones first). */
const shown = (selector: string) => vi.waitFor(() => {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`no ${selector}`);
  return element;
});

afterEach(() => { document.body.replaceChildren(); });

describe("picking", () => {
  it("asks with the client's sheet, whose button opens the browser's picker; Cancel picks nothing", async () => {
    const asked: [boolean, string[]][] = [];
    const host = webLinkedFiles({ text: () => text, picker: async (folder, accept) => { asked.push([folder, accept]); return { files: [{ path: "Films/Up.mp4", file: file("abc", 7) }] }; } });
    const pick = host.pick(REF, "Cinema", { folder: true, accept: ["mp4"] });
    const sheet = await shown("[data-testid=app-files-sheet]");
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
    expect((await shown("[data-testid=app-files-sheet]")).textContent).toContain("Cinema asks to read files");
    (document.querySelector("[data-testid=app-files-cancel]") as HTMLButtonElement).click();
    await expect(cancelled).rejects.toThrow(/^cancelled: /);
  });

  it("a long app title with no space breaks inside the sheet, in its title and its note", async () => {
    const pick = webLinkedFiles({ text: () => text, picker: async () => null }).pick(REF, "ReaderForVeryLongFolderNamesAndFilesXYZ", { folder: true, accept: [] });
    const sheet = await shown("[data-testid=app-files-sheet]");
    expect(sheet.querySelector("h2")!.className).toContain("[overflow-wrap:anywhere]");
    expect(sheet.querySelector("p")!.className).toContain("[overflow-wrap:anywhere]");
    (sheet.querySelector("[data-testid=app-files-cancel]") as HTMLButtonElement).click();
    await expect(pick).rejects.toThrow(/^cancelled: /);
  });

  it("the picker closed without a pick is cancelled too", async () => {
    const host = webLinkedFiles({ text: () => text, picker: async () => null });
    const pick = host.pick(REF, "Cinema", { folder: true, accept: [] });
    (await shown("[data-testid=app-files-choose]")).click();
    await expect(pick).rejects.toThrow(/^cancelled: /);
  });

  it("leaves out hidden files and folders, and what accept does not name", async () => {
    const picked: PickedFile[] = ["Films/Up.mp4", "Films/Up.SRT", "Films/.DS_Store", "Films/.trash/old.mp4", "Films/notes.txt"].map((path) => ({ path, file: file("x") }));
    const host = webLinkedFiles({ text: () => text, ask: async () => ({ files: picked }) });
    expect((await host.pick(REF, "Cinema", { folder: true, accept: ["mp4", "srt"] })).map((e) => e.path)).toEqual(["Films/Up.mp4", "Films/Up.SRT"]);
    expect((await host.pick("other/app", "Other", { folder: true, accept: [] })).map((e) => e.path)).toEqual(["Films/Up.mp4", "Films/Up.SRT", "Films/notes.txt"]);
  });

  it("keeps links per app, and never more than the limit", async () => {
    const host = webLinkedFiles({ text: () => text, ask: async () => ({ files: [{ path: "a.mp4", file: file("a") }] }) });
    await host.pick(REF, "Cinema", { folder: false, accept: [] });
    expect(await host.list(REF, "Cinema")).toHaveLength(1);
    expect(await host.list("other/app", "Other")).toEqual([]);
    const many = webLinkedFiles({ text: () => text, ask: async () => ({ files: Array.from({ length: MINI_APP_LIMITS.filesEntries + 1 }, (_, i) => ({ path: `${i}.mp4`, file: file("") })) }) });
    await expect(many.pick(REF, "Cinema", { folder: true, accept: [] })).rejects.toThrow(/^too-large: /);
    expect(await many.list(REF, "Cinema")).toEqual([]);
  });
});

describe("reading and forgetting", () => {
  it("reads a range, fewer bytes at the end, none past it", async () => {
    const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);
    const host = webLinkedFiles({ text: () => text, ask: async () => ({ files: [{ path: "film.mp4", file: file(bytes) }] }) });
    const [entry] = await host.pick(REF, "Cinema", { folder: false, accept: [] });
    expect(await host.read(REF, entry!.id, 10, 3)).toEqual(Uint8Array.from([10, 11, 12]));
    expect((await host.read(REF, entry!.id, 98, 50)).length).toBe(2);
    expect((await host.read(REF, entry!.id, 100, 5)).length).toBe(0);
    // Another app cannot read it by its id.
    await expect(host.read("other/app", entry!.id, 0, 1)).rejects.toThrow(/^gone: /);
  });

  it("a file the browser can no longer read is changed, or gone", async () => {
    const broken = (name: string) => ({ size: 10, lastModified: 1, slice: () => ({ arrayBuffer: () => Promise.reject(Object.assign(new Error("x"), { name })) }) }) as unknown as Blob;
    const host = webLinkedFiles({ text: () => text, ask: async () => ({ files: [{ path: "a.mp4", file: broken("NotReadableError") }, { path: "b.mp4", file: broken("NotFoundError") }] }) });
    const [a, b] = await host.pick(REF, "Cinema", { folder: false, accept: [] });
    await expect(host.read(REF, a!.id, 0, 1)).rejects.toThrow(/^changed: /);
    await expect(host.read(REF, b!.id, 0, 1)).rejects.toThrow(/^gone: /);
  });

  it("forgets one link, or all of an app's", async () => {
    const host = webLinkedFiles({ text: () => text, ask: async () => ({ files: [{ path: "a.mp4", file: file("a") }, { path: "b.mp4", file: file("b") }] }) });
    const [a] = await host.pick(REF, "Cinema", { folder: false, accept: [] });
    await host.forget(REF, a!.id);
    expect((await host.list(REF, "Cinema")).map((e) => e.path)).toEqual(["b.mp4"]);
    await host.forget(REF, "all");
    expect(await host.list(REF, "Cinema")).toEqual([]);
  });
});

describe("the sheet's words", () => {
  it("are the person's language", () => {
    const pt = pickSheetText(translatorFor("pt"));
    expect(pt.ask("Cinema", true)).toBe("Cinema pede para ler uma pasta");
    expect(pt.choose(false)).toBe("Escolher arquivos");
    expect(pt.cancel).toBe("Cancelar");
    expect(pickSheetText(translatorFor("en")).note("Cinema")).toBe("Nothing is copied: Cinema reads what you pick, on this device.");
    expect(pt.askAgain("Cinema", "Filmes", 0)).toBe("Cinema pede para ler “Filmes” de novo");
    expect(pt.askAgain("Cinema", "Filmes", 23)).toBe("Cinema pede para ler “Filmes” e mais 23 de novo");
    expect(pickSheetText(translatorFor("en")).askAgain("Cinema", "Films", 1)).toBe("Cinema asks to read “Films” and 1 more again");
  });
});

/** A folder as the File System Access API hands it over: names, files, and what the browser lets the page do now. */
function fakeDir(name: string, tree: Record<string, string | Record<string, string>>, state: { permission: PermissionState; asked: number; gets?: string[] }): FileSystemDirectoryHandle {
  const node = (n: string, value: string | Record<string, string>): FileSystemHandle =>
    typeof value === "string" ? ({ kind: "file", name: n, getFile: async () => { state.gets?.push(n); return new File([value], n, { lastModified: 9 }); } } as unknown as FileSystemHandle) : fakeDir(n, value, state);
  const children = Object.entries(tree).map(([n, v]) => node(n, v));
  return {
    kind: "directory",
    name,
    async *values() { yield* children; },
    getDirectoryHandle: async (n: string) => { const c = children.find((x) => x.name === n && x.kind === "directory"); if (!c) throw Object.assign(new Error(n), { name: "NotFoundError" }); return c; },
    getFileHandle: async (n: string) => { const c = children.find((x) => x.name === n && x.kind === "file"); if (!c) throw Object.assign(new Error(n), { name: "NotFoundError" }); return c; },
    queryPermission: async () => state.permission,
    requestPermission: async () => { state.asked++; state.permission = "granted"; return "granted"; },
  } as unknown as FileSystemDirectoryHandle;
}

function memoryStore(): PickStore & { picks: Map<string, StoredPick> } {
  const picks = new Map<string, StoredPick>();
  const forgotten = new Set<string>();
  return {
    picks,
    all: async (ref) => [...picks.values()].filter((p) => p.ref === ref).map((p) => ({ ...p, entries: p.entries.filter((e) => !forgotten.has(e.id)) })),
    put: async (pick) => { picks.set(`${pick.ref} ${pick.id}`, pick); },
    forget: async (_ref, _id, entry) => { forgotten.add(entry); },
    remove: async (ref, id) => { picks.delete(`${ref} ${id}`); },
    clear: async (ref) => { for (const [k, p] of picks) if (p.ref === ref) picks.delete(k); },
  };
}

describe("a folder kept past the page (File System Access)", () => {
  const tree = { "Up.mp4": "0123456789", ".hidden.mp4": "x", Season: { "E01.mp4": "abc" } };

  async function pickedOnce() {
    const state = { permission: "granted" as PermissionState, asked: 0 };
    const dir = fakeDir("Films", tree, state);
    const store = memoryStore();
    const first = webLinkedFiles({ text: () => text, store, ask: async () => ({ files: [{ path: "Films/Up.mp4", file: await (await dir.getFileHandle("Up.mp4")).getFile() }, { path: "Films/Season/E01.mp4", file: new File(["abc"], "E01.mp4", { lastModified: 9 }) }], keep: { dir } }) });
    const entries = await first.pick(REF, "Cinema", { folder: true, accept: [] });
    return { state, store, entries };
  }

  it("is kept in the store, and read on the next page through the folder's handle, once the person allows it again", async () => {
    const { state, store, entries } = await pickedOnce();
    expect(store.picks.size).toBe(1);
    // The next page: the browser asks again.
    state.permission = "prompt";
    let askedWith: [string, string] | null = null;
    const next = webLinkedFiles({ text: () => text, store, askAgain: async (app, name, _more, grant) => { askedWith = [app, name]; return grant(); } });
    await expect(next.read(REF, entries[0]!.id, 0, 4)).rejects.toThrow(/^gone: /);
    const listed = await next.list(REF, "Cinema");
    expect(askedWith).toEqual(["Cinema", "Films"]);
    expect(state.asked).toBe(1);
    expect(listed.map((e) => [e.path, e.available])).toEqual([["Films/Up.mp4", true], ["Films/Season/E01.mp4", true]]);
    expect(await next.read(REF, entries[0]!.id, 2, 3)).toEqual(new TextEncoder().encode("234"));
    expect(await next.read(REF, entries[1]!.id, 0, 10)).toEqual(new TextEncoder().encode("abc"));
    // Asked once a page.
    await next.list(REF, "Cinema");
    expect(state.asked).toBe(1);
  });

  it("Not now leaves the links unavailable, and the person is not asked again on that page", async () => {
    const { state, store } = await pickedOnce();
    state.permission = "prompt";
    let asked = 0;
    const next = webLinkedFiles({ text: () => text, store, askAgain: async () => { asked++; return false; } });
    expect((await next.list(REF, "Cinema")).every((e) => !e.available)).toBe(true);
    await next.list(REF, "Cinema");
    expect(asked).toBe(1);
  });

  it("asking again names one kept item and how many more, never every name", async () => {
    const state = { permission: "prompt" as PermissionState, asked: 0 };
    const handle = (name: string) => ({ kind: "file", name, getFile: async () => new File(["x"], name, { lastModified: 9 }), queryPermission: async () => state.permission, requestPermission: async () => state.permission }) as unknown as FileSystemFileHandle;
    const names = Array.from({ length: 24 }, (_, i) => `holiday-video-2026-10-${String(i + 1).padStart(2, "0")}-camera-backup.mp4`);
    const store = memoryStore();
    const entry = (path: string, at?: number) => ({ id: path, path, size: 1, modified: 9, ...(at !== undefined && { at }) });
    await store.put({ ref: REF, id: "files", keep: { files: names.map(handle) }, entries: names.map((n, at) => entry(n, at)) });
    let askedWith: [string, string, number] | null = null;
    await webLinkedFiles({ text: () => text, store, askAgain: async (app, name, more) => { askedWith = [app, name, more]; return false; } }).list(REF, "Reader");
    expect(askedWith).toEqual(["Reader", names[0], 23]);
    // A folder is one item, whatever it holds.
    await store.put({ ref: REF, id: "folder", keep: { dir: fakeDir("Films", {}, state) }, entries: [entry("Films/a.mp4"), entry("Films/b.mp4")] });
    await webLinkedFiles({ text: () => text, store, askAgain: async (app, name, more) => { askedWith = [app, name, more]; return false; } }).list(REF, "Reader");
    expect(askedWith).toEqual(["Reader", names[0], 24]);
  });

  it("the sheet asking again keeps its buttons in the window: a box no taller than it, with its own scroll", async () => {
    const state = { permission: "prompt" as PermissionState, asked: 0 };
    const store = memoryStore();
    const long = `${"holiday-video-camera-backup-".repeat(12)}.mp4`;
    await store.put({ ref: REF, id: "folder", keep: { dir: fakeDir(long, {}, state) }, entries: [{ id: "e", path: `${long}/a.mp4`, size: 1, modified: 9 }] });
    const listed = webLinkedFiles({ text: () => text, store }).list(REF, "Reader");
    const sheet = await shown("[data-testid=app-files-again]");
    const box = sheet.querySelector<HTMLElement>("[role=dialog]")!;
    expect(box.className).toMatch(/(^| )max-h-\[\d+dvh\]( |$)/);
    expect(box.className).toMatch(/(^| )overflow-y-auto( |$)/);
    // A name with no space breaks anywhere rather than running past the box.
    expect(box.querySelector("h2")!.className).toContain("[overflow-wrap:anywhere]");
    (sheet.querySelector("[data-testid=app-files-cancel]") as HTMLButtonElement).click();
    await listed;
  });

  it("a file that changed since it was picked reads as changed, one that went as gone", async () => {
    const { store, entries } = await pickedOnce();
    const state = { permission: "granted" as PermissionState, asked: 0 };
    store.picks.forEach((p) => { p.keep = { dir: fakeDir("Films", { "Up.mp4": "01234567890" }, state) }; });
    const next = webLinkedFiles({ text: () => text, store });
    await expect(next.read(REF, entries[0]!.id, 0, 1)).rejects.toThrow(/^changed: /);
    await expect(next.read(REF, entries[1]!.id, 0, 1)).rejects.toThrow(/^gone: /);
  });

  it("forgetting the last link of a pick drops it from the store; all drops the app's", async () => {
    const { store, entries } = await pickedOnce();
    const next = webLinkedFiles({ text: () => text, store });
    await next.forget(REF, entries[0]!.id);
    expect((await store.all(REF))[0]!.entries.map((e) => e.path)).toEqual(["Films/Season/E01.mp4"]);
    await next.forget(REF, entries[1]!.id);
    expect(store.picks.size).toBe(0);
    const again = await pickedOnce();
    await webLinkedFiles({ text: () => text, store: again.store }).forget(REF, "all");
    expect(again.store.picks.size).toBe(0);
  });

  it("holds no file of a kept folder: the walk keeps each one's size and date, and a read gets it again by the handle", async () => {
    const state = { permission: "granted" as PermissionState, asked: 0, gets: [] as string[] };
    const names = Array.from({ length: 6 }, (_, i) => `${i}.mp4`);
    const dir = fakeDir("Films", Object.fromEntries(names.map((n) => [n, n])), state);
    vi.stubGlobal("showDirectoryPicker", async () => dir);
    try {
      const picked = (await handlePicker(true, []))!;
      // A browser File per picked file held ~6 KB each in the browser process for the page's life (620 MiB for 100,000).
      expect(picked.files.map(({ path, file }) => [path, file instanceof Blob, file.size, file.lastModified])).toEqual(names.map((n) => [`Films/${n}`, false, 5, 9]));
      const host = webLinkedFiles({ text: () => text, store: memoryStore(), ask: async () => picked });
      const entries = await host.pick(REF, "Cinema", { folder: true, accept: [] });
      state.gets.length = 0;
      expect(await host.read(REF, entries[0]!.id, 0, 1)).toEqual(new TextEncoder().encode("0"));
      expect(await host.read(REF, entries[0]!.id, 1, 1)).toEqual(new TextEncoder().encode("."));
      // A file being read is got once, not once a range; a few are kept, the oldest let go.
      expect(state.gets).toEqual(["0.mp4"]);
      for (const entry of entries.slice(1)) await host.read(REF, entry.id, 0, 1);
      await host.read(REF, entries[0]!.id, 0, 1);
      expect(state.gets).toEqual([...names, "0.mp4"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the IndexedDB store keeps picks per app", async () => {
    const store = idbPickStore(() => "ghostly-test-files");
    const pick = (ref: string, id: string): StoredPick => ({ ref, id, keep: { files: [] }, entries: [{ id: `${id}e`, path: "a.mp4", size: 1, modified: 1 }] });
    await store.put(pick(REF, "p1"));
    await store.put(pick("other/app", "p2"));
    expect((await store.all(REF)).map((p) => p.id)).toEqual(["p1"]);
    await store.remove(REF, "p1");
    expect(await store.all(REF)).toEqual([]);
    await store.clear("other/app");
    expect(await store.all("other/app")).toEqual([]);
  });

  it("a forget writes the entry alone, never the whole pick again, and holds on the next page", async () => {
    const idb = idbPickStore(() => "ghostly-test-files-forget");
    const written: number[] = [];
    let forgets = 0;
    const store: PickStore = { ...idb, put: async (pick) => { written.push(pick.entries.length); await idb.put(pick); }, forget: async (...args) => { forgets++; await idb.forget(...args); } };
    const files = Array.from({ length: 1_000 }, (_, i) => ({ path: `Films/${i}.mp4`, file: file("x") }));
    const host = webLinkedFiles({ text: () => text, store, ask: async () => ({ files, keep: { dir: { name: "Films" } as FileSystemDirectoryHandle } }) });
    const entries = await host.pick(REF, "Cinema", { folder: true, accept: [] });
    for (const entry of entries.slice(0, 10)) await host.forget(REF, entry.id);
    // The pick was written once, at the pick: before, each forget wrote its other 999 entries again.
    expect(written).toEqual([1_000]);
    expect(forgets).toBe(10);
    const next = webLinkedFiles({ text: () => text, store: idb, askAgain: async () => false });
    const listed = await next.list(REF, "Cinema");
    expect(listed).toHaveLength(990);
    expect(listed.map((e) => e.id)).toEqual(entries.slice(10).map((e) => e.id));
  });

  it("the IndexedDB store drops a pick's forgotten entries with it, and reads a database from before them", async () => {
    // A profile's database as the first version wrote it: picks only.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("ghostly-test-files-v1", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("picks", { keyPath: "key" }).put({ key: `${REF} p1`, ref: REF, id: "p1", keep: { files: [] }, entries: [{ id: "e1", path: "a.mp4", size: 1, modified: 1 }, { id: "e2", path: "b.mp4", size: 1, modified: 1 }] });
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    const store = idbPickStore(() => "ghostly-test-files-v1");
    await store.forget(REF, "p1", "e1");
    expect((await store.all(REF))[0]!.entries.map((e) => e.id)).toEqual(["e2"]);
    await store.remove(REF, "p1");
    // A pick under the same id later does not inherit what the old one forgot.
    await store.put({ ref: REF, id: "p1", keep: { files: [] }, entries: [{ id: "e1", path: "a.mp4", size: 1, modified: 1 }] });
    expect((await store.all(REF))[0]!.entries.map((e) => e.id)).toEqual(["e1"]);
    await store.forget(REF, "p1", "e1");
    await store.clear(REF);
    await store.put({ ref: REF, id: "p1", keep: { files: [] }, entries: [{ id: "e1", path: "a.mp4", size: 1, modified: 1 }] });
    expect((await store.all(REF))[0]!.entries).toHaveLength(1);
  });
});
