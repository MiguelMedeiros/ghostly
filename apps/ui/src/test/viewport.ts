import { vi } from "vitest";
import { MOBILE_QUERY } from "../hooks/useIsMobile";

/** The window as wide as a phone (below 768px) or not: `useIsMobile` asks `matchMedia`. Undone by `vi.restoreAllMocks()`. */
export function windowIs(phone: boolean) {
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) =>
    query === MOBILE_QUERY ? ({ ...matchMedia(query), matches: phone, addEventListener: () => {}, removeEventListener: () => {} } as MediaQueryList) : matchMedia(query));
}
