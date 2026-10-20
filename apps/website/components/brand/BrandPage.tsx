import { statSync } from "node:fs";
import { join } from "node:path";
import { Shell } from "@/components/site/Shell";
import { CopyButton } from "@/components/cli/CopyButton";
import { Icon } from "@/components/site/icons";
import { brandPage, SECTIONS } from "@/content/brand";
import brand from "@/lib/brand/brand.json";
import { KIT_ZIP, kitEntries, logoFiles } from "@/lib/brand/kit.mjs";
import { Logo } from "./Drawing";
import { KIT_BASE } from "./parts";
import { FoundationSection, LogoSection } from "./identity";
import { ColorSection, TypeSection } from "./system";
import { IconsSection, ImagerySection, VoiceSection } from "./expression";
import { ApplicationsSection, KitSection, UiSection, UseSection } from "./use";
import "@/app/brand.css";

/** The zip's size, read when the page is built (prebuild writes the kit first); none if it is not there. */
function zipSize(): string | undefined {
  try {
    const bytes = statSync(join(process.cwd(), "public/brand", KIT_ZIP)).size;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  } catch {
    return undefined;
  }
}

export function BrandPage() {
  const t = brandPage;
  const size = zipSize();
  const files = kitEntries().length;
  return (
    <Shell>
      <section className="br-hero">
        <div className="wrap br-hero-grid">
          <div className="br-hero-copy">
            <span className="eyebrow">{t.hero.eyebrow}</span>
            <h1 className="h-display br-title">{t.hero.title}</h1>
            <p className="lead">{t.hero.lead}</p>
            <div className="br-actions">
              <a className="btn btn--primary" href={`/brand/${KIT_ZIP}`} download>
                <Icon name="download" />
                {t.hero.download}
              </a>
              <CopyButton text={brand.foundation.boilerplate.short} label={t.hero.copy} done={t.hero.copied} />
            </div>
            <p className="caption">
              {KIT_ZIP} · {files} files{size ? ` · ${size}` : ""}
            </p>
          </div>
          <div className="br-hero-art" aria-hidden="true">
            <Logo variant="lockup" fill="#22d3ee" className="br-hero-lockup" />
            <Logo variant="tile" className="br-hero-tile" />
          </div>
        </div>
      </section>

      <div className="wrap br-layout">
        <nav className="br-toc" aria-label={t.hero.contents}>
          <p className="caption">{t.hero.contents}</p>
          <ol>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>
                  <span className="mono" aria-hidden="true">
                    {s.n}
                  </span>
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <div className="br-main">
          <FoundationSection />
          <LogoSection />
          <ColorSection />
          <TypeSection />
          <IconsSection />
          <ImagerySection />
          <VoiceSection />
          <UiSection />
          <ApplicationsSection />
          <UseSection />
          <KitSection size={size} files={files} logos={logoFiles().length} base={KIT_BASE} />
        </div>
      </div>
    </Shell>
  );
}
