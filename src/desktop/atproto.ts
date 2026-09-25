import { invoke } from "@tauri-apps/api/core";
import type { AtprotoHost } from "@ghostly/browser/proofs/atproto/oauth";

/**
 * Signing in to an AT Protocol server from the desktop app, the native-client way: the server's page
 * opens in the system browser and redirects straight to a one-shot listener on 127.0.0.1 (the same
 * one OpenID Connect uses, src-tauri/src/oidc.rs). Loopback redirects are registered without a port,
 * so any free port matches. The flow names the state it waits for (PAR keeps it off the address).
 * The DPoP key and tokens stay in this WebView and are never logged.
 */
export const desktopAtproto: AtprotoHost = {
  platform: "desktop",
  async open() {
    const port = await invoke<number>("oidc_loopback_start");
    const redirectUri = `http://127.0.0.1:${port}/oidc-callback`;
    return {
      redirectUri,
      async authorize(url, state, signal) {
        const cancel = () => void invoke("oidc_loopback_cancel", { port }).catch(() => {});
        signal.addEventListener("abort", cancel, { once: true });
        try {
          const answer = await invoke<string>("oidc_loopback_wait", { port, url, expectedState: state });
          // The listener hands back "?query#fragment": put it on the address the server redirected to.
          return `${redirectUri}${answer}`;
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      },
      close: () => void invoke("oidc_loopback_cancel", { port }).catch(() => {}),
    };
  },
};
