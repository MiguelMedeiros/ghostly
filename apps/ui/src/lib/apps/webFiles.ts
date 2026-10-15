/**
 * Linked files on the web (WISP 1200 · Linked files): files and folders the person picks for an app, kept by the client
 * as links to the browser's `File` objects, never copied, for as long as the page lives.
 *
 * The app's frame cannot open the picker itself for the client: a request on its port carries no user activation. So
 * the client asks with a sheet of its own, above everything ("Cinema asks to read a folder"), and the person's click on
 * its button opens the browser's picker. What the person picks is all the app gets; hidden files and folders (a name
 * starting with ".") are left out, and so is what `accept` does not name.
 *
 * Links are per app (its reference), not per chat, and the app reads them only by the ids this module chose.
 */
import { MINI_APP_LIMITS, type MiniAppLinkedFile } from "@ghostly/core/miniApp";
import type { Translate } from "../../locales/translate";
import type { LinkedFilesHost } from "../platform";

/** What the sheet says, in the person's language. */
export interface PickSheetText {
  /** "Cinema asks to read a folder" (or files). */
  ask(app: string, folder: boolean): string;
  /** "Choose a folder" (or files). */
  choose(folder: boolean): string;
  /** "Nothing is copied: Cinema reads what you pick, on this device." */
  note(app: string): string;
  cancel: string;
}

/** The sheet's words from the person's translator. */
export function pickSheetText(t: Translate): PickSheetText {
  return {
    ask: (app, folder) => t(folder ? "apps.files.askFolder" : "apps.files.askFiles", { app }),
    choose: (folder) => t(folder ? "apps.files.chooseFolder" : "apps.files.chooseFiles"),
    note: (app) => t("apps.files.note", { app }),
    cancel: t("common.cancel"),
  };
}

/** A file the browser handed over: where it sits in what was picked, and its bytes, read in ranges. */
export interface PickedFile {
  path: string;
  file: Blob & { lastModified?: number };
}

/**
 * Opens the browser's own picker, on the click that called it: the files picked, or null when the person closed it.
 * By default a hidden `<input type=file>` (with `webkitdirectory` for a folder), which every browser has.
 */
export type BrowserPicker = (folder: boolean, accept: string[]) => Promise<PickedFile[] | null>;

interface Link {
  entry: MiniAppLinkedFile;
  file: Blob;
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

/** The browser's picker as a hidden input, clicked from the sheet's button. */
export const inputPicker: BrowserPicker = (folder, accept) =>
  new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (folder) input.setAttribute("webkitdirectory", "");
    else if (accept.length) input.accept = accept.map((e) => `.${e}`).join(",");
    input.style.display = "none";
    let done = false;
    const finish = (picked: PickedFile[] | null) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(picked);
    };
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      finish(files.length ? files.map((file) => ({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file })) : null);
    });
    input.addEventListener("cancel", () => finish(null));
    document.body.appendChild(input);
    input.click();
  });

/**
 * The sheet: the app's request in the client's words, with the button that opens the picker and Cancel. Resolves with
 * what was picked, or null.
 */
function askWithSheet(app: string, folder: boolean, accept: string[], text: PickSheetText, picker: BrowserPicker): Promise<PickedFile[] | null> {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4";
    back.setAttribute("data-testid", "app-files-sheet");
    const sheet = document.createElement("div");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.className = "w-full max-w-sm rounded-lg border border-border bg-sidebar-bg p-4 text-text-primary shadow-lg";
    const title = document.createElement("h2");
    title.className = "m-0 text-base font-semibold";
    title.dir = "auto";
    title.id = `app-files-${randomId()}`;
    title.textContent = text.ask(app, folder);
    sheet.setAttribute("aria-labelledby", title.id);
    const note = document.createElement("p");
    note.className = "mb-4 mt-2 text-sm text-text-secondary";
    note.dir = "auto";
    note.textContent = text.note(app);
    const row = document.createElement("div");
    row.className = "flex justify-end gap-2";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "rounded px-3 py-1.5 text-sm hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
    cancel.textContent = text.cancel;
    cancel.setAttribute("data-testid", "app-files-cancel");
    const choose = document.createElement("button");
    choose.type = "button";
    choose.className = "rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
    choose.textContent = text.choose(folder);
    choose.setAttribute("data-testid", "app-files-choose");
    row.append(cancel, choose);
    sheet.append(title, note, row);
    back.append(sheet);
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let done = false;
    const finish = (picked: PickedFile[] | null) => {
      if (done) return;
      done = true;
      back.remove();
      before?.focus({ preventScroll: true });
      resolve(picked);
    };
    cancel.addEventListener("click", () => finish(null));
    back.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); finish(null); } });
    // The person's click: the picker opens within it. The sheet stays until the picker answers.
    choose.addEventListener("click", () => {
      choose.disabled = true;
      picker(folder, accept).then(finish, () => finish(null));
    });
    document.body.appendChild(back);
    choose.focus({ preventScroll: true });
  });
}

export interface WebLinkedFilesOptions {
  text: () => PickSheetText;
  picker?: BrowserPicker;
  /** Asks the person; by default the sheet above. Tests answer directly. */
  ask?: (app: string, folder: boolean, accept: string[]) => Promise<PickedFile[] | null>;
}

export function webLinkedFiles({ text, picker = inputPicker, ask }: WebLinkedFilesOptions): LinkedFilesHost {
  const apps = new Map<string, Map<string, Link>>();
  const linksOf = (ref: string) => {
    let links = apps.get(ref);
    if (!links) apps.set(ref, (links = new Map()));
    return links;
  };
  const askPerson = ask ?? ((app, folder, accept) => askWithSheet(app, folder, accept, text(), picker));

  return {
    async pick(ref, title, { folder, accept }) {
      const picked = await askPerson(title, folder, accept);
      if (!picked) throw refusal("cancelled", "Nothing was picked");
      const kept = picked.filter(({ path }) => !hidden(path) && (!accept.length || accept.includes(extensionOf(path))));
      const links = linksOf(ref);
      if (links.size + kept.length > MINI_APP_LIMITS.filesEntries) throw refusal("too-large", "Too many files for one app");
      return kept.map(({ path, file }) => {
        const entry: MiniAppLinkedFile = { id: randomId(), path, size: file.size, modified: file.lastModified ?? 0, available: true };
        links.set(entry.id, { entry, file });
        return entry;
      });
    },
    async list(ref) {
      return [...linksOf(ref).values()].map((link) => link.entry);
    },
    async read(ref, id, offset, length) {
      const link = linksOf(ref).get(id);
      if (!link) throw refusal("gone", "No such file");
      if (offset >= link.entry.size) return new Uint8Array(0);
      try {
        return new Uint8Array(await link.file.slice(offset, Math.min(link.entry.size, offset + length)).arrayBuffer());
      } catch (error) {
        // A browser refuses to read a picked file that changed on disk since (`NotReadableError`), or went (`NotFoundError`).
        const name = error instanceof Error ? error.name : "";
        throw name === "NotFoundError" ? refusal("gone", "The file is no longer there") : refusal("changed", "The file changed since it was picked");
      }
    },
    async forget(ref, id) {
      if (id === "all") apps.delete(ref);
      else linksOf(ref).delete(id);
    },
  };
}
