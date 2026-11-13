import { getBrowserHost } from "@ghostly/browser/host";

/**
 * Whether the Android app's window is secure (the host's `hideFromSwitcher`): kept out of the app switcher's picture,
 * screenshots, screen recording and screen sharing, with the activity's cover over the page while the app is away.
 * It is while the app lock is on, and while a secret (a wallet's recovery phrase) is on screen whatever the lock: each
 * holder counts, and the window stops being secure only once the lock is off and the last one has let go.
 */
let lockOn = false;
let secrets = 0;

function tell() {
  try { void getBrowserHost().hideFromSwitcher?.(lockOn || secrets > 0).catch(() => {}); } catch { /* no host */ }
}

/** The app lock is on (set and enabled), or off. */
export function lockSecuresWindow(on: boolean) {
  lockOn = on;
  tell();
}

/** A secret goes on screen: the window is secure until the returned function lets go of it. */
export function holdSecureWindow(): () => void {
  secrets++;
  tell();
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    secrets--;
    tell();
  };
}
