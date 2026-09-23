"use client";

import { useEffect, useState } from "react";

/**
 * prefers-reduced-motion, read after hydration so the first client render
 * matches the server's (which can't know the preference).
 */
export function useCalm(): boolean {
  const [calm, setCalm] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setCalm(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return calm;
}
