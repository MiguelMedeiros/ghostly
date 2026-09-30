"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Opens every closed <details> around the element a hash names, then scrolls to it: the inventory's
 * categories, an entry's notes and the tracks all start closed, and a link into them (the catalog's
 * `/roadmap#candidate-…`, a track's "Builds on") would otherwise land on nothing.
 */
function reveal(hash: string) {
  if (!hash || hash.length < 2) return;
  let target: HTMLElement | null = null;
  try {
    target = document.getElementById(decodeURIComponent(hash.slice(1)));
  } catch {
    return;
  }
  if (!target) return;
  let opened = false;
  for (let d = target.parentElement?.closest("details"); d; d = d.parentElement?.closest("details")) {
    if (!d.open) {
      d.open = true;
      opened = true;
    }
  }
  // Already in sight: the browser's own jump to the hash did the work.
  if (!opened) return;
  requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
}

/** "Open all" / "Close all" for the inventory's categories, and the hash reveal for the whole page. */
export function InventoryControls({ openAll, closeAll }: { openAll: string; closeAll: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const [allOpen, setAllOpen] = useState(false);

  const categories = useCallback(
    () => [...(button.current?.closest("section")?.querySelectorAll<HTMLDetailsElement>("details.rm-cat") ?? [])],
    [],
  );

  useEffect(() => {
    const section = button.current?.closest("section");
    const sync = () => setAllOpen(categories().every((d) => d.open));
    // `toggle` does not bubble: listen in the capture phase.
    section?.addEventListener("toggle", sync, true);
    const onHash = () => reveal(location.hash);
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onHash);
    onHash();
    // A client navigation can set the hash after the first effect: look once more.
    const frame = requestAnimationFrame(onHash);
    return () => {
      section?.removeEventListener("toggle", sync, true);
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
      cancelAnimationFrame(frame);
    };
  }, [categories]);

  return (
    <button
      ref={button}
      type="button"
      className="rm-cat-all"
      data-testid="inventory-toggle-all"
      onClick={() => {
        const open = !allOpen;
        for (const d of categories()) d.open = open;
        setAllOpen(open);
      }}
    >
      {allOpen ? closeAll : openAll}
    </button>
  );
}
