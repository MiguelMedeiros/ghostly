"use client";

import { useEffect, useRef, useState } from "react";

/** Fades a block in the first time it enters the viewport. Content is visible without JS. */
export function Reveal({ children, className = "", id, as: Tag = "div" }: { children: React.ReactNode; className?: string; id?: string; as?: "div" | "section" | "article" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"idle" | "hidden" | "shown">("idle");
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight) return;
    setState("hidden");
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setState("shown");
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Tag ref={ref as React.Ref<HTMLDivElement>} id={id} className={`reveal ${className}`} data-reveal={state}>
      {children}
    </Tag>
  );
}
