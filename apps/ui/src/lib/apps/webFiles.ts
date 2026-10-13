/**
 * Linked files on the web (WISP 1200 · Linked files): files and folders the person picks for an app, kept by the client
 * as links, never copies.
 *
 * The app's frame cannot open the picker itself for the client: a request on its port carries no user activation. So
 * the client asks with a sheet of its own, above everything ("Cinema asks to read a folder"), and the person's click on
 * its button opens the browser's picker. What the person picks is all the app gets; hidden files and folders (a name
 * starting with ".") are left out, and so is what `accept` does not name.
 *
 * How long a link lasts depends on the browser:
 * - Where the browser has the File System Access pickers (Chromium), the picked folder's handle (or the picked files')
 *   is kept in a database of the profile's own, `<profile database>-files`, which goes with the profile. After a
 *   restart the browser asks again: the links read `available: false` until the person allows it, and the app's
 *   first `files.list` shows the client's sheet once ("Cinema asks to read “Films” again"), whose button asks the browser.
 * - Elsewhere (Safari, Firefox), a hidden `<input type=file>`: the browser's `File` objects, for the page's life.
 *
 * Links are per app (its reference), not per chat, and the app reads them only by the ids this module chose.
 */
import { MINI_APP_LIMITS, type MiniAppLinkedFile } from "@ghostly/core/miniApp";
import type { Translate } from "../../locales/translate";
import type { LinkedFilesHost } from "../platform";

/** What the sheets say, in the person's language. */
export interface PickSheetText {
  /** "Cinema asks to read a folder" (or files). */
  ask(app: string, folder: boolean): string;
  /** "Choose a folder" (or files). */
  choose(folder: boolean): string;
  /** "Nothing is copied: Cinema reads what you pick, on this device." */
  note(app: string): string;
  cancel: string;
  /** "Cinema asks to read “Films” again", after a restart. */
  askAgain(app: string, name: string): string;
  allow: string;
  notNow: string;
}

/** The sheets' words from the person's translator. */
export function pickSheetText(t: Translate): PickSheetText {
  return {
    ask: (app, folder) => t(folder ? "apps.files.askFolder" : "apps.files.askFiles", { app }),
    choose: (folder) => t(folder ? "apps.files.chooseFolder" : "apps.files.chooseFiles"),
    note: (app) => t("apps.files.note", { app }),
    cancel: t("common.cancel"),
    askAgain: (app, name) => t("apps.files.askAgain", { app, name }),
    allow: t("apps.files.allow"),
    notNow: t("apps.files.notNow"),
  };
}

/** A file the browser handed over: where it sits in what was picked, and its bytes, read in ranges. */
export interface PickedFile {
  path: string;
  file: Blob & { lastModified?: number };
  /** Its place in `keep.files`, when the files themselves were picked. */
  at?: number;
}

/** What lets a pick be read again after a restart: the folder's handle, or the files' (File System Access). */
export type Keep = { dir: FileSystemDirectoryHandle } | { files: FileSystemFileHandle[] };

/** What the browser's picker gave: the files, and what keeps them, where the browser has it. */
export interface Picked {
  files: PickedFile[];
  keep?: Keep;
}

/**
 * Opens the browser's own picker, on the click that called it: what was picked, or null when the person closed it.
 * `handlePicker` where the browser has `showDirectoryPicker`, `inputPicker` elsewhere.
 */
export type BrowserPicker = (folder: boolean, accept: string[]) => Promise<Picked | null>;

/** A pick as kept past the page: what reads it again, and its entries (each with its place in `keep.files`). */
export interface StoredPick {
  ref: string;
  id: string;
  keep: Keep;
  entries: (Omit<MiniAppLinkedFile, "available"> & { at?: number })[];
}

/** Where picks outlive the page. */
export interface PickStore {
  all(ref: string): Promise<StoredPick[]>;
  put(pick: StoredPick): Promise<void>;
  remove(ref: string, id: string): Promise<void>;
  clear(ref: string): Promise<void>;
}

interface Link {
  entry: MiniAppLinkedFile;
  /** The pick it came from: its `keep` reads it again. */
  pick?: string;
  at?: number;
  /** The browser's file, once resolved. */
  file?: Blob;
}

/** Refusals cross to the broker as "<code>: words" (broker.ts reads the code). */
const refusal = (code: "cancelled" | "changed" | "gone" | "too-large", words: string) => new Error(`${code}: ${words}`);

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Whether a path names something hidden: any of its parts starts with a dot. */
const hidden = (path: string) => path.split("/").some((part) => part.startsWith("."));

const extensionOf = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

