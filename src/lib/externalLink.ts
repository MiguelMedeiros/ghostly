import { invoke } from "@tauri-apps/api/core";
import type React from "react";

/**
 * A web link opened outside the app. A browser page opens it in a new tab through the link itself (no opener, no
 * referrer); Desktop's WebView cannot (WKWebView, as Tauri sets it up, drops a new-window request), so Rust hands it
 * to the system (`open_web_link`, http(s) only), which opens the browser, or the Maps app for an Apple Maps link.
 * Every `target="_blank"` in the app comes from here: src/test/ui/externalLinks.test.tsx fails on any other.
 */
export const isDesktopApp = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface ExternalLinkOptions {
  /** The Rust command that opens it on Desktop: `open_project_link` takes only Ghostly's own pages. */
  command?: "open_web_link" | "open_project_link";
  /** Desktop refused or failed to open it. */
  onError?: (error: unknown) => void;
}

/** Props for an `<a>` that opens `href` outside the app, whatever the platform. */
export function externalLinkProps(href: string, { command = "open_web_link", onError }: ExternalLinkOptions = {}): React.AnchorHTMLAttributes<HTMLAnchorElement> {
  return {
    href,
    target: "_blank",
    rel: "noopener noreferrer",
    referrerPolicy: "no-referrer",
    onClick: (event) => {
      if (!isDesktopApp()) return;
      const url = desktopUrl(href);
      if (!url) return;
      event.preventDefault();
      void invoke(command, { url }).catch((error: unknown) => onError?.(error));
    },
  };
}

/**
 * `href` as the system opener gets it: an http(s) URL in plain ASCII, as a browser would send it (the path and query
 * percent-encoded, the host in punycode), since Rust takes nothing else. Undefined for any other address.
 */
export function desktopUrl(href: string): string | undefined {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Which maps app "Open in maps" can reach: Apple's on Apple systems, the chosen one on Android, else the web. */
export function mapsPlatform(): "apple" | "android" | "other" {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Android/i.test(agent)) return "android";
  if (/iPhone|iPad|iPod|Macintosh|Mac OS X/i.test(agent)) return "apple";
  return "other";
}
