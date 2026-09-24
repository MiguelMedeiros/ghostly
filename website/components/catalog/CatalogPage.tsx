import Link from "next/link";
import { Shell } from "@/components/site/Shell";
import { catalog } from "@/content/catalog";
import { href, type Locale } from "@/lib/i18n";
import numbering from "@/lib/wisp-numbering.json";
import candidates from "@/lib/roadmap-candidates.json";
import { GROUPS, wisps, wispCount } from "@/lib/wisps";
import { Catalog, type CatalogRow } from "./Catalog";
import { WispMap } from "./WispMap";
import "@/app/catalog.css";

export function CatalogPage({ locale }: { locale: Locale }) {
  const t = catalog[locale];
  const rows: CatalogRow[] = wisps.map((w) => {
    const old = numbering.find((n) => n.file === w.file)?.oldId;
    // Old numeric fragments stay only where no current draft uses the same id.
    const legacyIds = old && old !== w.id && /^\d+$/.test(old) && !wisps.some((x) => x.id === old) ? [old] : [];
    return {
      id: w.id,
      number: w.number,
      assigned: w.assigned,
      kind: w.kind,
      slug: w.slug,
      name: w.name,
      group: w.group,
      parent: w.parent,
      status: w.status,
      benefit: w.benefit?.[locale],
      note: w.note?.[locale],
      implementation: w.implementation,
      level: w.level,
      legacyIds,
    };
  });
  const groups = GROUPS.map((g) => ({ id: g.id, title: g.title[locale], blurb: g.blurb[locale], icon: g.icon }));

  return (
    <Shell locale={locale}>
      <section className="catalog-hero">
        <div className="wrap">
          <span className="eyebrow">{t.eyebrow}</span>
          <h1 className="h-section">{t.title}</h1>
          <p className="lead">{t.lead.replace("{n}", String(wispCount))}</p>
        </div>
      </section>
      <div className="wrap">
        <WispMap t={t} locale={locale} />
        <h2 className="h-card catalog-list-title" id="list">
          {t.listTitle}
        </h2>
        <p className="catalog-axes">
          <span className="chip">Draft</span> {t.axes}
        </p>
        <Catalog rows={rows} groups={groups} t={t} locale={locale} />

        <section className="catalog-inventory" id="inventory" aria-labelledby="inventory-title">
          <h2 id="inventory-title" className="h-card">
            {t.inventory.title}
          </h2>
          <p className="muted">{t.inventory.lead}</p>
          <ul className="inventory-list">
            {candidates.map((c) => (
              <li key={c.id} id={c.id}>
                <Link href={`${href(locale, "/roadmap")}#${c.id}`}>{c.title}</Link>
                <span className="dim mono">{c.status}</span>
              </li>
            ))}
          </ul>
          <p>
            <Link className="link-arrow" href={href(locale, "/roadmap")}>
              {t.inventory.cta} →
            </Link>
            <span className="dim"> · {t.sources}: </span>
            <Link href={href(locale, "/developers/wisps/readme")}>README</Link>
            <span className="dim"> · </span>
            <Link href={href(locale, "/developers/wisps/numbering")}>NUMBERING</Link>
            <span className="dim"> · </span>
            <Link href={href(locale, "/developers/wisps/implementation")}>IMPLEMENTATION</Link>
          </p>
        </section>
      </div>
    </Shell>
  );
}
