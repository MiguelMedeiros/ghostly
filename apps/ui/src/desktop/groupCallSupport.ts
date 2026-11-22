import { isDesktopApp } from "../lib/externalLink";

/*
 * Apart from `nativeCalls`, whose Tauri channels the extension's and the web app's builds have no stand-in for: the
 * group's call button, in every build, reads only this.
 */

/** Whether this app can join a group call, and why not. */
export interface GroupCallSupport {
  supported: boolean;
  /** Why not, in English (`errorText` says it in the app's language); null where it can. */
  reason: string | null;
}

export const GROUP_CALLS_NOT_ON_LINUX = "Group calls aren't on Linux yet: join from app.ghostly.tools in a browser";

/**
 * Whether this app can join a group call. A group call runs in the page (the group's node's SFU, through the
 * WebView's own WebRTC), unlike a 1:1 call, which Rust runs on Linux (`nativeCalls`): WebKitGTK has no
 * RTCPeerConnection, so the Linux Desktop cannot, and its group call button shows off with the reason. macOS
 * (WKWebView), Windows (WebView2), the Android app (Chromium's WebView, whose agent says Linux too) and the web app
 * have WebRTC.
 */
export function groupCallSupport(
  desktop = isDesktopApp(),
  agent = typeof navigator === "undefined" ? "" : navigator.userAgent,
): GroupCallSupport {
  if (desktop && /Linux/.test(agent) && !/Android/.test(agent)) return { supported: false, reason: GROUP_CALLS_NOT_ON_LINUX };
  return { supported: true, reason: null };
}
