import Link from "next/link";
import { Shell } from "@/components/site/Shell";
import { catalog } from "@/content/catalog";
import { isListed, wisps } from "@/lib/wisps";
import { Glossary } from "./Glossary";
import { OldAnchors } from "./OldAnchors";
import { WispMap, legacyIds } from "./WispMap";
import "@/app/catalog.css";

/** The WISPs page: a short hero, then the layers. Each tile opens its WISP, whose sidebar lists the rest. */
export function CatalogPage() {
  const t = catalog;
  // Drafts the page does not draw, by every id an old link may use, so `#wisp-…` can open their page.
  const drafts = Object.fromEntries(wisps.filter((w) => !isListed(w)).flatMap((w) => [w.id, ...legacyIds(w)].map((id) => [id, w.slug])));

  return (
    <Shell>
      <section className="catalog-hero">
        <div className="wrap">
          <span className="eyebrow">{t.eyebrow}</span>
          <h1 className="h-section">{t.title}</h1>
          <p className="lead">{t.lead}</p>
          <p className="catalog-next">
            {t.next} <Link href={"/roadmap"}>{t.roadmap} →</Link>
          </p>
        </div>
      </section>
      <div className="wrap">
        <WispMap t={t} />
        <Glossary t={t.glossary} />
      </div>
      <OldAnchors drafts={drafts} />
    </Shell>
  );
}
