"use client";

import { useMediaQuery } from "./useMediaQuery";

export const CALM_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * prefers-reduced-motion. False on the server; the layout script adds
 * `html.calm` before hydration so CSS can carry the still layout meanwhile.
 */
export function useCalm(): boolean {
  return useMediaQuery(CALM_QUERY);
}
