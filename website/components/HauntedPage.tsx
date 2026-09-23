"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { MotionConfig, motion, useInView } from "motion/react";

const HauntContext = createContext({
  enabled: false,
  paused: false,
  toggle: () => {},
});

export function useHaunting() {
  return useContext(HauntContext);
}

function subscribeReducedMotion(notify: () => void) {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
}
const readReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function HauntedPage({ children }: { children: ReactNode }) {
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    readReducedMotion,
    () => true,
  );
  const [mounted, setMounted] = useState(false);
  const [paused, setPaused] = useState(false);
  useEffect(() => setMounted(true), []);
  const enabled = mounted && !reducedMotion && !paused;

  return (
    <HauntContext.Provider
      value={{ enabled, paused, toggle: () => setPaused((value) => !value) }}
    >
      <MotionConfig reducedMotion="user">
        <div className="landing" data-motion={enabled ? "playing" : "paused"}>
          {children}
        </div>
      </MotionConfig>
    </HauntContext.Provider>
  );
}

export function MotionToggle() {
  const { enabled, paused, toggle } = useHaunting();
  return (
    <button
      className="motion-toggle"
      type="button"
      onClick={toggle}
      aria-pressed={paused}
      aria-label={paused ? "Resume animations" : "Pause animations"}
      title={paused ? "Wake the ghosts" : "Let the ghosts rest"}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        {enabled ? (
          <>
            <rect x="5" y="4" width="3" height="12" rx="1" />
            <rect x="12" y="4" width="3" height="12" rx="1" />
          </>
        ) : (
          <path d="M6 3.5 16 10 6 16.5z" />
        )}
      </svg>
      <span>{paused ? "Wake the ghosts" : "Pause the haunting"}</span>
    </button>
  );
}

export function Reveal({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.08 });
  const { enabled } = useHaunting();
  return (
    <motion.div
      ref={ref}
      initial={false}
      animate={
        enabled && !inView ? { opacity: 0, y: 24 } : { opacity: 1, y: 0 }
      }
      transition={{ duration: enabled ? 0.6 : 0, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}
