import { brandPage, SECTIONS } from "@/content/brand";
import brand from "@/lib/brand/brand.json";
import { NEEDS, contrast } from "@/lib/brand/color.mjs";
import { Section, Sub, Swatch } from "./parts";

const head = (id: string) => SECTIONS.find((s) => s.id === id)!;

function Mark({ ok }: { ok: boolean }) {
  const t = brandPage.color;
  return (
    <span className={`br-mark ${ok ? "br-mark--ok" : "br-mark--no"}`}>
      <span aria-hidden="true">{ok ? "✓" : "✕"}</span> {ok ? t.pass : t.fail}
    </span>
  );
}

/** A small chat in one of the app's themes: its list colour, chat colour, bubbles, link and accent. */
function ThemeCard({ theme }: { theme: (typeof brand.colors.app.themes)[number] }) {
  const v = theme.values;
  return (
    <figure className="br-theme" style={{ background: v["chat-bg"], color: v["text-primary"] }}>
      <div className="br-theme-bar" style={{ background: v["sidebar-bg"], color: v["text-primary"] }}>
        <span className="br-theme-avatar" style={{ background: v["surface-alt"], color: v["text-secondary"] }} aria-hidden="true">
          A
        </span>
        <span>
          <strong>Ana</strong>
          <small style={{ color: v["text-secondary"] }}>online</small>
        </span>
      </div>
      <div className="br-theme-chat">
        <p className="br-theme-bubble" style={{ background: v["received-bg"] }}>
          Notes: <span style={{ color: v.link, textDecoration: "underline" }}>ghostly.tools</span>
        </p>
        <p className="br-theme-bubble br-theme-bubble--out" style={{ background: v["sent-bg"] }}>
          On my way.
        </p>
        <span className="br-theme-accent" style={{ background: v.accent, color: v["on-accent"] }}>
          Pay 2,100 sats
        </span>
      </div>
      <figcaption style={{ background: v["sidebar-bg"], color: v["text-secondary"] }}>
        <strong style={{ color: v["text-primary"] }}>{theme.name}</strong>
        {theme.default ? " · default" : ""}
        <span className="mono"> accent {v.accent}</span>
      </figcaption>
    </figure>
  );
}

