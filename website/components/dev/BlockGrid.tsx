"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { BLOCKS, DIMS, PRESETS, type Block, type PresetId } from "@/lib/composition";
import { href, type Locale } from "@/lib/i18n";
import { LEVELS, RELEASED_VERSION, type Level } from "@/lib/status";
import { LevelBadge } from "@/components/site/Level";
import { shell } from "@/content/shell";
import { useCalm } from "@/lib/useCalm";

type WispRef = { slug: string; number: string; name: string };

export type GridLabels = {
  presets: string;
  selectHint: string;
  enables: string;
  specs: string;
  noSpec: string;
  docs: string;
  included: string;
  close: string;
  /** "+{n} over v{v}": how many pieces a composition adds to the public release. */
  added?: string;
  stages?: { title: string; play: string; pause: string; names: Record<Level, string> };
};

/** Reader titles for reference documents, and for drafts the numbered catalogue does not list yet. */
const REF_NAMES: Record<string, string> = {
  "usdt-integration": "USDT integration",
  "adapter-roadmap": "Adapter roadmap",
  sdk: "Ghostly SDK",
  "4xx-store-and-forward": "Store-and-forward for an away contact",
  "9xx-group-mesh": "Group mesh distribution profile",
};

const RELEASED_COUNT = BLOCKS.filter((bl) => bl.level === "released").length;
const PRESET_COUNTS = Object.fromEntries(PRESETS.map((p) => [p.id, BLOCKS.filter(p.blocks).length])) as Record<PresetId, number>;

/**
 * The architecture as a flat grid: one row per area, one block per piece.
 * On /developers a composition lights the blocks it uses; on /roadmap the
 * stages light them in the order they arrive. Selecting a block opens its
 * details right under its row.
 */
