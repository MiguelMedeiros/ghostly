/**
 * A touch screen with no mouse or trackpad (a phone, a tablet on its own): there, giving a text field the focus
 * brings up the on-screen keyboard, over half the screen. The app then leaves a field for the person to tap when
 * it opens something (a chat, the reactions); with a mouse or trackpad (a laptop, an iPad with its keyboard) it
 * puts the caret there as before. The Android app is touch only whatever the pointer query says: an emulator, and some
 * phones, report a fine pointer too.
 */
export function touchOnly(): boolean {
  if (androidApp()) return true;
  try {
    return matchMedia("(any-pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;
  } catch {
    return false;
  }
}

/** The native Android app (apps/desktop built for Android), not a browser on Android. */
export function androidApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && /Android/i.test(navigator.userAgent);
}
