import type { OidcWindow } from './flow';

/**
 * The web app's sign-in window, and the static callback page it returns to.
 * The provider's answer arrives in the fragment of `/oidc-callback.html`, so it
 * never reaches a server, not even Ghostly's. The page passes it to the tab
 * that asked over a same-origin BroadcastChannel (a provider's
 * Cross-Origin-Opener-Policy cuts `window.opener`), or, for the desktop app,
 * forwards it to the app's listener on 127.0.0.1.
 */

export const OIDC_CHANNEL = 'ghostly-oidc';
export const CALLBACK_PATH = '/oidc-callback.html';
/** Where the desktop app's sign-in returns before reaching its loopback listener. */
export const DESKTOP_RELAY = 'https://app.ghostly.tools/oidc-callback.html';
const WAIT_MS = 10 * 60_000;
const DESKTOP_STATE = /^d\.(\d{1,5})\.[A-Za-z0-9_-]{43}$/;

function stateOf(url: string): string | null {
  const u = new URL(url);
  return new URLSearchParams(u.hash.slice(1)).get('state') ?? u.searchParams.get('state');
}

/** What the callback page does with the address it was opened at. */
export function routeCallback(href: string): { kind: 'desktop'; target: string } | { kind: 'tab'; url: string } | { kind: 'none' } {
  const url = new URL(href);
  const state = stateOf(href);
  if (!state) return { kind: 'none' };
  const desktop = DESKTOP_STATE.exec(state);
  if (desktop) {
    const port = Number(desktop[1]);
    if (port < 1024 || port > 65535) return { kind: 'none' };
    return { kind: 'desktop', target: `http://127.0.0.1:${port}/oidc-callback${url.search}${url.hash}` };
  }
  return { kind: 'tab', url: href };
}

/**
 * Opens the popup at once (from the click) on a blank page of this origin,
 * and points it at the provider when the request is ready.
 */
export function popupWindow(origin = location.origin): OidcWindow {
  const popup = window.open('about:blank', 'ghostly-oidc', 'popup,width=520,height=720');
  const channel = new BroadcastChannel(OIDC_CHANNEL);
  let done = false;
  return {
    redirectUri: `${origin}${CALLBACK_PATH}`,
    authorize(url, signal) {
      if (!popup) return Promise.reject(new Error('Allow pop-ups for Ghostly to sign in.'));
      const expected = new URL(url).searchParams.get('state');
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => finish(() => reject(new Error('Sign-in timed out. Try again.'))), WAIT_MS);
        const finish = (settle: () => void) => {
          if (done) return;
          done = true; clearTimeout(timer); signal.removeEventListener('abort', abort); settle();
        };
        const abort = () => finish(() => reject(new Error('Sign-in cancelled')));
        signal.addEventListener('abort', abort, { once: true });
        channel.onmessage = event => {
          const data = event.data as { type?: unknown; url?: unknown } | null;
          if (!data || data.type !== OIDC_CHANNEL || typeof data.url !== 'string') return;
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
