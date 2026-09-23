import type { OidcHost } from "@ghostly/browser/host";

/**
 * Sign-in for an identity proof through Chrome's own window
 * (`chrome.identity.launchWebAuthFlow`), which returns the provider's redirect
 * to `https://<extension id>.chromiumapp.org/oidc` without loading it. The
 * `identity` permission is optional and asked for on the first sign-in.
 */
export const extensionOidc: OidcHost = {
  platform: "extension",
  open() {
    // Before any await: Chrome only shows the permission prompt from a user gesture.
    const granted = chrome.permissions.request({ permissions: ["identity"] });
    return Promise.resolve({
      redirectUri: `https://${chrome.runtime.id}.chromiumapp.org/oidc`,
      async authorize(url, signal) {
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
