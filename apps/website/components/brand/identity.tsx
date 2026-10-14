import { CopyButton } from "@/components/cli/CopyButton";
import { brandPage, SECTIONS } from "@/content/brand";
import brand from "@/lib/brand/brand.json";
import { logoFiles } from "@/lib/brand/kit.mjs";
import { EYE, lockup, lockupGeometry } from "@/lib/brand/logo.mjs";
import { Logo, type DrawingData } from "./Drawing";
import { FileLinks, Section, Sub } from "./parts";

const head = (id: string) => SECTIONS.find((s) => s.id === id)!;
const CYAN = "#22d3ee";
const NIGHT = "#060a10";

export function FoundationSection() {
  const t = brandPage.foundation;
  const f = brand.foundation;
  const s = head("foundation");
  return (
    <Section id={s.id} n={s.n} title={s.title} lead={t.lead}>
      <figure className="br-statement">
        <figcaption className="caption">{t.oneLine}</figcaption>
        <blockquote>{f.oneLine}</blockquote>
      </figure>
      <div className="br-grid br-grid--2">
        <div className="br-panel">
          <p className="caption">{t.promise}</p>
          <p className="br-promise">{f.promise}</p>
        </div>
        <div className="br-panel">
          <p className="caption">{t.tagline}</p>
          <p className="br-tagline">{f.tagline}</p>
        </div>
      </div>
      <Sub title={t.traits}>
        <ul className="br-grid br-grid--4 br-traits">
          {f.traits.map((trait) => (
            <li key={trait.name} className="br-panel">
              <strong>{trait.name}</strong>
              <p className="muted">{trait.text}</p>
            </li>
          ))}
        </ul>
      </Sub>
      <Sub title={t.isNot}>
        <ul className="br-nots">
          {f.isNot.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Sub>
      <Sub title={t.boilerplate}>
        <div className="br-grid br-grid--2">
          {(["short", "long"] as const).map((k) => (
            <div key={k} className="br-panel br-boiler">
              <p className="caption">{t[k]}</p>
              <p>{f.boilerplate[k]}</p>
              <CopyButton text={f.boilerplate[k]} label={`${t.copy} (${t[k].toLowerCase()})`} done={t.copied} />
            </div>
          ))}
        </div>
      </Sub>
    </Section>
  );
}

/** The lockup inside its clear space, with the eye unit drawn in the margin. */
function ClearSpace() {
  const g = lockupGeometry();
  const b = brand.logo.bodyBox;
  const m = brand.logo.clearSpaceE * EYE;
  const pad = 10;
  const box = { x: b.x - m, y: b.y - m, w: g.width + 2 * m, h: b.height + 2 * m };
  const shapes = (lockup(CYAN) as DrawingData).shapes;
  const eyes = Array.from({ length: brand.logo.clearSpaceE }, (_, i) => b.x - m + EYE / 2 + i * EYE);
  return (
    <svg className="br-clear" viewBox={`${box.x - pad} ${box.y - pad} ${box.w + 2 * pad} ${box.h + 2 * pad}`} role="img" aria-label={`The logo inside a margin of ${brand.logo.clearSpaceE} eye-widths on every side`}>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} fill="rgba(34,211,238,0.06)" stroke="rgba(34,211,238,0.5)" strokeDasharray="2 2" strokeWidth="0.4" />
      <rect x={b.x} y={b.y} width={g.width} height={b.height} fill="none" stroke="rgba(232,237,245,0.35)" strokeDasharray="1.5 1.5" strokeWidth="0.3" />
      {shapes.map((s, i) => (
        <path key={i} d={s.d} fill={s.fill} fillRule={s.evenOdd ? "evenodd" : undefined} transform={s.transform} />
      ))}
      {eyes.map((cx) => (
        <circle key={cx} cx={cx} cy={b.y - m / 2} r={EYE / 2} fill="none" stroke="#a3b0c2" strokeWidth="0.4" />
      ))}
      {eyes.map((cx) => (
        <circle key={`l${cx}`} cx={b.x - m / 2} cy={b.y + EYE / 2 + (cx - (b.x - m + EYE / 2))} r={EYE / 2} fill="none" stroke="#a3b0c2" strokeWidth="0.4" />
      ))}
      <text x={b.x + EYE * brand.logo.clearSpaceE - m + 3} y={b.y - m / 2 + 1.6} fontSize="5" fill="#a3b0c2" fontFamily="var(--font-jetbrains), monospace">
        {brand.logo.clearSpaceE}E
      </text>
      <circle cx={b.x + 11} cy={b.y + 16} r={EYE / 2 + 1.2} fill="none" stroke="#fbbf24" strokeWidth="0.5" />
      <text x={b.x + 11} y={b.y + 30} fontSize="4.2" fill="#fbbf24" textAnchor="middle" fontFamily="var(--font-jetbrains), monospace">
        E
      </text>
    </svg>
  );
}

