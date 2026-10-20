import { LevelBadge } from "@/components/site/Level";
import { Icon } from "@/components/site/icons";
import { Ghost } from "@/components/ghost/Ghost";
import { brandPage, SECTIONS } from "@/content/brand";
import brand from "@/lib/brand/brand.json";
import { KIT_ZIP } from "@/lib/brand/kit.mjs";
import { OG_IMAGE } from "@/lib/pageMeta";
import { Logo } from "./Drawing";
import { Section, Sub } from "./parts";

const head = (id: string) => SECTIONS.find((s) => s.id === id)!;
const classicDark = brand.colors.app.themes[0].values;
const classicLight = brand.colors.app.themes[1].values;

function Tokens({ list }: { list: string[] }) {
  return (
    <p className="br-tokens mono">
      {list.map((x) => (
        <span key={x}>{x}</span>
      ))}
    </p>
  );
}

export function UiSection() {
  const t = brandPage.ui;
  const s = head("ui");
  return (
    <Section id={s.id} n={s.n} title={s.title} lead={t.lead}>
      <div className="br-grid br-grid--2">
        <Sub title={t.buttons}>
          <div className="br-panel br-ui">
            <div className="br-ui-row">
              <span className="btn btn--primary" aria-hidden="true">
                {t.primary}
              </span>
              <span className="btn" aria-hidden="true">
                <Icon name="download" />
                {t.secondary}
              </span>
            </div>
            <Tokens list={[".btn--primary", "cyan → green 100deg", "ink #031018", "radius 14px", "min-height 48px", "weight 650"]} />
          </div>
        </Sub>
        <Sub title={t.cards}>
          <div className="br-panel br-ui">
            <div className="card br-ui-card">
              <Icon name="route" className="br-ui-card-icon" />
              <strong className="h-card">{t.cardTitle}</strong>
              <p className="muted">{t.cardText}</p>
            </div>
            <Tokens list={[".card", "Shade 2 → Shade", "border Line", "radius 18px"]} />
          </div>
        </Sub>
        <Sub title={t.bubbles}>
          <div className="br-panel br-ui">
            <div className="br-bubbles">
              {[classicDark, classicLight].map((v, i) => (
                <div key={i} className="br-bubbles-chat" style={{ background: v["chat-bg"], color: v["text-primary"] }}>
                  <p className="br-theme-bubble" style={{ background: v["received-bg"] }}>
                    {t.bubbleIn}
                  </p>
                  <p className="br-theme-bubble br-theme-bubble--out" style={{ background: v["sent-bg"] }}>
                    {t.bubbleOut}
                  </p>
                </div>
              ))}
            </div>
            <Tokens list={["--color-sent-bg", "--color-received-bg", "--color-text-primary", "radius 8px", "system font 14px"]} />
          </div>
        </Sub>
        <Sub title={t.badges}>
          <div className="br-panel br-ui">
            <div className="br-ui-row">
              <LevelBadge level="available" />
              <LevelBadge level="planned" />
              <LevelBadge level="research" />
              <span className="chip">Draft</span>
              <span className="chip">WISP 1200</span>
            </div>
            <Tokens list={[".level", "Casper mint · Sky · Shade ghost", "10% fill, 30% border", ".chip mono 11px uppercase"]} />
          </div>
        </Sub>
      </div>
    </Section>
  );
}

