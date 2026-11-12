import { useEffect } from "react";
import { isStandalone } from "../lib/installPrompt";

/** How much of the screen a keyboard takes, at least: a toolbar that slides away is less. */
const KEYBOARD = 120;
/** What a hardware keyboard's shortcut bar takes (an iPad's, an iPhone's: 55 to 70px), at least, while a field has the focus. */
const SHORTCUT_BAR = 24;
/** When the visible height is measured again after the page shows (ms), past what iOS may still report then. */
const RESETTLE_MS = [100, 400, 1000];

/** A field the keyboard types into: a hardware keyboard shows iOS's shortcut bar over the page for it. */
const typedInto = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLElement && element.matches("input:not([type=checkbox], [type=radio], [type=range], [type=button], [type=submit], [type=file]), textarea, select, [contenteditable]:not([contenteditable=false])");

/**
 * What reads `--app-height` (index.css, and `data-app-height` in components/LockScreen.tsx). The value is written on
 * these and nowhere else: index.css registers it as not inherited, since an inherited value on `<html>` restyled the
 * whole document at each change of the visible height, about 60ms in WebKit with a long chat open.
 */
export const APP_HEIGHT_READERS = ".app-shell, .two-pane, dialog, .sheet, .toast-place, .fixed.inset-0, .chat-app-panel, [data-app-height]";

/**
 * Keeps `--app-height` equal to the part of the screen that is really visible, on each element that reads it
 * (`APP_HEIGHT_READERS`, one that appears later included). iOS does not shrink the layout viewport when the keyboard
 * opens, so without this the message input ends up underneath it.
 *
 * `data-keyboard` on `<html>` says whether a keyboard is up. Safari keeps `innerHeight` while it is, so the
 * gap between the two heights says it there; Android's resizes-content and an installed iPhone web app shrink
 * `innerHeight` with it, so the visible height is also compared with the tallest one seen at this width.
 * With a hardware keyboard, iOS shows only its shortcut bar while a field has the focus: 55 to 70px, less than a
 * keyboard, and the message field was under it in two panes (an iPad, an iPhone on its side). It counts as one
 * while a field has the focus; without one, a gap that small is a toolbar sliding away.
 *
 * `data-standalone` says the app runs installed: iOS 26 needs the document to be as tall as the screen there
 * (apps/ui/src/index.css).
 *
 * A pinch does not zoom the page (index.css: `touch-action: pan-x pan-y` on touch screens): a zoomed page left the
 * app zoomed, its visible height wrong, and a picture zooms in its own viewer (components/AvatarViewer.tsx). Safari
 * sends its pinch as `gesture*` events too, and an older iOS honours only their `preventDefault` for it.
 */
