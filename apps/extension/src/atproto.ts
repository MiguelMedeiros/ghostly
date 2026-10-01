import type { AtprotoHost } from "@ghostly/browser/proofs/atproto/oauth";

/**
 * Signing in to an AT Protocol server through Chrome's own window (`chrome.identity.launchWebAuthFlow`),
 * which catches the server's redirect to `https://<extension id>.chromiumapp.org/atproto` without
 * loading it. Only the Chrome Web Store build's id is registered in Ghostly's client metadata; an
 * unpacked build's id is refused by the server. The `identity` permission is optional and asked for
 * on the first sign-in, from the click.
 */
export const extensionAtproto: AtprotoHost = {
  platform: "extension",
  open() {
    // Before any await: Chrome only shows the permission prompt from a user gesture.
    const granted = chrome.permissions.request({ permissions: ["identity"] });
    return Promise.resolve({
      redirectUri: `https://${chrome.runtime.id}.chromiumapp.org/atproto`,
      async authorize(url, _state, signal) {
        if (!(await granted)) throw new Error("Ghostly needs the sign-in permission for this.");
        signal.throwIfAborted();
        const cancelled = new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("Sign-in cancelled")), { once: true }),
        );
        const redirected = await Promise.race([chrome.identity.launchWebAuthFlow({ url, interactive: true }), cancelled]);
        if (!redirected) throw new Error("Sign-in was cancelled.");
        return redirected;
      },
      close() {},
    });
  },
};
