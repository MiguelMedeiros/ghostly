import Link from "next/link";
import { Shell } from "@/components/site/Shell";
import { Icon } from "@/components/site/icons";
import { LevelBadge } from "@/components/site/Level";
import { Reveal } from "@/components/home/Reveal";
import { developers } from "@/content/developers";
import { href, type Locale } from "@/lib/i18n";
import { wisps, wispCount } from "@/lib/wisps";
import snippets from "@/lib/code-snippets.json";
import { REPO_URL } from "@/content/shell";
import { BlockGrid } from "./BlockGrid";
import { Negotiation } from "./Negotiation";
import { DevHeroArt } from "./DevHeroArt";
import "@/app/developers.css";

/**
 * The hero title breaks in three lines on wide screens: title1 before its last
 * two words ("Ghost is small" / "on purpose.", "O Ghost é pequeno" / "de propósito."),
 * then title2 on its own line. Titles with fewer than three words stay whole.
 */
function splitBeforeLastTwoWords(s: string): [string, string] {
  const words = s.trim().split(/\s+/);
  if (words.length < 3) return [s, ""];
  return [words.slice(0, -2).join(" "), words.slice(-2).join(" ")];
}

export function DevelopersPage({ locale }: { locale: Locale }) {
  const t = developers[locale];
  const wispRefs = wisps.map((w) => ({ slug: w.slug, number: w.number, name: w.name }));
  const [titleA, titleB] = splitBeforeLastTwoWords(t.hero.title1);
  return (
    <Shell locale={locale}>
      <section className="dv-hero">
        <div className="wrap dv-hero-grid">
          <div className="dv-hero-copy">
            <span className="eyebrow">{t.hero.eyebrow}</span>
            <h1 className="h-display dv-hero-title">
              {titleA}
              {titleB && (
                <>
                  <br className="dv-hero-br" /> {titleB}
                </>
              )}{" "}
              <span className="accent dv-hero-t2">{t.hero.title2}</span>
            </h1>
            <p className="lead">{t.hero.lead}</p>
            <div className="dv-hero-actions">
              <Link className="btn btn--primary" href={href(locale, "/developers/wisps/01-ghost-core")}>
                {t.hero.ctaCore} →
              </Link>
              <Link className="btn dv-btn-sm" href={href(locale, "/developers/catalog")}>
                {t.hero.ctaCatalog.replace("{n}", String(wispCount))}
              </Link>
              <a className="btn dv-btn-sm" href={REPO_URL}>
                <Icon name="code" /> {t.hero.ctaCode}
              </a>
            </div>
          </div>
          <DevHeroArt />
        </div>
      </section>

      <section className="dv-sec dv-sec--words" id="vocabulary">
        <div className="wrap">
          <Reveal className="section-head">
            <span className="eyebrow">{t.words.eyebrow}</span>
            <h2 className="h-section">{t.words.title}</h2>
            <p className="lead">{t.words.lead}</p>
          </Reveal>
          <dl className="dv-dl">
            {t.words.items.map((w) => (
              <Reveal as="div" key={w.id} className="dv-term">
                <dt className="dv-term-name">{w.term}</dt>
                <dd className="dv-term-says">{w.says}</dd>
                <dd className="dv-term-body">{w.body}</dd>
                <dd className="dv-term-example">
                  {"level" in w && w.level ? <LevelBadge level={w.level} locale={locale} small /> : <span className="caption">{w.example}</span>}
                </dd>
              </Reveal>
            ))}
          </dl>
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
            <p className="lead">{t.path.lead}</p>
          </Reveal>
          <ol className="dv-path">
            {t.path.steps.map((s, i) => (
              <Reveal as="article" key={s.title} className="dv-step">
                <div className="dv-step-head">
                  <span className="dv-step-num mono" aria-hidden="true">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <h3 className="h-card dv-step-title">{s.title}</h3>
                </div>
                <p className="body dv-step-body">{s.body}</p>
                {"code" in s && s.code && (
                  <figure className="dv-step-code path-code">
                    <pre>
                      <code>{snippets.createLink.code}</code>
                    </pre>
                    <figcaption className="caption">
                      <a href={`${REPO_URL}/blob/dev/${snippets.createLink.file}#L${snippets.createLink.line}`}>{t.path.codeCaption}</a>
                    </figcaption>
                  </figure>
                )}
                <ul className="dv-step-links">
                  {s.links.map((l) => (
                    <li key={l.href}>
                      {l.href.startsWith("http") ? (
                        <a className="link-arrow" href={l.href}>
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
