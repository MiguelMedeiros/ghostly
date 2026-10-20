import { notations } from "@/lib/brand/color.mjs";

/** Where the press kit's files are served (scripts/brand-kit.mjs writes them to public/brand/). */
export const KIT_BASE = "/brand/ghostly-press-kit";

/** A numbered chapter of the manual: its number, title and lead, then the content. */
export function Section({ id, n, title, lead, children }: { id: string; n: string; title: string; lead: string; children: React.ReactNode }) {
  return (
    <section id={id} className="br-section" aria-labelledby={`${id}-title`}>
      <header className="br-section-head">
        <span className="br-num mono" aria-hidden="true">
          {n}
        </span>
        <h2 id={`${id}-title`} className="h-scene">
          {title}
        </h2>
        <p className="lead">{lead}</p>
      </header>
      {children}
    </section>
  );
}

export function Sub({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <div className="br-sub">
      <h3 className="br-sub-title">{title}</h3>
      {note && <p className="note br-sub-note">{note}</p>}
      {children}
    </div>
  );
}

/** A colour with its four notations. */
export function Swatch({ name, hex, role, token, share, small }: { name: string; hex: string; role: string; token?: string; share?: number; small?: boolean }) {
  const n = notations(hex);
  return (
    <figure className={`br-swatch ${small ? "br-swatch--sm" : ""}`}>
      <div className="br-swatch-chip" style={{ background: hex }} aria-hidden="true" />
      <figcaption>
        <div className="br-swatch-name">
          <strong>{name}</strong>
          {share !== undefined && <span className="mono dim">{share}%</span>}
        </div>
        <dl className="br-swatch-codes mono">
          <dt>HEX</dt>
          <dd>{n.hex}</dd>
          {!small && (
            <>
              <dt>RGB</dt>
              <dd>{n.rgb}</dd>
              <dt>HSL</dt>
              <dd>{n.hsl}</dd>
              <dt>OKLCH</dt>
              <dd>{n.oklch}</dd>
            </>
          )}
          {token && (
            <>
              <dt>CSS</dt>
              <dd>{token}</dd>
            </>
          )}
        </dl>
        <p className="br-swatch-role">{role}</p>
      </figcaption>
    </figure>
  );
}

/** A file link pill: SVG, PNG 1x... */
export function FileLinks({ svg, png, label }: { svg: string; png: { scale: number; path: string }[]; label: string }) {
  return (
    <p className="br-files">
      <a href={`${KIT_BASE}/${svg}`} download aria-label={`${label}, SVG`}>
        SVG
      </a>
      {png.map((p) => (
        <a key={p.scale} href={`${KIT_BASE}/${p.path}`} download aria-label={`${label}, PNG ${p.scale}x`}>
          PNG {p.scale}x
        </a>
      ))}
    </p>
  );
}
