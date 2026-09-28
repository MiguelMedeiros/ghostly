"use client";

import { useEffect } from "react";

/**
 * Links made for the old full list keep landing somewhere useful. A `#wisp-…` of a draft the page no longer
 * draws (planned or research) opens that draft's own page; the adapter inventory, `#inventory` and its
 * `#candidate-…` rows, moved to the roadmap. Anchors the page still has are left to the browser.
 */
export function OldAnchors({ drafts }: { drafts: Record<string, string> }) {
  useEffect(() => {
    const follow = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id || document.getElementById(id)) return;
      const slug = id.startsWith("wisp-") ? drafts[id.slice(5)] : undefined;
      if (slug) window.location.replace(`/wisps/${slug}`);
      else if (id === "inventory") window.location.replace("/roadmap#inventory-title");
      else if (id.startsWith("candidate-")) window.location.replace(`/roadmap#${id}`);
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [drafts]);
  return null;
}
