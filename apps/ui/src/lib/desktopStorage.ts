import { useEffect, useState } from "react";
import { fileBytesOf, type FileUsage } from "@ghostly/browser/shared/fileBytes";

/**
 * "Storage used" on the Desktop. A browser's `navigator.storage.estimate()` counts every database and file of the
 * site, so the web app shows it; the Desktop keeps a profile's files as real files in its data folder
 * (`files/<space>/`, apps/desktop/src/file_store.rs), which no estimate of the WebView sees. So the Desktop adds up:
 *
 * - `app`: the WebView's own storage (IndexedDB, where messages and keys are), as its estimate says, when it says.
 *   That is the app's, every profile on this device together: the WebView cannot tell one profile's share.
 * - `local`: the app's small settings (localStorage), counted as before.
 * - `files`: this profile's files, from Rust, and how many.
 * - `staged`: copies staged for a save, from Rust: a backup being made, a file on its way through the save dialog.
 *
 * The HyperDHT sidecar keeps nothing on disk, and the device record (`devices/<profile>`) is a few hundred bytes.
 */
export interface DesktopStorage {
  app: number | null;
  local: number;
  files: FileUsage | null;
}

export type StoragePartKey = "app" | "local" | "files" | "staged";
export interface StoragePart { key: StoragePartKey; bytes: number; count?: number }

/** The total and the parts behind it: a part nobody could measure is left out, and so are staged copies when there are none. */
export function storageBreakdown({ app, local, files }: DesktopStorage): { total: number; parts: StoragePart[] } {
  const parts: StoragePart[] = [];
  if (app !== null) parts.push({ key: "app", bytes: app });
  parts.push({ key: "local", bytes: local });
  if (files) {
    parts.push({ key: "files", bytes: files.files, count: files.count });
    if (files.staged > 0) parts.push({ key: "staged", bytes: files.staged });
  }
  return { total: parts.reduce((sum, part) => sum + part.bytes, 0), parts };
}

/** What the WebView says it uses, or null where it does not say. */
async function webViewUsage(): Promise<number | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return typeof estimate?.usage === "number" && Number.isFinite(estimate.usage) ? estimate.usage : null;
  } catch {
    return null;
  }
}

/** What the active profile's files take, or null when Rust could not say. */
async function filesUsage(): Promise<FileUsage | null> {
  try {
    const native = await fileBytesOf("native");
    return native?.usage ? await native.usage() : null;
  } catch {
    return null;
  }
}

export async function readDesktopStorage(local: number): Promise<DesktopStorage> {
  const [app, files] = await Promise.all([webViewUsage(), filesUsage()]);
  return { app, local, files };
}

/** The Desktop's storage, read when Settings opens and again when `local` changes (chats deleted); null elsewhere. */
export function useDesktopStorage(desktop: boolean, local: number): DesktopStorage | null {
  const [storage, setStorage] = useState<DesktopStorage | null>(null);
  useEffect(() => {
    if (!desktop) return;
    let live = true;
    void readDesktopStorage(local).then((read) => { if (live) setStorage(read); });
    return () => { live = false; };
  }, [desktop, local]);
  return desktop ? storage : null;
}
