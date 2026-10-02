/** The person asked for less motion: in the app's settings, or in the system's. */
export const reducedMotion = () => typeof window !== "undefined"
  && (document.documentElement.dataset.reduceMotion === "true" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true);

/** Brings an element into view: a smooth scroll, or a jump when the person asked for less motion. */
export function scrollIntoViewGently(el: Element | null | undefined, block: ScrollLogicalPosition = "center") {
  el?.scrollIntoView?.({ block, behavior: reducedMotion() ? "auto" : "smooth" });
}
