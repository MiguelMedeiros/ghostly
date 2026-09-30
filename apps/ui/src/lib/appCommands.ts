/**
 * The app's commands from outside the page: Desktop's menu (New Chat, Settings…, apps/desktop/src/app_window.rs) and,
 * on Linux and Windows where Desktop has no menu bar, Ctrl+N and Ctrl+, pressed in the window. The host turns each
 * into an `APP_COMMAND_EVENT` on the page; `useAppCommands` runs it.
 */
export type AppCommand = "new" | "settings";

export const APP_COMMAND_EVENT = "ghostly-app-command";

export function isAppCommand(value: unknown): value is AppCommand {
  return value === "new" || value === "settings";
}

/** Asks the page to run `command`. */
export function sendAppCommand(command: AppCommand): void {
  window.dispatchEvent(new CustomEvent<AppCommand>(APP_COMMAND_EVENT, { detail: command }));
}

type Keys = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "repeat">;

/** The command Ctrl+N or Ctrl+, stands for, with no other modifier and not held down; null for any other key. */
export function appCommandForKey(e: Keys): AppCommand | null {
  if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return null;
  if (e.code === "KeyN" || e.key.toLowerCase() === "n") return "new";
  if (e.code === "Comma" || e.key === ",") return "settings";
  return null;
}