export function BlockGrid({
  mode,
  t,
  locale,
  wisps,
}: {
  mode: "compose" | "stages";
  t: GridLabels;
  locale: Locale;
  wisps: WispRef[];
}) {
  const calm = useCalm();
  const [preset, setPreset] = useState<PresetId>("minimal");
  const [stage, setStage] = useState(mode === "stages" ? 0 : LEVELS.length - 1);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const on = useMemo(() => {
    if (mode === "compose") return new Set(BLOCKS.filter(PRESETS.find((p) => p.id === preset)!.blocks).map((bl) => bl.id));
    return new Set(BLOCKS.filter((bl) => LEVELS.indexOf(bl.level) <= stage).map((bl) => bl.id));
  }, [mode, preset, stage]);

  // "Play" walks the stages one by one, then stops on the last.
  useEffect(() => {
    if (!playing) return;
    if (stage >= LEVELS.length - 1) {
      setPlaying(false);
      return;
    }
    const id = window.setTimeout(() => setStage((s) => s + 1), calm ? 0 : 1300);
    return () => window.clearTimeout(id);
  }, [playing, stage, calm]);

  const levels = shell[locale].levels;
  const count = t.included.replace("{n}", String(on.size)).replace("{t}", String(BLOCKS.length));
  // The next release, measured against the public one: the step it is.
  const added =
    mode === "compose" && preset === "next" && t.added
      ? t.added.replace("{n}", String(on.size - RELEASED_COUNT)).replace("{v}", RELEASED_VERSION)
      : null;

  const detail = (bl: Block) => {
    const hasRefs = bl.wisps.length > 0 || (bl.refs?.length ?? 0) > 0;
    return (
      <div className="bgrid-detail" role="region" aria-label={bl.name}>
        <div className="bgrid-detail-head">
          <h4>{bl.name}</h4>
          <LevelBadge level={bl.level} locale={locale} small />
          <button type="button" className="bgrid-close" onClick={() => setSelected(null)} aria-label={t.close}>
            ×
          </button>
        </div>
        <p>{bl.enables[locale]}</p>
        <p className="bgrid-specs">
          <span className="dim">
            {bl.wisps.length ? t.specs : t.noSpec}
            {hasRefs ? ":" : "."}
          </span>{" "}
          {bl.wisps.map((slug) => {
            const w = wisps.find((x) => x.slug === slug);
            // A draft the numbered catalogue does not list yet still has a reader page.
            const number = w?.number ?? slug.split("-")[0];
            const name = w?.name ?? REF_NAMES[slug];
            return name ? (
              <Link key={slug} href={href(locale, `/developers/wisps/${slug}`)}>
                <span className="mono">{number}</span> {name}
              </Link>
            ) : null;
          })}
          {bl.refs?.map((slug) => (
            <Link key={slug} href={href(locale, `/developers/wisps/${slug}`)}>
              {t.docs}: {REF_NAMES[slug] ?? slug}
            </Link>
          ))}
        </p>
      </div>
    );
  };

  return (
    <div className="bgrid" data-mode={mode}>
      {mode === "compose" ? (
        <div className="bgrid-controls">
          <div className="composer-presets" role="radiogroup" aria-label={t.presets}>
            {PRESETS.map((p) => (
              <button key={p.id} role="radio" aria-checked={p.id === preset} className="preset" onClick={() => setPreset(p.id)}>
                {p.title[locale]}
                <span className="bgrid-preset-n mono" aria-hidden="true">
                  {PRESET_COUNTS[p.id]}
                </span>
              </button>
            ))}
          </div>
          <p className="composer-blurb">
            {PRESETS.find((p) => p.id === preset)!.blurb[locale]}{" "}
            <span className="bgrid-count mono">
              <span className="dim">· {count}</span>
              {added ? <span className="bgrid-delta"> · {added}</span> : null}
            </span>
          </p>
        </div>
      ) : (
        <div className="bgrid-controls">
          <div className="stage-rail" role="radiogroup" aria-label={t.stages!.title}>
            {LEVELS.map((l, i) => (
              <button
                key={l}
                role="radio"
                aria-checked={i === stage}
                className="stage-node"
                data-level={l}
                data-passed={i <= stage}
                onClick={() => {
                  setPlaying(false);
                  setStage(i);
                }}
              >
                <span className="stage-dot" />
                <span className="stage-name">{t.stages!.names[l]}</span>
              </button>
            ))}
          </div>
          <p className="composer-blurb">
            <button
              type="button"
              className="stage-play"
              onClick={() => {
                if (playing) setPlaying(false);
                else {
                  if (stage >= LEVELS.length - 1) setStage(0);
                  setPlaying(true);
                }
              }}
            >
              {playing ? `❚❚ ${t.stages!.pause}` : `▶ ${t.stages!.play}`}
            </button>{" "}
            <span className="dim mono">{count}</span>
          </p>
        </div>
      )}

      <div className="bgrid-rows">
        {DIMS.map((d) => {
          const blocks = BLOCKS.filter((bl) => bl.dim === d.id);
          const open = blocks.find((bl) => bl.id === selected);
          return (
            <div className="bgrid-row" key={d.id} style={{ "--c": d.color } as React.CSSProperties}>
              <div className="bgrid-dim">
                <span className="bgrid-dim-dot" aria-hidden="true" />
                {d.title[locale]}
              </div>
              <div className="bgrid-blocks">
                {blocks.map((bl) => (
                  <button
                    key={bl.id}
                    type="button"
                    className="bgrid-block"
                    data-on={on.has(bl.id)}
                    data-level={bl.level}
                    aria-expanded={selected === bl.id}
                    onClick={() => setSelected(selected === bl.id ? null : bl.id)}
                  >
                    <span className="bgrid-name">{bl.name}</span>
                    <span className="bgrid-level" data-level={bl.level}>
                      {levels[bl.level]}
                    </span>
                  </button>
                ))}
              </div>
              {open && detail(open)}
            </div>
          );
        })}
      </div>
      <p className="bgrid-hint dim">{t.selectHint}</p>
    </div>
  );
}
