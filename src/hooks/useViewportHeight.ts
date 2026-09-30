import { useEffect } from "react";
import { isStandalone } from "../lib/installPrompt";

/** How much of the screen a keyboard takes, at least: a toolbar that slides away is less. */
const KEYBOARD = 120;
/** What a hardware keyboard's shortcut bar takes (an iPad's, an iPhone's: 55 to 70px), at least, while a field has the focus. */
const SHORTCUT_BAR = 24;

/** A field the keyboard types into: a hardware keyboard shows iOS's shortcut bar over the page for it. */
const typedInto = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLElement && element.matches("input:not([type=checkbox], [type=radio], [type=range], [type=button], [type=submit], [type=file]), textarea, select, [contenteditable]:not([contenteditable=false])");

/**
 * Keeps `--app-height` equal to the part of the screen that is really visible.
 * iOS does not shrink the layout viewport when the keyboard opens, so without
 * this the message input ends up underneath it.
 *
 * `data-keyboard` on `<html>` says whether a keyboard is up. Safari keeps `innerHeight` while it is, so the
 * gap between the two heights says it there; Android's resizes-content and an installed iPhone web app shrink
 * `innerHeight` with it, so the visible height is also compared with the tallest one seen at this width.
 * With a hardware keyboard, iOS shows only its shortcut bar while a field has the focus: 55 to 70px, less than a
 * keyboard, and the message field was under it in two panes (an iPad, an iPhone on its side). It counts as one
 * while a field has the focus; without one, a gap that small is a toolbar sliding away.
 *
 * `data-standalone` says the app runs installed: iOS 26 needs the document to be as tall as the screen there
 * (src/index.css).
 */
export function useViewportHeight() {
  useEffect(() => {
    document.documentElement.dataset.standalone = String(isStandalone());
    const viewport = window.visualViewport;
    if (!viewport) return;

    let width = viewport.width;
    let tallest = viewport.height;
    // The shortcut bar seen while this field has had the focus, and whether the screen has turned since.
    let bar = 0;
    let turned = false;
    let visible = viewport.height;
    const update = () => {
      const typing = typedInto(document.activeElement);
      if (!typing) { bar = 0; turned = false; }
      // A new width is a rotation (or a resized window): what was tallest before says nothing now.
      if (viewport.width !== width) {
        width = viewport.width;
        tallest = viewport.height;
        if (bar) turned = true;
      }
      tallest = Math.max(tallest, viewport.height);
      const measured = Math.max(window.innerHeight - viewport.height, tallest - viewport.height);
      let covered = measured;
      if (typing && measured > SHORTCUT_BAR && measured <= KEYBOARD) bar = measured;
      // Once the screen has turned with the bar up, iOS reports the whole height again a moment later and keeps it,
      // while the bar stays over the message field until the field loses the focus (iOS 26 Simulator, iPhone).
      else if (typing && turned && measured <= SHORTCUT_BAR) covered = bar;
      visible = viewport.height - (covered - measured);
      document.documentElement.style.setProperty("--app-height", `${visible}px`);
      const keyboard = covered > KEYBOARD || (covered > SHORTCUT_BAR && typing);
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
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    // The shortcut bar's height counts only while a field has the focus: the answer can change with no resize.
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, []);
}
