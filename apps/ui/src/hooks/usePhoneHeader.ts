import { useEffect, useLayoutEffect, useState } from "react";
import { touchOnly } from "../lib/touchOnly";

/** A phone held upright: a chat's header keeps the name, a call and ⋮ there, and the rest is in the ⋮ menu. */
export const PHONE_HEADER_QUERY = "(max-width: 480px)";
/** The same header for a chat's pane as narrow as that phone: a phone on its side beside the chat list, a tablet upright. */
export const PHONE_HEADER_PANE = 480;
/** The narrowest phones (320px): a group's header moves its Share link into ⋮, so the name keeps room to be told apart. */
export const NARROW_PHONE_QUERY = "(max-width: 340px)";

function useMedia(media: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(media).matches);

  useEffect(() => {
    const query = window.matchMedia(media);
    const onChange = () => setMatches(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [media]);

  return matches;
}

/**
 * The phone's header, by the window or by the chat's `pane`. By the window alone, a phone on its side (844x390 with an
 * iPhone's safe areas) left the chat a 330 px pane beside the list with every button in its header, and the name cut
 * to "Con…"; upright at 390 px it showed whole. A pane not laid out (0: a chat kept loaded off screen) keeps its last.
 * By the pane only on a touch screen: a Desktop window at its default 900x700 leaves the chat a 479 px pane too, and
 * keeps the desktop's header there, its video call in the row.
 */
export function usePhoneHeader(pane?: HTMLElement | null): boolean {
  const phone = useMedia(PHONE_HEADER_QUERY);
  const [narrowPane, setNarrowPane] = useState(false);
  useLayoutEffect(() => {
    if (!pane || !touchOnly()) return;
    const measure = () => { if (pane.clientWidth > 0) setNarrowPane(pane.clientWidth <= PHONE_HEADER_PANE); };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [pane]);
  return phone || narrowPane;
}
export const useNarrowPhone = (): boolean => useMedia(NARROW_PHONE_QUERY);
