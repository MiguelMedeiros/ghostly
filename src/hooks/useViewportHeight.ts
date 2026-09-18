import { useEffect } from "react";

/**
 * Keeps `--app-height` equal to the part of the screen that is really visible.
 * iOS does not shrink the layout viewport when the keyboard opens, so without
 * this the message input ends up underneath it.
 */
export function useViewportHeight() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const update = () => {
      document.documentElement.style.setProperty("--app-height", `${viewport.height}px`);
      // With the keyboard up the home indicator is covered, so its inset must not pad the input.
      document.documentElement.dataset.keyboard = String(window.innerHeight - viewport.height > 120);
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