/** The six misuses, each on the real lockup. */
function Dont({ id }: { id: string }) {
  if (id === "outline") {
    const d = lockup(CYAN) as DrawingData;
    return (
      <svg viewBox={d.viewBox.join(" ")} className="br-dont-logo" aria-hidden="true">
        {d.shapes.map((s, i) => (
          <path key={i} d={s.d} fill="none" stroke={CYAN} strokeWidth={s.transform ? 2.4 : 0.8} fillRule="evenodd" transform={s.transform} />
        ))}
      </svg>
    );
  }
  const fill = id === "recolor" ? "#f472b6" : id === "busy" ? "#ffffff" : CYAN;
  return <Logo variant="lockup" fill={fill} className={`br-dont-logo br-dont--${id}`} />;
}

export function LogoSection() {
  const t = brandPage.logo;
  const s = head("logo");
  const files = logoFiles();
  const cyan = (variant: string) => files.find((f) => f.variant === variant && (f.colorway === "cyan" || variant === "tile"))!;
  const bgs = [
    { id: "night", bg: NIGHT, way: "cyan", label: "Ghost cyan on Night" },
    { id: "white", bg: "#ffffff", way: "navy", label: "Night on white" },
    { id: "cyan", bg: CYAN, way: "navy", label: "Night on Ghost cyan" },
    { id: "photo", bg: NIGHT, way: "white", label: "White on a dark picture" },
  ];
  return (
    <Section id={s.id} n={s.n} title={s.title} lead={t.lead}>
      <Sub title={t.variants}>
        <ul className="br-grid br-variants">
          {(["lockup", "icon", "wordmark", "tile"] as const).map((v) => {
            const f = cyan(v);
            const name = t.variantNames[v];
            return (
              <li key={v} className="br-panel br-variant">
                <div className={`br-stage br-stage--${v}`}>
                  <Logo variant={v} fill={CYAN} label={`Ghostly ${name.toLowerCase()}`} className={`br-variant-logo br-variant-logo--${v}`} />
                </div>
                <strong>{name}</strong>
                <p className="muted">{t.variantUse[v]}</p>
                <FileLinks svg={f.svg} png={f.png} label={`${name}, ${v === "tile" ? "on its tile" : "Ghost cyan"}`} />
              </li>
            );
          })}
        </ul>
        <p className="note br-after">{t.wordmarkNote}</p>
      </Sub>

      <Sub title={t.clear} note={t.clearText(brand.logo.clearSpaceE)}>
        <div className="br-panel br-clear-wrap">
          <ClearSpace />
        </div>
      </Sub>

      <Sub title={t.minimum}>
        <ul className="br-grid br-grid--3 br-min">
          {brand.logo.minimum.map((m) => (
            <li key={m.variant} className="br-panel">
              <div className="br-min-stage">
                <Logo variant={m.variant as "lockup"} fill={CYAN} style={{ width: m.px }} label={`Ghostly ${t.variantNames[m.variant as "lockup"].toLowerCase()} at ${m.px} pixels wide`} />
              </div>
              <strong>{t.variantNames[m.variant as "lockup"]}</strong>
              <p className="mono br-min-size">
                {m.px} px · {m.mm} mm
              </p>
              <p className="note">{m.note}</p>
            </li>
          ))}
        </ul>
      </Sub>

      <Sub title={t.backgrounds} note={t.backgroundsText}>
        <ul className="br-grid br-grid--4 br-bgs">
          {bgs.map((b) => {
            const way = brand.logo.colorways.find((w) => w.id === b.way)!;
            const f = files.find((x) => x.variant === "lockup" && x.colorway === b.way)!;
            return (
              <li key={b.id} className="br-bg">
                <div className={`br-bg-stage br-bg-stage--${b.id}`} style={{ background: b.bg }}>
                  <Logo variant="lockup" fill={way.fill} label={`Ghostly logo, ${b.label}`} />
                </div>
                <p className="br-bg-label">{b.label}</p>
                <FileLinks svg={f.svg} png={f.png.slice(0, 1)} label={`Logo, ${way.name}`} />
              </li>
            );
          })}
        </ul>
        <p className="note br-after">
          {brand.logo.colorways.map((w) => `${w.name}: ${w.use}`).join(" ")}
        </p>
      </Sub>

      <Sub title={t.donts}>
        <ul className="br-grid br-grid--3 br-donts">
          {brand.logo.donts.map((d) => (
            <li key={d.id} className="br-dont">
              <div className={`br-dont-stage br-dont-stage--${d.id}`}>
                <Dont id={d.id} />
                <span className="br-dont-x" aria-hidden="true">
                  ✕
                </span>
              </div>
              <p>{d.text}</p>
            </li>
          ))}
        </ul>
      </Sub>
    </Section>
  );
}

