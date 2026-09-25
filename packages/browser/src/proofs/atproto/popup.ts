import type { AtprotoWindow } from "./oauth";
import { CALLBACK_PATH, OIDC_CHANNEL } from "../oidc/popup";

/**
 * The web app's AT Protocol sign-in window. It returns to the same static callback page as OpenID
 * Connect (`/oidc-callback.html`), with the answer in the fragment, which never reaches a server; the
 * page passes it back over a same-origin BroadcastChannel. The authorization URL carries no `state`
 * (PAR keeps it on the server), so the flow says which state it waits for.
 */

const WAIT_MS = 10 * 60_000;

function stateOf(url: string): string | null {
  const u = new URL(url);
  return new URLSearchParams(u.hash.slice(1)).get("state") ?? u.searchParams.get("state");
}

/** Opens the popup at once (from the click) on a blank page of this origin, and points it at the server once the request is ready. */
export function atprotoPopupWindow(origin = location.origin): AtprotoWindow {
  const popup = window.open("about:blank", "ghostly-atproto", "popup,width=520,height=760");
  const channel = new BroadcastChannel(OIDC_CHANNEL);
  let done = false;
  return {
    redirectUri: `${origin}${CALLBACK_PATH}`,
    authorize(url, expected, signal) {
      if (!popup) return Promise.reject(new Error("Allow pop-ups for Ghostly to sign in."));
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => finish(() => reject(new Error("Sign-in timed out. Try again."))), WAIT_MS);
        const finish = (settle: () => void) => {
          if (done) return;
          done = true; clearTimeout(timer); signal.removeEventListener("abort", abort); settle();
        };
        const abort = () => finish(() => reject(new Error("Sign-in cancelled")));
        signal.addEventListener("abort", abort, { once: true });
        channel.onmessage = event => {
          const data = event.data as { type?: unknown; url?: unknown } | null;
          if (!data || data.type !== OIDC_CHANNEL || typeof data.url !== "string") return;
          try { if (stateOf(data.url) !== expected) return; } catch { return; }
          finish(() => resolve(data.url as string));
        };
        popup.location.href = url;
      });
    },
    close() {
      done = true;
      channel.close();
      try { if (popup && !popup.closed) popup.close(); } catch { /* Another origin's page: it closes itself. */ }
    },
  };
}
