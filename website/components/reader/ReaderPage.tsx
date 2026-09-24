import { readFile } from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import GithubSlugger from "github-slugger";
import { Shell } from "@/components/site/Shell";
import { LevelBadge } from "@/components/site/Level";
import { reader } from "@/content/reader";
import { catalog } from "@/content/catalog";
import { href, type Locale } from "@/lib/i18n";
import numbering from "@/lib/wisp-numbering.json";
import type { Reference } from "@/lib/references";
import { GROUPS, wispByFile, wisps, type Wisp } from "@/lib/wisps";
import { REPO_URL } from "@/content/shell";
import { ReferenceMarkdown } from "./Markdown";
import "@/app/reader.css";

/** h2/h3 headings with the same ids the renderer gives them. */
function outline(body: string) {
  const slugger = new GithubSlugger();
  const items: { depth: number; text: string; id: string }[] = [];
  let fence = false;
  for (const line of body.split("\n")) {
    if (/^```/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    // Same plain text the renderer slugs: links keep their label, emphasis and code marks go, underscores stay.
    const text = m[2].replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*`]/g, "");
    const id = slugger.slug(text);
    if (m[1].length === 2 || m[1].length === 3) items.push({ depth: m[1].length, text, id });
  }
  return items;
}

function WispLink({ w, locale }: { w: Wisp; locale: Locale }) {
  return (
    <Link href={href(locale, `/developers/wisps/${w.slug}`)}>
      <span className="mono">{w.number}</span> {w.name}
    </Link>
  );
}

