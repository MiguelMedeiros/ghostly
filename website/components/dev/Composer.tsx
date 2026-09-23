"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { BLOCKS, DIMS, PRESETS, type PresetId } from "@/lib/composition";
import { href, type Locale } from "@/lib/i18n";
import { LevelBadge } from "@/components/site/Level";
import type { DevCopy } from "@/content/developers";

type WispRef = { slug: string; number: string; name: string };

/**
 * The architecture as an isometric board: one row per dimension, one block per
 * piece. A composition raises the blocks it uses; selecting a block explains it.
 * The board is decoration for sighted mouse users; the same information is a
 * keyboard-reachable list of buttons and a live panel.
 */
export function Composer({ t, locale, wisps }: { t: DevCopy["compose"]; locale: Locale; wisps: WispRef[] }) {
  const [preset, setPreset] = useState<PresetId>("minimal");
  const [selected, setSelected] = useState("core");
  const active = PRESETS.find((p) => p.id === preset)!;
  const on = useMemo(() => new Set(BLOCKS.filter(active.blocks).map((bl) => bl.id)), [active]);
  const block = BLOCKS.find((bl) => bl.id === selected)!;
  const dim = DIMS.find((d) => d.id === block.dim)!;

  return (
    <div className="composer">
      <div className="composer-presets" role="radiogroup" aria-label={t.presets}>
        {PRESETS.map((p) => (
          <button key={p.id} role="radio" aria-checked={p.id === preset} className="preset" onClick={() => setPreset(p.id)}>
            {p.title[locale]}
          </button>
        ))}
      </div>
      <p className="composer-blurb">
        {active.blurb[locale]} <span className="dim mono">· {t.included.replace("{n}", String(on.size)).replace("{t}", String(BLOCKS.length))}</span>
      </p>

      <div className="composer-main">
        <div className="board-wrap">
          <div className="board" aria-label={t.boardLabel} role="group">
            {DIMS.map((d, row) => (
              <div className="board-row" key={d.id} style={{ "--row": row } as React.CSSProperties}>
                {BLOCKS.filter((bl) => bl.dim === d.id).map((bl) => (
                  <button
                    key={bl.id}
                    className="block"
                    data-on={on.has(bl.id)}
                    data-level={bl.level}
                    aria-pressed={selected === bl.id}
                    aria-label={`${bl.name} — ${d.title[locale]}`}
                    style={{ "--c": d.color } as React.CSSProperties}
                    onClick={() => setSelected(bl.id)}
                  >
                    <span className="block-top">
                      <span className="block-name">{bl.name}</span>
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>

        <aside className="composer-panel" aria-live="polite">
          <span className="composer-dim" style={{ color: dim.color }}>
            {dim.title[locale]}
          </span>
          <h3>{block.name}</h3>
          <LevelBadge level={block.level} locale={locale} />
          <h4>{t.enables}</h4>
          <p>{block.enables[locale]}</p>
          <h4>{block.wisps.length ? t.specs : t.noSpec}</h4>
          <ul className="composer-links">
            {block.wisps.map((slug) => {
              const w = wisps.find((x) => x.slug === slug);
              return w ? (
                <li key={slug}>
                  <Link href={href(locale, `/developers/wisps/${slug}`)}>
                    <span className="mono">{w.number}</span> {w.name}
                  </Link>
                </li>
              ) : null;
            })}
            {block.refs?.map((slug) => (
              <li key={slug}>
                <Link href={href(locale, `/developers/wisps/${slug}`)}>
                  <span className="mono">{t.docs}</span> {slug === "usdt-integration" ? "USDT integration" : "Adapter roadmap"}
                </Link>
              </li>
            ))}
          </ul>
          <p className="composer-hint dim">{t.selectHint} ↖</p>
        </aside>
      </div>

      <ul className="composer-legend">
        {DIMS.map((d) => (
          <li key={d.id}>
            <span style={{ background: d.color }} aria-hidden="true" /> {d.title[locale]}
          </li>
        ))}
      </ul>
    </div>
  );
}
