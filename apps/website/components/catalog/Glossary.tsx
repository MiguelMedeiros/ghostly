"use client";

import { useEffect, useRef } from "react";
import type { CatalogCopy } from "@/content/catalog";

/**
 * The six words kept apart, folded away until someone looks them up. Opens by
 * itself when the page is reached at `#glossary` (the reader links there).
 */
export function Glossary({ t }: { t: CatalogCopy["glossary"] }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const open = () => {
      if (window.location.hash === "#glossary" && ref.current) ref.current.open = true;
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);
  return (
    <details ref={ref} className="glossary" id="glossary">
      <summary>
        <span className="glossary-title">{t.title}</span>
        <span className="glossary-hint">{t.hint}</span>
      </summary>
      <dl className="glossary-list">
        {t.items.map((w) => (
          <div key={w.id} className={`gl gl--${w.id}`}>
            <dt>
              <span className="gl-key mono">{w.key}</span>
              <span className="gl-term">
                {w.term}
                {w.status && (
                  <span className="level level--sm" data-level="planned">
                    {w.status}
                  </span>
                )}
              </span>
            </dt>
            <dd className="gl-gloss">{w.gloss}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