export async function ReaderPage({ reference, requested, locale }: { reference: Reference; requested: string; locale: Locale }) {
  const t = reader[locale];
  const kinds = catalog[locale].kinds;
  const body = await readFile(path.join(process.cwd(), "public/reference", reference.file), "utf8");
  const w = wispByFile(reference.file);
  const order = wisps.indexOf(w as Wisp);
  const prev = w && order > 0 ? wisps[order - 1] : undefined;
  const next = w && order < wisps.length - 1 ? wisps[order + 1] : undefined;
  const toc = outline(body);
  const deps = ((w?.dependencies ?? []).map((file) => wispByFile(file)).filter(Boolean) as Wisp[]).filter((d) => d.id !== w?.parent);
  const usedBy = w ? wisps.filter((x) => x.dependencies.includes(w.file) && x.parent !== w.id) : [];
  const children = w ? wisps.filter((x) => x.parent === w.id) : [];
  const parent = w?.parent ? wisps.find((x) => x.id === w.parent) : undefined;
  const moved = requested !== reference.slug;
  const former = numbering.find((e) => e.file === reference.file && e.oldFile !== e.file);
  // Old heading anchors (e.g. "#wisp-09--identity-proofs") keep working after renumbering.
  const legacyHeading = former && w ? new GithubSlugger().slug(reference.title.replace(`WISP ${w.number}`, `WISP ${former.oldId}`)) : undefined;
  const sourceUrl = `${REPO_URL}/blob/dev/${reference.sourcePath}`;

  return (
    <Shell locale={locale}>
      <div className="wrap reader">
        <nav className="reader-crumbs" aria-label="Breadcrumb">
          <Link href={href(locale, "/developers")}>{t.developers}</Link>
          <span aria-hidden="true">/</span>
          <Link href={href(locale, "/developers/catalog")}>{t.catalog}</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{w ? `WISP ${w.number}` : t.reference}</span>
        </nav>

        <div className="reader-layout">
          <aside className="reader-side">
            <Link className="reader-glossary" href={`${href(locale, "/developers/catalog")}#glossary`}>
              {t.glossary} →
            </Link>
            <details className="reader-all" open>
              <summary>{t.all}</summary>
              <nav aria-label={t.all}>
                {GROUPS.map((g) => {
                  const items = wisps.filter((x) => x.group === g.id);
                  if (!items.length) return null;
                  return (
                    <div key={g.id} className="reader-all-group">
                      <p>{g.title[locale]}</p>
                      <ul>
                        {items.map((x) => (
                          <li key={x.id} data-child={Boolean(x.parent)}>
                            <Link href={href(locale, `/developers/wisps/${x.slug}`)} aria-current={x.slug === w?.slug ? "page" : undefined}>
                              <span className="mono">{x.number}</span>
                              {x.name}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </nav>
            </details>
          </aside>

          <article className="reader-main">
            <header className="reader-head">
              {w && (
                <p className="reader-number mono" aria-hidden="true">
                  {w.number}
                </p>
              )}
              <h1>{w ? `${w.name}` : reference.title}</h1>
              <div className="reader-chips">
                {w ? (
                  <>
                    <span className="chip">{w.status}</span>
                    <span className="chip">{kinds[w.kind] ?? w.kind}</span>
                    {!w.assigned && <span className="chip chip--warn">{t.unassigned}</span>}
                    {w.level && <LevelBadge level={w.level} locale={locale} />}
                    {w.updated && (
                      <span className="dim reader-updated">
                        {t.updated} {w.updated}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="chip">{t.reference}</span>
                )}
              </div>
              <p className="reader-scope">{w ? t.draftNote : t.supportNote}</p>
              {t.englishDocs && <p className="reader-lang">{t.englishDocs}</p>}
              {moved && <p className="reader-moved">{t.moved}</p>}
            </header>

            {w && (
              <section className="reader-summary" aria-label={t.inShort}>
                <h2 className="reader-summary-title mono">{t.inShort}</h2>
                {w.benefit && <p className="reader-benefit">{w.benefit[locale]}</p>}
                {w.note && <p className="reader-note">{w.note[locale]}</p>}
                {w.notices.map((n) => (
                  <p key={n} className="reader-notice">
                    {n}
                  </p>
                ))}
                <dl className="reader-facts">
                  {w.implementation && (
                    <div>
                      <dt>{t.implementation}</dt>
                      <dd>{w.implementation}</dd>
                    </div>
                  )}
                  {w.feature && (
                    <div>
                      <dt>{t.inApp}</dt>
                      <dd>
                        <Link href={w.feature[locale].href}>{w.feature[locale].label} →</Link>
                      </dd>
                    </div>
                  )}
                  {parent && (
                    <div>
                      <dt>{t.implementsContract}</dt>
                      <dd>
                        <WispLink w={parent} locale={locale} />
                      </dd>
                    </div>
                  )}
                  {deps.length > 0 && (
                    <div>
                      <dt>{t.depends}</dt>
                      <dd className="reader-links">
                        {deps.map((d) => (
                          <WispLink key={d.id} w={d} locale={locale} />
                        ))}
                      </dd>
                    </div>
                  )}
                  {children.length > 0 && (
                    <div>
                      <dt>{t.children}</dt>
                      <dd className="reader-links">
                        {children.map((d) => (
                          <WispLink key={d.id} w={d} locale={locale} />
                        ))}
                      </dd>
                    </div>
                  )}
                  {usedBy.length > 0 && (
                    <div>
                      <dt>{t.usedBy}</dt>
                      <dd className="reader-links">
                        {usedBy.map((d) => (
                          <WispLink key={d.id} w={d} locale={locale} />
                        ))}
                      </dd>
                    </div>
                  )}
                </dl>
                {w.video && (
                  <figure className="reader-video">
                    <figcaption className="mono">{t.video}</figcaption>
                    <video controls preload="metadata" poster={w.video.poster} src={w.video.src} />
                    {w.video.chapters && (
                      <ol>
                        {w.video.chapters.map((c) => (
                          <li key={c.at}>
                            <span className="mono">
                              {Math.floor(c.at / 60)}:{String(c.at % 60).padStart(2, "0")}
                            </span>{" "}
                            {c.title}
                          </li>
                        ))}
                      </ol>
                    )}
                  </figure>
                )}
              </section>
            )}

            {toc.length > 2 && (
              <details className="reader-toc" open>
                <summary>{t.contents}</summary>
                <ol>
                  {toc.map((h) => (
                    <li key={h.id} data-depth={h.depth}>
                      <a href={`#${h.id}`}>{h.text}</a>
                    </li>
                  ))}
                </ol>
              </details>
            )}

            <div className="reader-prose" lang="en">
              {legacyHeading && <span id={legacyHeading} />}
              <ReferenceMarkdown body={body} sourcePath={reference.sourcePath} locale={locale} repoLabel={t.repo} />
            </div>

            <footer className="reader-foot">
              <div className="reader-source">
                <a href={sourceUrl}>{t.source} ↗</a>
                <a href={`/reference/${reference.file}`} download>
                  {t.download} ↓
                </a>
              </div>
              <nav className="reader-pager" aria-label="Continue reading">
                {prev && (
                  <Link href={href(locale, `/developers/wisps/${prev.slug}`)} className="reader-pager-prev">
                    <small>← {t.prev}</small>
                    <span>
                      <span className="mono">{prev.number}</span> {prev.name}
                    </span>
                  </Link>
                )}
                {next && (
                  <Link href={href(locale, `/developers/wisps/${next.slug}`)} className="reader-pager-next">
                    <small>{t.next} →</small>
                    <span>
                      <span className="mono">{next.number}</span> {next.name}
                    </span>
                  </Link>
                )}
              </nav>
              <Link className="link-arrow" href={href(locale, "/developers/catalog")}>
                {t.back}
              </Link>
            </footer>
          </article>
        </div>
      </div>
    </Shell>
  );
}
