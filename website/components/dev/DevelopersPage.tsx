import Link from "next/link";
import { Shell } from "@/components/site/Shell";
import { Icon } from "@/components/site/icons";
import { LevelBadge } from "@/components/site/Level";
import { Reveal } from "@/components/home/Reveal";
import { developers } from "@/content/developers";
import { href, type Locale } from "@/lib/i18n";
import { wisps, wispCount } from "@/lib/wisps";
import { REPO_URL } from "@/content/shell";
import { BlockGrid } from "./BlockGrid";
import { Negotiation } from "./Negotiation";
import { ProtocolLoop } from "./ProtocolLoop";
import "@/app/developers.css";

export function DevelopersPage({ locale }: { locale: Locale }) {
  const t = developers[locale];
  const wispRefs = wisps.map((w) => ({ slug: w.slug, number: w.number, name: w.name }));
  return (
    <Shell locale={locale}>
      <section className="dvx-hero">
        <div className="wrap">
          <div className="dvx-head">
            <span className="eyebrow">{t.hero.eyebrow}</span>
            <h1 className="h-display dvx-title">{t.hero.title}</h1>
            <div className="dvx-sub">
              <p className="lead">{t.hero.lead}</p>
              <div className="dvx-actions">
                <Link className="btn btn--primary" href={href(locale, "/developers/wisps/01-ghost-core")}>
                  {t.hero.ctaCore} →
                </Link>
                <Link className="btn dv-btn-sm" href={href(locale, "/developers/catalog")}>
                  {t.hero.ctaCatalog.replace("{n}", String(wispCount))}
                </Link>
                <a className="dvx-gh" href={REPO_URL}>
                  <Icon name="code" /> {t.hero.ctaCode}
                </a>
              </div>
            </div>
          </div>
          <ProtocolLoop t={t.hero.loop} />
        </div>
      </section>

      <section className="dv-sec dv-sec--compose dv-band" id="compose">
        <div className="wrap">
          <Reveal className="section-head">
            <span className="eyebrow">{t.compose.eyebrow}</span>
            <h2 className="h-section">{t.compose.title}</h2>
            <p className="lead">{t.compose.lead}</p>
          </Reveal>
          <BlockGrid mode="compose" t={t.compose} locale={locale} wisps={wispRefs} />
        </div>
      </section>

      <section className="dv-sec dv-sec--negotiate" id="negotiate">
        <div className="wrap">
          <Reveal className="section-head">
            <span className="eyebrow">{t.negotiate.eyebrow}</span>
            <h2 className="h-section">{t.negotiate.title}</h2>
            <p className="lead">{t.negotiate.lead}</p>
          </Reveal>
          <Negotiation t={t.negotiate} />
        </div>
      </section>

      <section className="dv-sec dv-sec--path" id="path">
        <div className="wrap">
          <Reveal className="section-head">
            <span className="eyebrow">{t.path.eyebrow}</span>
            <h2 className="h-section">{t.path.title}</h2>
          </Reveal>
          <ol className="dvx-path">
            {t.path.steps.map((s, i) => (
              <Reveal as="article" key={s.title} className="dvx-step">
                <span className="dvx-step-num mono" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="dvx-step-title">{s.title}</h3>
                <p className="dvx-step-body">{s.body}</p>
                <ul className="dvx-step-links">
                  {s.links.map((l) => (
                    <li key={l.href}>
                      {l.href.startsWith("http") ? (
                        <a className="link-arrow mono" href={l.href}>
                          {l.label} ↗
                        </a>
                      ) : (
                        <Link className="link-arrow" href={l.href}>
                          {l.label} →
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      <section className="dv-sec dv-sec--avail" id="availability">
        <div className="wrap">
          <Reveal className="section-head">
            <span className="eyebrow">{t.availability.eyebrow}</span>
            <h2 className="h-section">{t.availability.title}</h2>
            <p className="lead">{t.availability.lead}</p>
          </Reveal>
          <div className="avail-scroll" tabIndex={0} role="region" aria-label={t.availability.title}>
            <table className="avail">
              <thead>
                <tr>
                  <th scope="col">{t.availability.feature}</th>
                  {t.availability.clients.map((c) => (
                    <th scope="col" key={c}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {t.availability.rows.map((r) => (
                  <tr key={r.name}>
                    <th scope="row">{r.name}</th>
                    {r.cells.map((c, i) => (
                      <td key={i}>{c ? <LevelBadge level={c} locale={locale} small /> : <span className="dim" aria-label="not supported">{t.availability.none}</span>}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="avail-notes">
            {t.availability.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="dv-sec dv-sec--next">
        <div className="wrap devnext">
          {(["catalog", "roadmap", "docs"] as const).map((k) => (
            <Reveal as="article" key={k} className="card devnext-card">
              <h3 className="h-card">{t.next[k].title}</h3>
              <p className="muted">{t.next[k].body}</p>
              <Link className="link-arrow" href={k === "docs" ? "/docs" : href(locale, k === "catalog" ? "/developers/catalog" : "/roadmap")}>
                {t.next[k].cta} →
              </Link>
            </Reveal>
          ))}
        </div>
      </section>
    </Shell>
  );
}
