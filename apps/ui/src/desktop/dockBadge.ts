import { invoke } from "@tauri-apps/api/core";
import type { BadgeNavigator } from "../lib/appBadge";

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * The app's unread count on the Dock icon (macOS) or the launcher's (Linux desktops with the Unity launcher API),
 * through Tauri's window badge: WKWebView and WebKitGTK have no `navigator.setAppBadge`. No count clears it, where 0
 * would show a "0". Windows has no badge count; the call fails there, and the page takes that as no badge.
 */
export function dockBadge(call: Invoke = invoke): BadgeNavigator {
  const set = (value: number | null) => call("plugin:window|set_badge_count", { label: "main", value }).then(() => {});
  return {
    setAppBadge: (count) => set(count && count > 0 ? count : null),
    clearAppBadge: () => set(null),
  };
}
