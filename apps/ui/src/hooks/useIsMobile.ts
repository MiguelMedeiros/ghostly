import { useEffect, useState } from "react";

/** Below this width the app shows one screen at a time, like a phone messenger. `<` and not `max-width: 767px`: at a
 * zoom or a display scale that is not whole a window is 767.33px wide, which `max-width: 767px` misses and Tailwind's
 * `max-md` (the same `width < 768px`) takes. */
export const MOBILE_QUERY = "(width < 768px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);

  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
