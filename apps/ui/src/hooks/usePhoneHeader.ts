import { useEffect, useState } from "react";

/** A phone held upright: a chat's header keeps the name, a call and ⋮ there, and the rest is in the ⋮ menu. */
export const PHONE_HEADER_QUERY = "(max-width: 480px)";
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

export const usePhoneHeader = (): boolean => useMedia(PHONE_HEADER_QUERY);
export const useNarrowPhone = (): boolean => useMedia(NARROW_PHONE_QUERY);
