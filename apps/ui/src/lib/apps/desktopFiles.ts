/**
 * Linked files on Desktop (WISP 1200 · Linked files): the host's own commands (apps/desktop/src/linked_files.rs). The
 * system's dialog asks the person, titled by the client ("Cinema asks to read a folder"); links are paths kept per
 * profile and app, read in ranges by the host and checked against the size and date they had when picked. Only the
 * Ghostly window may call these; the app's window reaches them through its broker here, by the ids it was given.
 */
import type { MiniAppLinkedFile } from "@ghostly/core/miniApp";
import type { LinkedFilesHost } from "../platform";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** The host refuses with "<code>: words", as a string: the broker reads the code from an `Error`. */
const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

/**
 * `space()`: the profile's space, as the host keeps its files (the page's database name). `title(app, folder)`: the
 * dialog's title in the person's language.
 */
export function desktopLinkedFiles(invoke: Invoke, space: () => string, title: (app: string, folder: boolean) => string): LinkedFilesHost {
  const call = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>(command, { space: space(), ...args });
    } catch (error) {
      throw asError(error);
    }
  };
  return {
    pick: (ref, app, { folder, accept }) => call<MiniAppLinkedFile[]>("linked_files_pick", { appRef: ref, title: title(app, folder), folder, accept }),
    list: (ref) => call<MiniAppLinkedFile[]>("linked_files_list", { appRef: ref }),
    read: async (ref, id, offset, length) => new Uint8Array(await call<ArrayBuffer>("linked_files_read", { appRef: ref, id, offset, length })),
    forget: (ref, id) => call<void>("linked_files_forget", { appRef: ref, id }),
  };
}
