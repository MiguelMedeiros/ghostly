/**
 * A page the browser brings back from its back/forward cache is the page that left: on `pagehide`
 * it said goodbye to its contacts and stopped its peer, and nothing in it starts one again, so no
 * chat would ever go live. It is loaded anew instead.
 */
export function restartWhenRestored(target: Window = window, restart: () => void = () => target.location.reload()): () => void {
  const shown = (e: PageTransitionEvent) => { if (e.persisted) restart(); };
  target.addEventListener("pageshow", shown);
  return () => target.removeEventListener("pageshow", shown);
}
