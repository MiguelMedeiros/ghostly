/**
 * A touch screen with no mouse or trackpad (a phone, a tablet on its own): there, giving a text field the focus
 * brings up the on-screen keyboard, over half the screen. The app then leaves a field for the person to tap when
 * it opens something (a chat, the reactions); with a mouse or trackpad (a laptop, an iPad with its keyboard) it
 * puts the caret there as before.
 */
export function touchOnly(): boolean {
  try {
    return matchMedia("(any-pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;
  } catch {
    return false;
  }
}
