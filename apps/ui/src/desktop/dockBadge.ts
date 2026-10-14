import { invoke } from "@tauri-apps/api/core";
import type { BadgeNavigator } from "../lib/appBadge";

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/** The Desktop app on Linux, by the platform its WebKitGTK reports. */
const onLinux = () => typeof navigator !== "undefined" && /Linux/i.test(navigator.platform);

/**
 * The app's unread count on the Dock icon (macOS) or the launcher's (Linux docks that show one: KDE Plasma, Dash to
 * Dock), since WKWebView and WebKitGTK have no `navigator.setAppBadge`. On macOS through Tauri's window badge, where
 * no count clears it (0 would show a "0"). On Linux through Rust's own launcher entry on the session bus, as Tauri's
 * reaches only Unity itself, which no current desktop runs. Windows has no badge count; the call fails there, and the
 * page takes that as no badge.
 */
export function dockBadge(call: Invoke = invoke, linux = onLinux()): BadgeNavigator {
  const set = (value: number | null) =>
    (linux ? call("native_unread_count", { count: value ?? 0 }) : call("plugin:window|set_badge_count", { label: "main", value })).then(() => {});
  return {
    setAppBadge: (count) => set(count && count > 0 ? count : null),
    clearAppBadge: () => set(null),
  };
}
