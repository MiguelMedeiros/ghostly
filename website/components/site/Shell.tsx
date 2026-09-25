import type { Locale } from "@/lib/i18n";
import { LOCALE_META } from "@/lib/i18n";
import { shell } from "@/content/shell";
import { Nav } from "./Nav";
import { SiteFooter } from "./Footer";
import { GhostPet } from "./GhostPet";
import { GhostSwarm } from "./GhostSwarm";
import { HtmlLang } from "./HtmlLang";
import { JoinLanding } from "./JoinLanding";

export function Shell({ locale = "en", children }: { locale?: Locale; children: React.ReactNode }) {
  const t = shell[locale];
  return (
    <div lang={locale === "en" ? undefined : LOCALE_META[locale].html}>
      {locale !== "en" && <HtmlLang lang={LOCALE_META[locale].html} />}
      <a className="skip-link" href="#content">
        {t.skip}
      </a>
      <Nav locale={locale} />
      <main id="content">{children}</main>
      <SiteFooter locale={locale} />
      <GhostPet label={t.pet} />
      <GhostSwarm />
      <JoinLanding locale={locale} />
    </div>
  );
}