type PermissionHandle = FileSystemHandle & {
  queryPermission?(options: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "read" }): Promise<PermissionState>;
};
const handleOf = (keep: Keep): PermissionHandle | undefined => ("dir" in keep ? keep.dir : keep.files[0]) as PermissionHandle | undefined;
const keepName = (keep: Keep) => ("dir" in keep ? keep.dir.name : keep.files.map((f) => f.name).join(", "));

/** The browser's picker as a hidden input, clicked from the sheet's button: nothing is kept past the page. */
export const inputPicker: BrowserPicker = (folder, accept) =>
  new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (folder) input.setAttribute("webkitdirectory", "");
    else if (accept.length) input.accept = accept.map((e) => `.${e}`).join(",");
    input.style.display = "none";
    let done = false;
    const finish = (picked: Picked | null) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(picked);
    };
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      finish(files.length ? { files: files.map((file) => ({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file })) } : null);
    });
    input.addEventListener("cancel", () => finish(null));
    document.body.appendChild(input);
    input.click();
  });

/** Everything under a folder, its name first in each path, hidden entries left out, at most `limit` files. */
async function walk(dir: FileSystemDirectoryHandle, path: string, out: PickedFile[], limit: number): Promise<void> {
  for await (const handle of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
    if (out.length > limit) return;
    if (handle.name.startsWith(".")) continue;
    const at = `${path}/${handle.name}`;
    if (handle.kind === "directory") await walk(handle as FileSystemDirectoryHandle, at, out, limit);
    else out.push({ path: at, file: await (handle as FileSystemFileHandle).getFile() });
  }
}

type Pickers = {
  showDirectoryPicker?(options: { mode: "read" }): Promise<FileSystemDirectoryHandle>;
  showOpenFilePicker?(options: { multiple: boolean; types?: { accept: Record<string, string[]> }[] }): Promise<FileSystemFileHandle[]>;
};

/** The File System Access pickers (Chromium): what was picked, with the handles that read it after a restart. */
export const handlePicker: BrowserPicker = async (folder, accept) => {
  const w = globalThis as unknown as Pickers;
  try {
    if (folder) {
      const dir = await w.showDirectoryPicker!({ mode: "read" });
      const files: PickedFile[] = [];
      await walk(dir, dir.name, files, MINI_APP_LIMITS.filesEntries);
      return { files, keep: { dir } };
    }
    const handles = await w.showOpenFilePicker!({ multiple: true, ...(accept.length && { types: [{ accept: { "application/octet-stream": accept.map((e) => `.${e}`) } }] }) });
    const files = await Promise.all(handles.map(async (handle, at) => ({ path: handle.name, file: await handle.getFile(), at })));
    return { files, keep: { files: handles } };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return null;
    throw error;
  }
};

/** The picker this browser has: the handles' where it can keep them. */
export const browserPicker = (): BrowserPicker => (typeof (globalThis as Pickers).showDirectoryPicker === "function" ? handlePicker : inputPicker);

/** The database a profile keeps its apps' picks in, beside its peer database, deleted with it (`deleteProfile`). */
export const linkedFilesDatabase = (profileDatabase: string) => `${profileDatabase}-files`;

