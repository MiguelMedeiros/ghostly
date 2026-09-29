import Link from "next/link";
import { Icon } from "@/components/site/icons";
import { GROUPS, listedWisps, wisps, type Wisp } from "@/lib/wisps";
import { LAYERS, type GroupId } from "@/lib/wisp-groups";
import { DIMS } from "@/lib/composition";
import numbering from "@/lib/wisp-numbering.json";
import { shell } from "@/content/shell";
import type { CatalogCopy } from "@/content/catalog";

/** Old numeric anchors (`#wisp-09`) stay only where no current draft uses the same id. */
export function legacyIds(w: Pick<Wisp, "id" | "file">) {
  const old = numbering.find((n) => n.file === w.file)?.oldId;
  return old && old !== w.id && /^\d+$/.test(old) && !wisps.some((x) => x.id === old) ? [old] : [];
}

/** A family's colour, the same as its row on the roadmap's map; a layer takes the colour of its first family. */
const colorOf = (id: GroupId) => DIMS.find((d) => d.id === GROUPS.find((g) => g.id === id)?.dim)?.color ?? "#94a3b8";
const tint = (c: string) => ({ "--c": c }) as React.CSSProperties;

// Short labels for tiles; the full title is on the reader page.
function short(name: string) {
  return name
    .replace(/^(WISP process and document format)$/i, "Process")
    .replace(/ (Protocol|Negotiation|Messaging|Contract)$/i, "")
    .replace(/^Implemented Invitation Profiles$/i, "Invitation formats")
    .replace(/^Compatibility Chat \(v0\.4 Timestamp Profile\)$/i, "Compatibility chat")
    .replace(/^Compatibility File Frames$/i, "Compatibility files")
    .replace(/^DHT Text$/i, "DHT text")
    .replace(/^Identity Proofs \/ Peer Proofs$|^Peer Proofs$/i, "Identity proofs")
    .replace(/^Ark payments via Arkade$/i, "Ark · Arkade")
    .replace(/^HTTP Local Service Profile$/i, "HTTP services")
    .replace(/^Group Session$/i, "Group sessions")
    .replace(/^S3-Compatible Storage$/i, "S3 storage")
    .replace(/^Local File Storage$/i, "Local file")
    .replace(/^Headless Runtime and Local Control API$/i, "Headless runtime")
    .replace(/^Store-and-Forward for an Away Contact$/i, "Store-and-forward")
    .replace(/^Ark payments via Bark$/i, "Ark · Bark")
    .replace(/^Lightning Addresses and LNURL-pay$/i, "Lightning Address")
    .replace(/^Spark payments$/i, "Spark")
    .replace(/^Fedimint ecash .*$/i, "Fedimint")
    .replace(/^Pubky identity .*$/i, "Pubky")
    .replace(/^Provider-attested identity \(OpenID Connect\)$/i, "OpenID Connect")
    .replace(/^AT Protocol identity \(Bluesky\)$/i, "Bluesky")
    .replace(/^Decentralized identifiers \(DIDs\)$/i, "DIDs")
    .replace(/^Profile DID \(did:dht\)$/i, "Profile DID")
    .replace(/^Bitcoin Address Proof$/i, "Bitcoin address")
    .replace(/^Domain Proofs$/i, "Domains")
    .replace(/^Group Mesh Distribution Profile$/i, "Mesh")
    .replace(/^Group Community Distribution Profile$/i, "Communities")
    .replace(/^GossipSub Transport$/i, "GossipSub");
}

/**
 * The WISPs at a glance, drawn as a stack: one band per family, the core at the top and each layer building
 * on the ones above it. Inside a band the tiles run left to right. The big tile is the family's contract;
 * small tiles are adapters and profiles. Each family wears its colour from the roadmap's map. Only what works in the app today is drawn; the rest is on the roadmap.
 * Old links into the page land here: `#list` on the stack, `#family-…` on a band, `#wisp-…` on a tile.
 */
export function WispMap({ t }: { t: CatalogCopy }) {
  const levels = shell.levels;
  return (
    <div className="wmap">
      <p className="wmap-how">
        <span className="wmap-demo wmap-demo--big" aria-hidden="true" /> {t.map.legend}
      </p>
      <ol className="wmap-stack" id="list" aria-label={t.map.stack}>
        {LAYERS.map((layer) => {
          const families = layer.groups.map((id) => GROUPS.find((g) => g.id === id)!).filter((g) => listedWisps.some((w) => w.group === g.id));
          if (!families.length) return null;
          return (
            <li key={layer.label} className="wmap-layer" style={tint(colorOf(layer.groups[0]))}>
              <p className="wmap-layer-label mono">{layer.label}</p>
              <div className="wmap-bands">
                {families.map((g) => {
                  const items = listedWisps.filter((w) => w.group === g.id);
                  // A contract that others implement gets the wide tile; its adapters follow.
                  const isLead = (id: string) => items.some((x) => x.parent === id);
                  return (
                    <section key={g.id} id={`family-${g.id}`} className="wmap-family" data-group={g.id} style={tint(colorOf(g.id))} aria-labelledby={`wmap-${g.id}`}>
                      <header>
                        <Icon name={g.icon} />
                        <h2 id={`wmap-${g.id}`}>{g.title}</h2>
                        <span className="wmap-count mono">{items.length}</span>
                      </header>
                      <ul className="wmap-tiles">
                        {items.map((w) => (
                          <li key={w.id} id={`wisp-${w.id}`} className={isLead(w.id) ? "wmap-tile-wrap wmap-tile-wrap--lead" : "wmap-tile-wrap"}>
                            {legacyIds(w).map((old) => (
                              <span key={old} id={`wisp-${old}`} className="wmap-anchor" />
                            ))}
                            <Link
                              href={`/wisps/${w.slug}`}
                              className="wmap-tile"
                              data-level={w.level ?? "none"}
                              data-kind={w.kind}
                              title={`${w.number} · ${w.name}${w.level ? ` · ${levels[w.level]}` : ""}`}
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
            </li>
          );
        })}
      </ol>
    </div>
  );
}
