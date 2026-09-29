import { invoke } from "@tauri-apps/api/core";
import type { OidcHost } from "@ghostly/browser/host";
import { DESKTOP_RELAY } from "@ghostly/browser/proofs/oidc/popup";

/**
 * Sign-in for an identity proof in the system browser: providers refuse
 * embedded WebViews. The provider returns to the web app's static callback
 * page, registered once per provider, which forwards the fragment to Rust's
 * one-shot listener on 127.0.0.1 (src-tauri/src/oidc.rs). The state names that
 * listener's port so the page knows where to send it.
 */
export const desktopOidc: OidcHost = {
  platform: "desktop",
  async open() {
    const port = await invoke<number>("oidc_loopback_start");
    return {
      redirectUri: DESKTOP_RELAY,
      statePrefix: `d.${port}.`,
      async authorize(url, signal) {
        const state = new URL(url).searchParams.get("state") ?? "";
        const cancel = () => void invoke("oidc_loopback_cancel", { port }).catch(() => {});
        signal.addEventListener("abort", cancel, { once: true });
        try {
          const answer = await invoke<string>("oidc_loopback_wait", { port, url, expectedState: state });
          // The listener hands back "?query#fragment": put it on the address the provider redirected to.
          return `${DESKTOP_RELAY}${answer}`;
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      },
      close: () => void invoke("oidc_loopback_cancel", { port }).catch(() => {}),
    };
  },
};
