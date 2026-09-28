import Link from "next/link";
import { Shell } from "@/components/site/Shell";
import { LevelBadge } from "@/components/site/Level";
import { Ghost } from "@/components/ghost/Ghost";
import { Reveal } from "@/components/home/Reveal";
import { ReferenceMarkdown } from "@/components/reader/Markdown";
import { roadmap } from "@/content/roadmap";
import { LEVELS, type Level } from "@/lib/status";
import { shell } from "@/content/shell";
import candidates from "@/lib/roadmap-candidates.json";
import { timeline } from "@/content/roadmap-timeline";
import { isListed, wisps } from "@/lib/wisps";
import { roadmapTracks } from "@/lib/roadmap";
import { BlockGrid } from "@/components/dev/BlockGrid";
import { Timeline } from "./Timeline";
import { InventoryControls } from "./InventoryControls";
import "@/app/developers.css";
import "@/app/roadmap.css";

export function RoadmapPage() {
  const t = roadmap;
  const sections = [...new Set(candidates.map((c) => c.section))];
  const titleOf = (id: string) => roadmapTracks.find((x) => x.id === id);
  const tl = timeline;
  const wispRefs = wisps.map((w) => ({ slug: w.slug, number: w.number, name: w.name }));
  const ahead = wisps.filter((w) => !isListed(w));
  return (
    <Shell>
      <section className="rm-hero">
        <div className="wrap rm-hero-grid">
          <div className="rm-hero-copy">
            <span className="eyebrow">{t.eyebrow}</span>
            <h1 className="h-section">{t.title}</h1>
            <p className="lead">{t.lead}</p>
            <ul className="rm-rules">
              {t.rules.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
          <div className="rm-growth" aria-hidden="true">
            {[0.55, 0.75, 1].map((s, i) => (
              <div key={i} className="rm-growth-step" style={{ "--s": s } as React.CSSProperties}>
                <Ghost who={i === 2 ? "casper" : "boo"} size={Math.round(56 * s + 30)} mood={i === 0 ? "curious" : i === 1 ? "talk" : "happy"} phase={i} />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="wrap rm-block" id="map" aria-labelledby="map-title">
        <h2 id="map-title" className="h-card">
          {tl.mapTitle}
        </h2>
        <p className="muted">{tl.mapLead}</p>
        <BlockGrid mode="stages" t={tl.grid} wisps={wispRefs} />
        {ahead.length > 0 && (
          <div className="rm-drafts">
            <h3>{t.drafts}</h3>
            <ul>
              {ahead.map((w) => (
                <li key={w.id}>
                  {w.level && <LevelBadge level={w.level} small />}
                  <Link href={`/wisps/${w.slug}`}>
                    <span className="mono">{w.number}</span> {w.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="wrap rm-block" id="timeline" aria-labelledby="timeline-title">
        <h2 id="timeline-title" className="h-card">
          {tl.timelineTitle}
        </h2>
        <p className="muted">{tl.timelineLead}</p>
        <Timeline />
      </section>

      <section className="wrap rm-tracks" aria-label={t.eyebrow}>
        <details className="rm-details">
          <summary>{tl.detailsTitle}</summary>
        <ol>
          {roadmapTracks.map((track) => (
            <Reveal as="article" key={track.id} className="rm-track" id={track.id}>
              <div className="rm-track-num mono" aria-hidden="true">
                {track.n}
              </div>
              <div className="rm-track-body">
                <h2>{track.title}</h2>
                <p className="muted">{track.why}</p>
                <div className="rm-cols">
                  <div>
                    <h3>{t.now}</h3>
                    <ul>
                      {track.now.map((i) => (
                        <li key={i.text}>
                          <LevelBadge level={i.level} small /> <span>{i.text}</span>
                        </li>
                      ))}
                      {track.now.length === 0 && (
                        <li>
                          <LevelBadge level="planned" small /> <span>{t.nothing}</span>
                        </li>
                      )}
                    </ul>
                  </div>
                  <div>
                    <h3>{t.next}</h3>
                    <ul>
                      {track.next.map((i) => (
                        <li key={i.text}>
                          <LevelBadge level={i.level} small /> <span>{i.text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
                <p className="rm-gate">
                  <strong>{t.gate}:</strong> {track.gate}
                </p>
                {track.after.length > 0 && (
                  <p className="rm-after">
                    {t.after}:{" "}
                    {track.after.map((a, i) => (
                      <span key={a}>
                        {i > 0 && " · "}
                        <a href={`#${a}`}>
                          {titleOf(a)?.n} {titleOf(a)?.title}
                        </a>
                      </span>
                    ))}
                  </p>
                )}
              </div>
            </Reveal>
          ))}
        </ol>
        </details>
      </section>

      <section className="wrap rm-inventory" aria-labelledby="inventory-title">
        <h2 id="inventory-title" className="h-section" style={{ fontSize: "clamp(28px,3.4vw,44px)" }}>
          {t.inventory.title}
        </h2>
        <div className="rm-inventory-head">
          <p className="lead">{t.inventory.lead}</p>
          <InventoryControls openAll={t.inventory.openAll} closeAll={t.inventory.closeAll} />
        </div>
        <div className="rm-cats">
          {sections.map((section) => {
            const rows = candidates.filter((c) => c.section === section);
            return (
              <details key={section} className="rm-section rm-cat">
                <summary>
                  <svg className="rm-cat-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                    <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <h3>{section}</h3>
                  <span className="rm-cat-sum">
                    <span className="dim mono rm-cat-count">
                      {rows.length} {t.inventory.entries}
                    </span>
                    {LEVELS.map((level) => {
                      const n = rows.filter((c) => c.level === level).length;
                      return n > 0 ? (
                        <span key={level} className="level level--sm" data-level={level} title={shell.levelHelp[level]}>
                          {n} {shell.levels[level]}
                        </span>
                      ) : null;
                    })}
                  </span>
                </summary>
                <ul>
                  {rows.map((c) => (
                    <li key={c.id} id={c.id}>
                      <details>
                        <summary>
                          <span className="rm-cand-head">
                            <span className="rm-cand-title">{c.title}</span>
                            {c.note && (
                              <span className="rm-cand-note">
                                {c.status in t.inventory.states && `${t.inventory.states[c.status as keyof typeof t.inventory.states]}: `}
                                <span lang="en">{c.note}</span>
                              </span>
                            )}
                          </span>
                          <span className="dim mono rm-cand-kind">{c.kind}</span>
                          <LevelBadge level={c.level as Level} small />
                        </summary>
                        <div className="rm-cand-body" lang="en">
                          <p className="dim mono">
                            {c.note ? `${c.status}: ${c.note}` : c.status} · {t.inventory.sourceStatus}
                          </p>
                          <ReferenceMarkdown body={c.body} sourcePath="docs/wisps/ADAPTER-ROADMAP.md" idPrefix={`${c.id}-`} />
                        </div>
                      </details>
                    </li>
                  ))}
                </ul>
              </details>
            );
          })}
        </div>
        <p>
          <Link className="link-arrow" href={"/wisps/adapter-roadmap"}>
            {t.inventory.source} →
          </Link>
        </p>
      </section>
    </Shell>
  );
}