export function useViewportHeight() {
  useEffect(() => {
    const noPagePinch = (e: Event) => e.preventDefault();
    document.addEventListener("gesturestart", noPagePinch);
    document.addEventListener("gesturechange", noPagePinch);
    return () => {
      document.removeEventListener("gesturestart", noPagePinch);
      document.removeEventListener("gesturechange", noPagePinch);
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.standalone = String(isStandalone());
    const viewport = window.visualViewport;
    if (!viewport) return;
    // No touch screen, no keyboard on it: a laptop or desktop window made shorter while a field has the focus (another
    // window stacked under it, at 200 % zoom in the phone layout) hid the tab bar until the window was resized again.
    const touch = (navigator.maxTouchPoints ?? 0) > 0;

    let width = viewport.width;
    // The tallest visible height seen at each width: turned back to a width, the keyboard is measured against the
    // whole height seen there, not the one it left.
    const tallest = new Map([[width, viewport.height]]);
    // The shortcut bar seen while this field has had the focus, and whether the screen has turned since.
    let bar = 0;
    let turned = false;
    // Whether a keyboard (not the shortcut bar alone) was up.
    let up = false;
    // The height at a turn with the keyboard up, where the page shrinks with it, to a width with no taller height seen:
    // nothing measures the keyboard there, so it stays up until the height grows or the field loses the focus.
    let carried = 0;
    let visible = viewport.height;
    let written = "";
    const write = (element: Element) => (element as HTMLElement).style.setProperty("--app-height", written);
    // A sheet, a dialog or a toast that opens later gets the height too, the keyboard up included.
    const appeared = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(APP_HEIGHT_READERS)) write(node);
        node.querySelectorAll(APP_HEIGHT_READERS).forEach(write);
      }
    });
    appeared.observe(document.body, { childList: true, subtree: true });
    const update = (event?: Event) => {
      const typing = typedInto(document.activeElement);
      // A field in an app's frame has the focus as the frame itself.
      const mayType = typing || document.activeElement instanceof HTMLIFrameElement;
      if (!typing) { bar = 0; turned = false; }
      if (!mayType) carried = 0;
      // A new width is a rotation (or a resized window): what was tallest at another width says nothing now.
      if (viewport.width !== width) {
        width = viewport.width;
        if (bar) turned = true;
        carried = mayType && up && (tallest.get(width) ?? 0) <= viewport.height ? viewport.height : 0;
        // And a panel can become a sheet at the new width (the emoji panel does) with the same height: written again.
        written = "";
      }
      if (viewport.height > carried) carried = 0;
      // No keyboard comes up with nothing to type into: a window made shorter (split screen, a quarter of the
      // screen, devtools docked) is the whole height there now, or the phone tab bar stayed hidden under 768px.
      const whole = !mayType && event?.type === "resize" ? viewport.height : Math.max(tallest.get(width) ?? 0, viewport.height);
      tallest.set(width, whole);
      const measured = touch ? Math.max(window.innerHeight - viewport.height, whole - viewport.height) : 0;
      let covered = measured;
      if (typing && measured > SHORTCUT_BAR && measured <= KEYBOARD) bar = measured;
      // Once the screen has turned with the bar up, iOS reports the whole height again a moment later and keeps it,
      // while the bar stays over the message field until the field loses the focus (iOS 26 Simulator, iPhone).
      else if (typing && turned && measured <= SHORTCUT_BAR) covered = bar;
      visible = viewport.height - (covered - measured);
      if (`${visible}px` !== written) {
        written = `${visible}px`;
        document.querySelectorAll(APP_HEIGHT_READERS).forEach(write);
      }
      up = covered > KEYBOARD || carried > 0;
      const keyboard = up || (covered > SHORTCUT_BAR && typing);
      // With the keyboard up the home indicator is covered, so its inset must not pad the input.
      document.documentElement.dataset.keyboard = String(keyboard);
      // iOS scrolls the page to reveal the focused input; the shell already fits.
      if (window.scrollY !== 0) window.scrollTo(0, 0);
      if (keyboard) requestAnimationFrame(reveal);
    };
    // The keyboard opens after the field has the focus, and the page the field is in only gets shorter then: a
    // field low on it (a setting, a form in a page) stays where it was, under the keyboard. Once the shell has
    // its new height, it is brought into what is left, and only then: nothing moves for a field already in view.
    const reveal = () => {
      const field = document.activeElement;
      if (!typedInto(field)) return;
      const box = field.getBoundingClientRect();
      if (box.top < 0 || box.bottom > visible) field.scrollIntoView({ block: "center" });
    };
    // Back from the background (an installed iPhone app switched away from with the keyboard up): iOS takes the
    // keyboard down while the page hears nothing, or gives it the keyboard's height for a moment as it shows again
    // and the whole one a little later with no event. Kept, the list ended halfway down the screen and the tab bar
    // stayed hidden. Measured again as the page shows, and while iOS settles.
    let settling: number[] = [];
    const shown = () => {
      if (document.visibilityState === "hidden") return;
      settling.forEach(clearTimeout);
      update();
      settling = RESETTLE_MS.map((ms) => window.setTimeout(update, ms));
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    // The shortcut bar's height counts only while a field has the focus: the answer can change with no resize.
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    document.addEventListener("visibilitychange", shown);
    window.addEventListener("focus", shown);
    return () => {
      appeared.disconnect();
      settling.forEach(clearTimeout);
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      document.removeEventListener("visibilitychange", shown);
      window.removeEventListener("focus", shown);
    };
  }, []);
}