export function ApplicationsSection() {
  const t = brandPage.applications;
  const s = head("applications");
  return (
    <Section id={s.id} n={s.n} title={s.title} lead={t.lead}>
      <div className="br-grid br-grid--2">
        <Sub title={t.og} note={t.ogText}>
          <figure className="br-app-og">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/og-image.png" alt={OG_IMAGE.alt} width={OG_IMAGE.width} height={OG_IMAGE.height} loading="lazy" decoding="async" />
          </figure>
        </Sub>
        <Sub title={t.social} note={t.socialText}>
          <div className="br-app-social" role="img" aria-label={`A square post: "${brand.foundation.taglineShort}" ${t.socialLine}`}>
            <div className="br-app-social-ghosts" aria-hidden="true">
              <Ghost who="boo" mood="happy" size={92} float={false} still />
              <Ghost who="casper" mood="talk" size={92} float={false} still />
            </div>
            <p className="br-app-social-title">{brand.foundation.taglineShort}</p>
            <p className="br-app-social-line">{t.socialLine}</p>
            <Logo variant="lockup" fill="#22d3ee" className="br-app-social-logo" />
          </div>
        </Sub>
      </div>
      <Sub title={t.slide} note={t.slideText}>
        <div className="br-app-slide" role="img" aria-label={`A title slide: ${t.slideTitle}`}>
          <span className="eyebrow">{t.slideEyebrow}</span>
          <p className="br-app-slide-title">{t.slideTitle}</p>
          <Logo variant="icon" fill="#22d3ee" className="br-app-slide-icon" />
          <span className="br-app-slide-n mono" aria-hidden="true">
            04
          </span>
        </div>
      </Sub>
      <Sub title={t.stores}>
        <dl className="br-naming">
          {t.storeList.map((x) => (
            <div key={x.store}>
              <dt>{x.store}</dt>
              <dd>{x.text}</dd>
            </div>
          ))}
        </dl>
      </Sub>
    </Section>
  );
}

export function UseSection() {
  const t = brandPage.use;
  const s = head("use");
  const { press } = brand;
  return (
    <Section id={s.id} n={s.n} title={s.title} lead={t.lead}>
      <div className="br-grid br-grid--2">
        <div className="br-panel br-may">
          <h3 className="br-sub-title">{t.may}</h3>
          <ul className="br-rules">
            {t.mayList.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
        <div className="br-panel br-maynot">
          <h3 className="br-sub-title">{t.mayNot}</h3>
          <ul className="br-rules">
            {t.mayNotList.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      </div>
      <p className="note br-after">{t.fork}</p>
      <Sub title={t.contact}>
        <div className="br-panel br-contact" >
          <p>
            <a className="link-arrow br-contact-mail" href={`mailto:${press.contact}`}>
              {press.contact}
            </a>
          </p>
          <p className="muted">{t.contactText}</p>
          <p className="note">
            {t.maker} <a href={press.maker.url}>{press.maker.name}</a> · {press.license} License ·{" "}
            <a href={press.repo}>Source code</a>
          </p>
        </div>
      </Sub>
    </Section>
  );
}

export function KitSection({ size, files, logos, base }: { size?: string; files: number; logos: number; base: string }) {
  const t = brandPage.kit;
  const s = head("press-kit");
  const folders = [
    { dir: "logo/", text: t.folders.logo, href: `${base}/logo/svg/ghostly-lockup-cyan.svg` },
    { dir: "colors/", text: t.folders.colors, href: `${base}/colors/ghostly-colors.ase` },
    { dir: "fonts/", text: t.folders.fonts, href: `${base}/fonts/FONTS.txt` },
    { dir: "screenshots/", text: t.folders.screenshots, href: `${base}/screenshots/ghostly-chat.webp` },
    { dir: "social/", text: t.folders.social, href: `${base}/social/ghostly-og-image.png` },
    { dir: "README.txt", text: t.folders.text, href: `${base}/boilerplate.txt` },
  ];
  return (
    <Section id={s.id} n={s.n} title={s.title} lead={t.lead}>
      <div className="br-panel br-kit">
        <a className="btn btn--primary btn--lg" href={`/brand/${KIT_ZIP}`} download>
          <Icon name="download" />
          {t.download}
        </a>
        <p className="caption">
          {files} files, {logos} logos{size ? ` · ${size}` : ""}
        </p>
      </div>
      <Sub title={t.inside}>
        <ul className="br-kit-list">
          {folders.map((f) => (
            <li key={f.dir}>
              <a className="mono" href={f.href}>
                {f.dir}
              </a>
              <span className="muted">{f.text}</span>
            </li>
          ))}
        </ul>
      </Sub>
    </Section>
  );
}
