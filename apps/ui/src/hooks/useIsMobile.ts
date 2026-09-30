import { useEffect, useState } from "react";

/** Below this width the app shows one screen at a time, like a phone messenger. */
export const MOBILE_QUERY = "(max-width: 767px)";

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
