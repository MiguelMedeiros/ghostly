import { Shell } from "@/components/site/Shell";
import { home } from "@/content/home";
import { href, type Locale } from "@/lib/i18n";
import { Hero } from "./Hero";
import { InviteScene } from "./InviteScene";
import { DhtScene } from "./DhtScene";
import { AgreeScene } from "./AgreeScene";
import { AliveScene } from "./AliveScene";
import { NextSection } from "./NextSection";
import { SpaceSection } from "./SpaceSection";
import { OpenScene } from "./OpenScene";
import { Finale } from "./Finale";
import { Legend } from "./Legend";
import "@/app/home.css";

export function HomePage({ locale }: { locale: Locale }) {
  const t = home[locale];
  return (
    <Shell locale={locale}>
      <Hero t={t.hero} />
      <div id="story">
        <InviteScene eyebrow={t.invite.eyebrow} label={t.invite.label} steps={t.invite.steps} card={t.invite.card} />
        <DhtScene eyebrow={t.dht.eyebrow} label={t.dht.label} steps={t.dht.steps} tags={t.dht.tags} />
        <AgreeScene eyebrow={t.agree.eyebrow} label={t.agree.label} steps={t.agree.steps} labels={t.agree} />
        <AliveScene eyebrow={t.alive.eyebrow} label={t.alive.label} steps={t.alive.steps} labels={t.alive} />
      </div>
      <NextSection t={t.next} locale={locale} />
      <Legend locale={locale} title={t.legend.title} draft={t.legend.draft} />
      <SpaceSection t={t.space} w={t.wallets} locale={locale} shotLabel={t.next.fromDev} />
      <OpenScene
        eyebrow={t.open.eyebrow}
        label={t.open.label}
        steps={t.open.steps}
        layers={t.open.layers}
        cta={t.open.cta}
        catalog={t.open.catalog}
        devHref={href(locale, "/developers")}
        catalogHref={href(locale, "/developers/catalog")}
      />
      <Finale t={t.finale} />
    </Shell>
  );
}