/** Picks in IndexedDB, in the database `name()` names (the profile's own: it goes with the profile). */
export function idbPickStore(name: () => string): PickStore {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name(), 1);
      request.onupgradeneeded = () => { request.result.createObjectStore("picks", { keyPath: "key" }); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const run = async <T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> => {
    const db = await open();
    try {
      return await new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction("picks", mode);
        const request = act(tx.objectStore("picks"));
        tx.oncomplete = () => resolve(request ? request.result : undefined);
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    all: async (ref) => ((await run("readonly", (s) => s.getAll())) as (StoredPick & { key: string })[] ?? []).filter((p) => p.ref === ref),
    put: async (pick) => { await run("readwrite", (s) => { s.put({ ...pick, key: `${pick.ref} ${pick.id}` }); }); },
    remove: async (ref, id) => { await run("readwrite", (s) => { s.delete(`${ref} ${id}`); }); },
    clear: async (ref) => {
      const picks = await run("readonly", (s) => s.getAll()) as (StoredPick & { key: string })[] | undefined;
      await run("readwrite", (s) => { for (const p of picks ?? []) if (p.ref === ref) s.delete(p.key); });
    },
  };
}

/** A sheet of the client's own: a title, a note, a second button and a first one whose click does `act`. */
function sheet(parts: { title: string; note?: string; secondary: string; primary: string; testId: string; act: () => Promise<unknown> }): Promise<unknown> {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4";
    back.setAttribute("data-testid", parts.testId);
    const box = document.createElement("div");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.className = "w-full max-w-sm rounded-lg border border-border bg-sidebar-bg p-4 text-text-primary shadow-lg";
    const title = document.createElement("h2");
    title.className = "m-0 text-base font-semibold";
    title.dir = "auto";
    title.id = `app-files-${randomId()}`;
    title.textContent = parts.title;
    box.setAttribute("aria-labelledby", title.id);
    box.append(title);
    if (parts.note) {
      const note = document.createElement("p");
      note.className = "mt-2 text-sm text-text-secondary";
      note.dir = "auto";
      note.textContent = parts.note;
      box.append(note);
    }
    const row = document.createElement("div");
    row.className = "mt-4 flex justify-end gap-2";
    const secondary = document.createElement("button");
    secondary.type = "button";
    secondary.className = "rounded px-3 py-1.5 text-sm hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
    secondary.textContent = parts.secondary;
    secondary.setAttribute("data-testid", "app-files-cancel");
    const primary = document.createElement("button");
    primary.type = "button";
    primary.className = "rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
    primary.textContent = parts.primary;
    primary.setAttribute("data-testid", "app-files-choose");
    row.append(secondary, primary);
    box.append(row);
    back.append(box);
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let done = false;
    const finish = (value: unknown) => {
      if (done) return;
      done = true;
      back.remove();
      before?.focus({ preventScroll: true });
      resolve(value);
    };
    secondary.addEventListener("click", () => finish(null));
    back.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); finish(null); } });
    // The person's click: the browser is asked within it. The sheet stays until it answers.
    primary.addEventListener("click", () => {
      primary.disabled = true;
      parts.act().then(finish, () => finish(null));
    });
    document.body.appendChild(back);
    primary.focus({ preventScroll: true });
  });
}

export interface WebLinkedFilesOptions {
  text: () => PickSheetText;
  picker?: BrowserPicker;
  /** Where picks that can be kept are kept; none: links last for the page. */
  store?: PickStore | null;
  /** Asks the person to pick; by default the sheet. Tests answer directly. */
  ask?: (app: string, folder: boolean, accept: string[]) => Promise<Picked | null>;
  /** Asks the person to let the browser read kept picks again (`grant` asks it); by default the sheet. */
  askAgain?: (app: string, name: string, grant: () => Promise<boolean>) => Promise<boolean>;
}

