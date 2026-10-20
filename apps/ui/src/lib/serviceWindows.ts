/**
 * The windows a contact's shared web app opens in (Desktop's viewer, `open_service_window`): the page that opened
 * them answers their requests over its chat with that contact. When the profile locks they close, as running apps
 * stop (`stopRunningApps`): nothing of the profile answers them behind the lock screen.
 */

let closer: (() => void) | null = null;

/** How to close them: set by the Desktop host; nowhere else has such windows. */
export function setServiceWindowsCloser(next: (() => void) | null): void {
  closer = next;
}

/** Closes every one of them, where the app has them. */
export function closeServiceWindows(): void {
  closer?.();
}
