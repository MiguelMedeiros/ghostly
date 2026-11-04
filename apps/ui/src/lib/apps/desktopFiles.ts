/**
 * Linked files on Desktop (WISP 1200 · Linked files): the host's own commands (apps/desktop/src/linked_files.rs). The
 * client asks first, with the web's sheet ("Cinema asks to read a folder"), and the person's click on its button opens
 * the system's dialog, titled the same; links are paths kept per profile and app, read in ranges by the host and checked
 * against the size and date they had when picked. Only the Ghostly window may call these; the app's window reaches them
 * through its broker here, by the ids it was given.
 */
import type { MiniAppLinkedFile } from "@ghostly/core/miniApp";
import type { LinkedFilesHost } from "../platform";
import { PICK_AFTER_CANCEL_MS } from "./broker";
import { sheet, type PickSheetText } from "./webFiles";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** The host refuses with "<code>: words", as a string: the broker reads the code from an `Error`. */
const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

export interface DesktopLinkedFilesOptions {
  now?: () => number;
  /**
   * Asks the person whether `app` may read files (or a folder): `open` (the system's dialog) only on their click, null
   * when they did not. By default the client's sheet in the Ghostly window, brought to the front; it goes on `signal`.
   */
  ask?: (app: string, folder: boolean, open: () => Promise<MiniAppLinkedFile[]>, signal?: AbortSignal) => Promise<MiniAppLinkedFile[] | null>;
}

/**
 * `space()`: the profile's space, as the host keeps its files (the page's database name). `text()`: the sheet's words
 * and the dialog's title, in the person's language.
 */
export function desktopLinkedFiles(invoke: Invoke, space: () => string, text: () => PickSheetText, { now = Date.now, ask }: DesktopLinkedFilesOptions = {}): LinkedFilesHost {
  const call = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>(command, { space: space(), ...args });
    } catch (error) {
      throw asError(error);
    }
  };
  /**
   * The apps whose sheet or dialog is up, and when each may ask again after the person cancelled one: per app, not per broker,
   * as every window of an app (one per chat it is open in) has a broker of its own. Held until the dialog answers,
   * whether or not the app is still running: the system's dialog cannot be taken back.
   */
  const picking = new Set<string>();
  const pickAgainAt = new Map<string, number>();
  /** The sheet is in the Ghostly window, which an app's window may be in front of. */
  const front = () => {
    void (async () => {
      for (const command of ["unminimize", "show", "set_focus"]) await invoke(`plugin:window|${command}`, { label: "main" });
    })().catch(() => {});
  };
  const askPerson = ask ?? ((app, folder, open, signal) => {
    front();
    return sheet({
      title: text().ask(app, folder), note: text().note(app), secondary: text().cancel, primary: text().choose(folder), testId: "app-files-sheet",
      act: open, signal,
    }) as Promise<MiniAppLinkedFile[] | null>;
  });
  const pick: LinkedFilesHost["pick"] = async (ref, app, { folder, accept }, signal) => {
    if (signal?.aborted) throw new Error("cancelled: The app stopped");
    if (picking.has(ref) || now() < (pickAgainAt.get(ref) ?? 0)) throw new Error("too-fast: The app's sheet or dialog is open, or was just cancelled");
    picking.add(ref);
    /** The system's dialog, once the person clicked for it, and how it answered. */
    let dialog: Promise<MiniAppLinkedFile[]> | undefined;
    let failed: Error | undefined;
    const open = () => (dialog ??= call<MiniAppLinkedFile[]>("linked_files_pick", { appRef: ref, title: text().ask(app, folder), folder, accept })
      .catch((error: Error) => { failed = error; throw error; }));
    // The app stopped with its dialog up: whatever the person picks in it is kept for nobody.
    const stop = () => { if (dialog) void call("linked_files_pick_cancel", { appRef: ref }).catch(() => {}); };
    signal?.addEventListener("abort", stop, { once: true });
    try {
      const picked = await askPerson(app, folder, open, signal);
      if (failed) throw failed;
      if (!picked) throw new Error("cancelled: Nothing was picked");
      return picked;
    } catch (error) {
      // The person cancelled a running app's sheet or dialog. One answered after its app stopped is no app asking again.
      if (!signal?.aborted && error instanceof Error && error.message.startsWith("cancelled:")) pickAgainAt.set(ref, now() + PICK_AFTER_CANCEL_MS);
      throw error;
    } finally {
      signal?.removeEventListener("abort", stop);
      // The sheet goes with its app, the system's dialog cannot be taken back: the app's next pick waits for it.
      await dialog?.catch(() => {});
      picking.delete(ref);
    }
  };
  return {
    pick,
    list: (ref) => call<MiniAppLinkedFile[]>("linked_files_list", { appRef: ref }),
    entry: (ref, id) => call<MiniAppLinkedFile | null>("linked_files_entry", { appRef: ref, id }),
    read: async (ref, id, offset, length) => new Uint8Array(await call<ArrayBuffer>("linked_files_read", { appRef: ref, id, offset, length })),
    forget: (ref, id) => call<void>("linked_files_forget", { appRef: ref, id }),
  };
}
