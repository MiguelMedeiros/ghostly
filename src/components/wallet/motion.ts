/** The person asked for less motion: in the app's settings, or in the system's. */
export const reducedMotion = () => typeof window !== "undefined"
  && (document.documentElement.dataset.reduceMotion === "true" || window.matchMedia("(prefers-reduced-motion: reduce)").matches);

/**
 * A wallet just made comes into its deck like a card dealt onto the table: from a little above, settling where it
 * sits. Added on top of where the deck puts it (`composite: "add"`), so it ends exactly at rest; nothing moves with
 * reduced motion.
 */
export function dealCard(face: HTMLElement | null) {
  if (!face || reducedMotion() || typeof face.animate !== "function") return;
  face.animate([{ transform: "translate(0, -34px) rotate(-3deg)" }, { transform: "translate(0, 0) rotate(0deg)" }], { duration: 560, easing: "cubic-bezier(.22,1,.36,1)", composite: "add" });
  face.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: "ease-out" });
}
