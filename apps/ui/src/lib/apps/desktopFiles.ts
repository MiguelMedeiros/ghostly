/**
 * Linked files on Desktop (WISP 1200 · Linked files): the host's own commands (apps/desktop/src/linked_files.rs). The
 * system's dialog asks the person, titled by the client ("Cinema asks to read a folder"); links are paths kept per
 * profile and app, read in ranges by the host and checked against the size and date they had when picked. Only the
 * Ghostly window may call these; the app's window reaches them through its broker here, by the ids it was given.
 */
import type { MiniAppLinkedFile } from "@ghostly/core/miniApp";
import type { LinkedFilesHost } from "../platform";
import { PICK_AFTER_CANCEL_MS } from "./broker";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** The host refuses with "<code>: words", as a string: the broker reads the code from an `Error`. */
const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

/**
 * `space()`: the profile's space, as the host keeps its files (the page's database name). `title(app, folder)`: the
 * dialog's title in the person's language.
 */
export function desktopLinkedFiles(invoke: Invoke, space: () => string, title: (app: string, folder: boolean) => string, now: () => number = Date.now): LinkedFilesHost {
  const call = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>(command, { space: space(), ...args });
    } catch (error) {
      throw asError(error);
    }
  };
  /**
   * The apps whose dialog is up, and when each may ask again after the person cancelled one: per app, not per broker,
   * as every window of an app (one per chat it is open in) has a broker of its own. Held until the dialog answers,
   * whether or not the app is still running: the system's dialog cannot be taken back.
   */
  const picking = new Set<string>();
  const pickAgainAt = new Map<string, number>();
  const pick: LinkedFilesHost["pick"] = async (ref, app, { folder, accept }, signal) => {
    if (signal?.aborted) throw new Error("cancelled: The app stopped");
    if (picking.has(ref) || now() < (pickAgainAt.get(ref) ?? 0)) throw new Error("too-fast: The app's dialog is open, or was just cancelled");
    picking.add(ref);
    // The app stopped with its dialog up: whatever the person picks in it is kept for nobody.
    const stop = () => { void call("linked_files_pick_cancel", { appRef: ref }).catch(() => {}); };
    signal?.addEventListener("abort", stop, { once: true });
    try {
      return await call<MiniAppLinkedFile[]>("linked_files_pick", { appRef: ref, title: title(app, folder), folder, accept });
    } catch (error) {
      // The person cancelled a running app's dialog. One answered after its app stopped is no app asking again.
      if (!signal?.aborted && error instanceof Error && error.message.startsWith("cancelled:")) pickAgainAt.set(ref, now() + PICK_AFTER_CANCEL_MS);
      throw error;
    } finally {
      signal?.removeEventListener("abort", stop);
      picking.delete(ref);
    }
  };
  return {
    pick,
    list: (ref) => call<MiniAppLinkedFile[]>("linked_files_list", { appRef: ref }),
    read: async (ref, id, offset, length) => new Uint8Array(await call<ArrayBuffer>("linked_files_read", { appRef: ref, id, offset, length })),
    forget: (ref, id) => call<void>("linked_files_forget", { appRef: ref, id }),
  };
}
