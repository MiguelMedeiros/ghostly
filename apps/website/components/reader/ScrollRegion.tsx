"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A table box or code block that is a keyboard stop (and, with a name, a region) only while it really scrolls. The
 * server HTML keeps the stop, so without scripts a wide one can still be scrolled from the keyboard; once on the
 * page, one that fits the column leaves the tab order and says nothing about scrolling.
 */
export function ScrollRegion({
  as: Tag,
  className,
  name,
  children,
}: {
  as: "div" | "pre";
  className?: string;
  name?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement & HTMLPreElement>(null);
  const [scrolls, setScrolls] = useState(true);
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const check = () => setScrolls(box.scrollWidth > box.clientWidth || box.scrollHeight > box.clientHeight);
    // The box keeps its width when only what is inside it grows (a web font arriving), so the content is watched too.
    const observer = new ResizeObserver(check);
    observer.observe(box);
    if (box.firstElementChild) observer.observe(box.firstElementChild);
    check();
    let live = true;
    void document.fonts?.ready.then(() => live && check());
    return () => {
      live = false;
      observer.disconnect();
    };
  }, []);
  return (
    <Tag
      ref={ref}
      className={className}
      tabIndex={scrolls ? 0 : undefined}
      role={scrolls && name ? "region" : undefined}
      aria-label={scrolls ? name : undefined}
    >
      {children}
    </Tag>
  );
}
