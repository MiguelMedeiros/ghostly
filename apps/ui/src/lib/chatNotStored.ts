/*
 * A new chat the storage had no room for (lib/storage.ts `ensureSession`), made where no dialog is open to say it: New
 * chat, the app icon's shortcut, an invite link. It is said here, once for the whole app, by `ChatNotStoredNotice` in
 * Root, instead of opening a chat address that leads nowhere.
 */

type Listener = (cause: unknown) => void;
let listener: Listener | null = null;

/** The app-wide notice listens; returns a stop. */
export function onChatNotStored(next: Listener): () => void {
  listener = next;
  return () => { if (listener === next) listener = null; };
}

/** A new chat could not be stored. */
export function reportChatNotStored(cause: unknown): void {
  listener?.(cause);
}
