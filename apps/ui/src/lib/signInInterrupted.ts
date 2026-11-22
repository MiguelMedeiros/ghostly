/**
 * An identity sign-in the Android app lost: Android ended the app's process while the provider's page was in the
 * browser, and the answer started a new one, whose page never asked for it (apps/desktop/src/oidc.rs `not_taken`).
 * The Identities page says so once, with Try again.
 */
export const SIGN_IN_INTERRUPTED_EVENT = "ghostly-sign-in-interrupted";

let interrupted = false;

export function signInInterrupted(): void {
  interrupted = true;
  window.dispatchEvent(new Event(SIGN_IN_INTERRUPTED_EVENT));
}

/** Whether a sign-in was interrupted, taken: said once. */
export function takeSignInInterrupted(): boolean {
  const was = interrupted;
  interrupted = false;
  return was;
}
