import { useEffect, useRef, useState } from "react";

/** Animates a number towards `value`. Jumps straight there when motion is reduced or on first render. */
export function useCountUp(value: number, durationMs = 700): number {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);

  useEffect(() => {
    const from = shownRef.current;
    const reduce =
      document.documentElement.dataset.reduceMotion === "true" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (from === value || reduce) {
      shownRef.current = value;
      setShown(value);
      return;
    }
    const startedAt = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - startedAt) / durationMs);
      const eased = 1 - (1 - t) ** 3;
      shownRef.current = Math.round(from + (value - from) * eased);
      setShown(shownRef.current);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, durationMs]);

  return shown;
}