export function ColorSection() {
  const t = brandPage.color;
  const s = head("color");
  const { core, extended, app, contrast: pairs } = brand.colors;
  return (
    <Section id={s.id} n={s.n} title={s.title} lead={t.lead}>
      <Sub title={t.core}>
        <ul className="br-grid br-grid--swatches">
          {core.map((c) => (
            <li key={c.id}>
              <Swatch name={c.name} hex={c.hex} role={c.role} token={c.site ? `var(${c.site})` : undefined} share={c.share} />
            </li>
          ))}
        </ul>
      </Sub>
      <Sub title={t.usage} note={t.usageText}>
        <div className="br-ratio" role="img" aria-label={core.map((c) => `${c.name} ${c.share}%`).join(", ")}>
          {core.map((c) => (
            <span key={c.id} style={{ flexGrow: c.share, background: c.hex }} title={`${c.name} ${c.share}%`} />
          ))}
        </div>
        <ul className="br-ratio-legend caption">
          {core.map((c) => (
            <li key={c.id}>
              <i style={{ background: c.hex }} aria-hidden="true" />
              {c.name} {c.share}%
            </li>
          ))}
        </ul>
      </Sub>
      <Sub title={t.extended}>
        <ul className="br-grid br-grid--swatches-sm">
          {extended.map((c) => (
            <li key={c.id}>
              <Swatch name={c.name} hex={c.hex} role={c.role} token={c.site ? `var(${c.site})` : c.theme ? c.theme.replace("--color-", "") : undefined} small />
            </li>
          ))}
        </ul>
      </Sub>
      <Sub title={t.app} note={app.note}>
        <ul className="br-grid br-grid--4 br-themes">
          {app.themes.map((theme) => (
            <li key={theme.name}>
              <ThemeCard theme={theme} />
            </li>
          ))}
        </ul>
      </Sub>
      <Sub title={t.contrast} note={t.contrastText}>
        <div className="br-table-wrap" role="region" aria-label={t.contrast} tabIndex={0}>
          <table className="br-table br-contrast">
            <thead>
              <tr>
                <th scope="col">{t.headers.pair}</th>
                <th scope="col">{t.headers.ratio}</th>
                <th scope="col">{t.headers.aa}</th>
                <th scope="col">{t.headers.aaa}</th>
                <th scope="col">{t.headers.use}</th>
              </tr>
            </thead>
            <tbody>
              {pairs.map((p) => {
                const ratio = contrast(p.fg, p.bg);
                const large = p.use !== "text";
                const aa = ratio >= (large ? NEEDS.large : NEEDS.text);
                const aaa = ratio >= (large ? 4.5 : 7);
                return (
                  <tr key={p.label} data-use={p.use}>
                    <th scope="row">
                      <div className="br-pair-cell">
                        {/* Drawn, not set as text: the pair shown as a don't must fail, and a checker reading the page's text would flag it. */}
                        <svg className="br-sample" viewBox="0 0 44 34" aria-hidden="true" focusable="false">
                          <rect width="44" height="34" rx="8" fill={p.bg} />
                          <text x="22" y="22.5" textAnchor="middle" fontSize="16" fontWeight="700" fill={p.fg}>
                            Aa
                          </text>
                        </svg>
                        <span>
                          {p.label}
                          <small className="mono dim">
                            {p.fg} on {p.bg}
                          </small>
                        </span>
                      </div>
                    </th>
                    <td className="mono">{ratio.toFixed(2)}:1</td>
                    <td>
                      <Mark ok={aa} />
                    </td>
                    <td>
                      <Mark ok={aaa} />
                    </td>
                    <td>{t.uses[p.use as keyof typeof t.uses]}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Sub>
    </Section>
  );
}

export function TypeSection() {
  const t = brandPage.type;
  const s = head("type");
  const { families, scale } = brand.type;
  const font = (id: string) => (id === "mono" ? "var(--font-jetbrains), ui-monospace, monospace" : id === "system" ? families[2].fallback : "var(--font-inter), system-ui, sans-serif");
  return (
    <Section id={s.id} n={s.n} title={s.title} lead={t.lead}>
      <Sub title={t.families}>
        <ul className="br-grid br-grid--3 br-families">
          {families.map((f) => (
            <li key={f.id} className="br-panel br-family">
              <p className="br-family-aa" style={{ fontFamily: font(f.id) }} aria-hidden="true">
                Aa
              </p>
              <strong>{f.name}</strong>
              <p className="muted">{f.role}</p>
              <p className="br-weights" style={{ fontFamily: font(f.id) }}>
                {f.weights.map((w) => (
                  <span key={w} style={{ fontWeight: w }}>
                    {w}
                  </span>
                ))}
              </p>
              <p className="mono br-fallback">font-family: {f.fallback};</p>
              {f.links.length > 0 && (
                <p className="br-files">
                  {f.links.map((l) => (
                    <a key={l.href} href={l.href}>
                      {l.label} ↗
                    </a>
                  ))}
                </p>
              )}
              <p className="note">{f.license}</p>
            </li>
          ))}
        </ul>
      </Sub>
      <Sub title={t.scale} note={t.scaleText}>
        <ol className="br-scale">
          {scale.map((r) => (
            <li key={r.token}>
              <p
                className="br-scale-sample"
                style={{ fontFamily: font(r.family), fontSize: `min(${r.sample}px, ${(r.sample / 3.4).toFixed(1)}vw + 12px)`, lineHeight: r.lineHeight, letterSpacing: r.tracking, fontWeight: r.weight, textTransform: r.family === "mono" ? "uppercase" : undefined }}
              >
                {r.family === "mono" ? t.mono : t.specimen}
              </p>
              <p className="br-scale-meta mono">
                <span>{r.name}</span>
                <span>{r.size}</span>
                <span>
                  {t.headers.line} {r.lineHeight}
                </span>
                <span>
                  {t.headers.weight} {r.weight}
                </span>
                <span className="dim">{r.token}</span>
              </p>
              <p className="note">{r.use}</p>
            </li>
          ))}
        </ol>
      </Sub>
      <Sub title={t.rules}>
        <ul className="br-rules">
          {t.rulesList.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </Sub>
    </Section>
  );
}
