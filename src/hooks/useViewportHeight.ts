import { useEffect } from "react";
import { isStandalone } from "../lib/installPrompt";

/** How much of the screen a keyboard takes, at least: a toolbar that slides away is less. */
const KEYBOARD = 120;

/**
 * Keeps `--app-height` equal to the part of the screen that is really visible.
 * iOS does not shrink the layout viewport when the keyboard opens, so without
 * this the message input ends up underneath it.
 *
 * `data-keyboard` on `<html>` says whether a keyboard is up. Safari keeps `innerHeight` while it is, so the
 * gap between the two heights says it there; Android's resizes-content and an installed iPhone web app shrink
 * `innerHeight` with it, so the visible height is also compared with the tallest one seen at this width.
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
    const update = () => {
      // A new width is a rotation (or a resized window): what was tallest before says nothing now.
      if (viewport.width !== width) {
        width = viewport.width;
        tallest = viewport.height;
      }
      tallest = Math.max(tallest, viewport.height);
      document.documentElement.style.setProperty("--app-height", `${viewport.height}px`);
      const keyboard = window.innerHeight - viewport.height > KEYBOARD || tallest - viewport.height > KEYBOARD;
      // With the keyboard up the home indicator is covered, so its inset must not pad the input.
      document.documentElement.dataset.keyboard = String(keyboard);
      // iOS scrolls the page to reveal the focused input; the shell already fits.
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
}
