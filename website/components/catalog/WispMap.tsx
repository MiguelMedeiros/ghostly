import Link from "next/link";
import { Icon } from "@/components/site/icons";
import { href, type Locale } from "@/lib/i18n";
import { LEVELS } from "@/lib/status";
import { GROUPS, wisps } from "@/lib/wisps";
import { shell } from "@/content/shell";
import type { CatalogCopy } from "@/content/catalog";

// Short labels for tiles; the full title is on the reader page and in the list.
function short(name: string) {
  return name
    .replace(/^(WISP process and document format)$/i, "Process")
    .replace(/ (Protocol|Negotiation|Messaging|Contract)$/i, "")
    .replace(/^Implemented Invitation Profiles$/i, "Invitation formats")
    .replace(/^Legacy Timestamp Chat$/i, "Legacy chat")
    .replace(/^Bounded DHT Text$/i, "DHT text")
    .replace(/^Identity Proofs \/ Peer Proofs$|^Peer Proofs$/i, "Identity proofs")
    .replace(/^Ark payments via Arkade$/i, "Ark · Arkade")
    .replace(/^HTTP Local Service Profile$/i, "HTTP services")
    .replace(/^Group Session$/i, "Group sessions")
    .replace(/^S3-Compatible Storage$/i, "S3 storage")
    .replace(/^Local File Storage$/i, "Local file");
}

/**
 * The catalog at a glance: one card per family, one tile per draft. The big
 * tile is the family's contract; small tiles are adapters and profiles. The
 * tile's color says whether what it describes runs in the app.
 */
export function WispMap({ t, locale }: { t: CatalogCopy; locale: Locale }) {
  const levels = shell[locale].levels;
  const counts = LEVELS.map((l) => ({ l, n: wisps.filter((w) => w.level === l).length })).filter((c) => c.n);
  return (
    <div className="wmap">
      <div className="wmap-stats">
        <p className="wmap-total">
          <strong>{wisps.length}</strong> {t.map.drafts}
        </p>
        {counts.map(({ l, n }) => (
          <p key={l} className="wmap-stat" data-level={l}>
            <strong>{n}</strong> {levels[l].toLowerCase()}
          </p>
        ))}
      </div>
      <ul className="wmap-how">
        <li>
          <span className="wmap-demo wmap-demo--big" /> {t.map.contract}
        </li>
        <li>
          <span className="wmap-demo" /> {t.map.adapter}
        </li>
        <li>
          <span className="wmap-demo wmap-demo--color" /> {t.map.color}
        </li>
      </ul>
      <div className="wmap-grid">
        {GROUPS.map((g) => {
          const items = wisps.filter((w) => w.group === g.id);
          if (!items.length) return null;
          // A contract that others implement gets the wide tile; its adapters follow.
          const isLead = (id: string) => items.some((x) => x.parent === id);
          return (
            <section key={g.id} className="wmap-family" aria-labelledby={`wmap-${g.id}`}>
              <header>
                <Icon name={g.icon} />
                <h3 id={`wmap-${g.id}`}>{g.title[locale]}</h3>
              </header>
              <ul className="wmap-tiles">
                {items.map((w) => (
                  <li key={w.id} className={isLead(w.id) ? "wmap-tile-wrap wmap-tile-wrap--lead" : "wmap-tile-wrap"}>
                    <Link
                      href={href(locale, `/developers/wisps/${w.slug}`)}
                      className="wmap-tile"
                      data-level={w.level ?? "none"}
                      data-kind={w.kind}
                      title={`${w.number} · ${w.name}${w.level ? ` — ${levels[w.level]}` : ""}`}
                    >
                      <span className="wmap-num mono">{w.number}</span>
                      <span className="wmap-name">{short(w.name)}</span>
                      <span className="sr-only">{w.level ? levels[w.level] : t.process}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
