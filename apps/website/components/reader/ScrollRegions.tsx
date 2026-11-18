"use client";

import { useEffect, useRef } from "react";

/**
 * A rendered article (one HTML string) whose table boxes and code blocks (`data-scroll-region`, the table's name as
 * its value) are a keyboard stop, and with a name a region, only while they really scroll. The server HTML keeps the
 * stop, so without scripts a wide one can still be scrolled from the keyboard; once on the page, one that fits the
 * column leaves the tab order and says nothing about scrolling.
 */
export function ScrollRegions({ html, className, lang }: { html: string; className?: string; lang?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const boxes = [...root.querySelectorAll<HTMLElement>("[data-scroll-region]")];
    const set = (box: HTMLElement, attribute: string, value: string | null) =>
      value === null ? box.removeAttribute(attribute) : box.setAttribute(attribute, value);
    const check = (box: HTMLElement) => {
      const scrolls = box.scrollWidth > box.clientWidth || box.scrollHeight > box.clientHeight;
      const name = box.dataset.scrollRegion || null;
      set(box, "tabindex", scrolls ? "0" : null);
      set(box, "role", scrolls && name ? "region" : null);
      set(box, "aria-label", scrolls ? name : null);
    };
    // The box keeps its width when only what is inside it grows (a web font arriving), so the content is watched too.
    const owner = new Map<Element, HTMLElement>();
    const observer = new ResizeObserver((entries) => new Set(entries.map((e) => owner.get(e.target)!)).forEach(check));
    for (const box of boxes) {
      for (const target of [box, box.firstElementChild]) {
        if (!target) continue;
        owner.set(target, box);
        observer.observe(target);
      }
      check(box);
    }
    let live = true;
    void document.fonts?.ready.then(() => live && boxes.forEach(check));
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [html]);
  return <div ref={ref} className={className} lang={lang} dangerouslySetInnerHTML={{ __html: html }} />;
}