export function webLinkedFiles({ text, picker = browserPicker(), store = null, ask, askAgain }: WebLinkedFilesOptions): LinkedFilesHost {
  const apps = new Map<string, Map<string, Link>>();
  /** Each kept pick by id, with whether the browser lets it be read now. */
  const picks = new Map<string, { stored: StoredPick; granted: boolean }>();
  const loading = new Map<string, Promise<void>>();
  /** Apps whose kept picks the person was asked about on this page: never twice. */
  const askedAgain = new Set<string>();
  const linksOf = (ref: string) => {
    let links = apps.get(ref);
    if (!links) apps.set(ref, (links = new Map()));
    return links;
  };
  const askPerson = ask ?? ((app, folder, accept) => sheet({
    title: text().ask(app, folder), note: text().note(app), secondary: text().cancel, primary: text().choose(folder), testId: "app-files-sheet",
    act: () => picker(folder, accept),
  }) as Promise<Picked | null>);
  const askPersonAgain = askAgain ?? ((app, name, grant) => sheet({
    title: text().askAgain(app, name), note: text().note(app), secondary: text().notNow, primary: text().allow, testId: "app-files-again",
    act: grant,
  }).then((granted) => granted === true));

  const permitted = async (keep: Keep, request = false): Promise<boolean> => {
    const handle = handleOf(keep);
    if (!handle) return false;
    try {
      const state = await (request ? handle.requestPermission?.({ mode: "read" }) : handle.queryPermission?.({ mode: "read" }));
      return state === "granted";
    } catch {
      return false;
    }
  };

  const setAvailable = (ref: string, pick: string, available: boolean) => {
    for (const link of linksOf(ref).values()) if (link.pick === pick) link.entry = { ...link.entry, available };
  };

  /** The app's kept picks, read once per page. */
  const load = (ref: string): Promise<void> => {
    let done = loading.get(ref);
    if (!done) {
      done = (async () => {
        if (!store) return;
        const links = linksOf(ref);
        for (const stored of await store.all(ref).catch(() => [])) {
          const granted = await permitted(stored.keep);
          picks.set(stored.id, { stored, granted });
          for (const { at, ...entry } of stored.entries) {
            if (!links.has(entry.id)) links.set(entry.id, { entry: { ...entry, available: granted }, pick: stored.id, ...(at !== undefined && { at }) });
          }
        }
      })();
      loading.set(ref, done);
    }
    return done;
  };

  /** The browser's file for a kept link, checked against what was picked. */
  const resolve = async (link: Link): Promise<Blob> => {
    if (link.file) return link.file;
    const kept = link.pick ? picks.get(link.pick) : undefined;
    if (!kept?.granted) throw refusal("gone", "The browser does not let it be read now");
    let file: File;
    try {
      const keep = kept.stored.keep;
      if ("dir" in keep) {
        const parts = link.entry.path.split("/").slice(1);
        let dir = keep.dir;
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
        file = await (await dir.getFileHandle(parts[parts.length - 1]!)).getFile();
      } else {
        const handle = keep.files[link.at ?? -1];
        if (!handle) throw Object.assign(new Error("no handle"), { name: "NotFoundError" });
        file = await handle.getFile();
      }
    } catch (error) {
      throw error instanceof Error && error.name === "NotFoundError" ? refusal("gone", "The file is no longer there") : refusal("gone", "The file cannot be read");
    }
    if (file.size !== link.entry.size || file.lastModified !== link.entry.modified) throw refusal("changed", "The file changed since it was picked");
    link.file = file;
    return file;
  };

  return {
    async pick(ref, title, { folder, accept }) {
      await load(ref);
      const picked = await askPerson(title, folder, accept);
      if (!picked) throw refusal("cancelled", "Nothing was picked");
      const kept = picked.files.filter(({ path }) => !hidden(path) && (!accept.length || accept.includes(extensionOf(path))));
      const links = linksOf(ref);
      if (links.size + kept.length > MINI_APP_LIMITS.filesEntries) throw refusal("too-large", "Too many files for one app");
      const pickId = picked.keep && store ? randomId() : undefined;
      const added = kept.map(({ path, file, at }) => {
        const entry: MiniAppLinkedFile = { id: randomId(), path, size: file.size, modified: file.lastModified ?? 0, available: true };
        links.set(entry.id, { entry, file, ...(pickId && { pick: pickId }), ...(at !== undefined && { at }) });
        return { entry, at };
      });
      if (pickId && picked.keep && store) {
        const stored: StoredPick = { ref, id: pickId, keep: picked.keep, entries: added.map(({ entry: { available: _, ...rest }, at }) => ({ ...rest, ...(at !== undefined && { at }) })) };
        picks.set(pickId, { stored, granted: true });
        // Kept for the next page; a store that fails leaves the links for this one.
        await store.put(stored).catch(() => {});
      }
      return added.map(({ entry }) => entry);
    },
    async list(ref, title) {
      await load(ref);
      // Kept picks the browser asks about again (after a restart): the person is asked once on this page.
      const waiting = [...picks.values()].filter((p) => p.stored.ref === ref && !p.granted);
      if (waiting.length && !askedAgain.has(ref)) {
        askedAgain.add(ref);
        const name = waiting.map((p) => keepName(p.stored.keep)).join(", ");
        await askPersonAgain(title, name, async () => {
          let any = false;
          for (const p of waiting) {
            p.granted = await permitted(p.stored.keep, true);
            setAvailable(ref, p.stored.id, p.granted);
            any ||= p.granted;
          }
          return any;
        }).catch(() => false);
      }
      return [...linksOf(ref).values()].map((link) => link.entry);
    },
    async read(ref, id, offset, length) {
      await load(ref);
      const link = linksOf(ref).get(id);
      if (!link) throw refusal("gone", "No such file");
      const file = await resolve(link);
      if (offset >= link.entry.size) return new Uint8Array(0);
      try {
        return new Uint8Array(await file.slice(offset, Math.min(link.entry.size, offset + length)).arrayBuffer());
      } catch (error) {
        // A browser refuses to read a picked file that changed on disk since (`NotReadableError`), or went (`NotFoundError`).
        const name = error instanceof Error ? error.name : "";
        throw name === "NotFoundError" ? refusal("gone", "The file is no longer there") : refusal("changed", "The file changed since it was picked");
      }
    },
    async forget(ref, id) {
      await load(ref);
      if (id === "all") {
        apps.delete(ref);
        for (const [pickId, p] of picks) if (p.stored.ref === ref) picks.delete(pickId);
        await store?.clear(ref).catch(() => {});
        return;
      }
      const link = linksOf(ref).get(id);
      linksOf(ref).delete(id);
      const kept = link?.pick ? picks.get(link.pick) : undefined;
      if (!kept) return;
      kept.stored = { ...kept.stored, entries: kept.stored.entries.filter((e) => e.id !== id) };
      if (kept.stored.entries.length) await store?.put(kept.stored).catch(() => {});
      else {
        picks.delete(kept.stored.id);
        await store?.remove(ref, kept.stored.id).catch(() => {});
      }
    },
  };
}
