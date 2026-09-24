import Link from "next/link";
import { Shell } from "@/components/site/Shell";
import { LevelBadge } from "@/components/site/Level";
import { Ghost } from "@/components/ghost/Ghost";
import { Reveal } from "@/components/home/Reveal";
import { ReferenceMarkdown } from "@/components/reader/Markdown";
import { candidateLevel, roadmap } from "@/content/roadmap";
import { href, type Locale } from "@/lib/i18n";
import candidates from "@/lib/roadmap-candidates.json";
import { timeline } from "@/content/roadmap-timeline";
import { wisps } from "@/lib/wisps";
import { BlockGrid } from "@/components/dev/BlockGrid";
import { Timeline } from "./Timeline";
import "@/app/developers.css";
import "@/app/roadmap.css";

export function RoadmapPage({ locale }: { locale: Locale }) {
  const t = roadmap[locale];
  const sections = [...new Set(candidates.map((c) => c.section))];
  const titleOf = (id: string) => t.tracks.find((x) => x.id === id);
  const tl = timeline[locale];
  const wispRefs = wisps.map((w) => ({ slug: w.slug, number: w.number, name: w.name }));
  return (
    <Shell locale={locale}>
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
        <BlockGrid mode="stages" t={tl.grid} locale={locale} wisps={wispRefs} />
      </section>

      <section className="wrap rm-block" id="timeline" aria-labelledby="timeline-title">
        <h2 id="timeline-title" className="h-card">
          {tl.timelineTitle}
        </h2>
        <p className="muted">{tl.timelineLead}</p>
        <Timeline locale={locale} />
      </section>

      <section className="wrap rm-tracks" aria-label={t.eyebrow}>
        <details className="rm-details">
          <summary>{tl.detailsTitle}</summary>
        <ol>
          {t.tracks.map((track) => (
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
                          <LevelBadge level={i.level} locale={locale} small /> <span>{i.text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h3>{t.next}</h3>
                    <ul>
                      {track.next.map((i) => (
                        <li key={i.text}>
                          <LevelBadge level={i.level} locale={locale} small /> <span>{i.text}</span>
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
        <p className="lead">{t.inventory.lead}</p>
        {sections.map((section) => (
          <div key={section} className="rm-section">
            <h3>{section}</h3>
            <ul>
              {candidates
                .filter((c) => c.section === section)
                .map((c) => (
                  <li key={c.id} id={c.id}>
                    <details>
                      <summary>
                        <span className="rm-cand-title">{c.title}</span>
                        <span className="dim mono rm-cand-kind">{c.kind}</span>
                        <LevelBadge level={candidateLevel(c.id, c.status)} locale={locale} small />
                      </summary>
                      <div className="rm-cand-body" lang="en">
                        <p className="dim mono">
                          {c.status} · {t.inventory.sourceStatus}
                        </p>
                        <ReferenceMarkdown body={c.body} sourcePath="docs/wisps/ADAPTER-ROADMAP.md" locale={locale} idPrefix={`${c.id}-`} />
                      </div>
                    </details>
                  </li>
                ))}
            </ul>
          </div>
        ))}
        <p>
          <Link className="link-arrow" href={href(locale, "/developers/wisps/adapter-roadmap")}>
            {t.inventory.source} →
          </Link>
        </p>
      </section>
    </Shell>
  );
}
