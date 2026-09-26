import { invoke } from "@tauri-apps/api/core";
import type React from "react";

/**
 * A web link from a message (a link preview, a location card) opened outside the app. A browser page opens it in a
 * new tab through the link itself (no opener, no referrer); Desktop's WebView cannot, so Rust hands it to the
 * system (`open_web_link`, http(s) only), which opens the browser, or the Maps app for an Apple Maps link.
 */
export const isDesktopApp = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Props for an `<a>` that opens `href` outside the app, whatever the platform. */
export function externalLinkProps(href: string): React.AnchorHTMLAttributes<HTMLAnchorElement> {
  return {
    href,
    target: "_blank",
    rel: "noopener noreferrer",
    referrerPolicy: "no-referrer",
    onClick: (event) => {
      if (!isDesktopApp() || !/^https?:/i.test(href)) return;
      event.preventDefault();
      void invoke("open_web_link", { url: href }).catch(() => {});
    },
  };
}

/** Which maps app "Open in maps" can reach: Apple's on Apple systems, the chosen one on Android, else the web. */
export function mapsPlatform(): "apple" | "android" | "other" {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Android/i.test(agent)) return "android";
  if (/iPhone|iPad|iPod|Macintosh|Mac OS X/i.test(agent)) return "apple";
  return "other";
}
