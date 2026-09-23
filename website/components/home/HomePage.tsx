import { Shell } from "@/components/site/Shell";
import { Act } from "@/components/story/Act";
import { Statement } from "@/components/story/Statement";
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

/**
 * One film in two acts. Act I (hero → invitation → the DHT) and Act II
 * (agreement → live connection) each keep one Boo and one Casper on a pinned
 * backdrop while the chapters scroll over it; between the acts, one sentence
 * gets the whole screen. Then the product, your space, the architecture
 * opening under the ghosts, and the payoff.
 */
export function HomePage({ locale }: { locale: Locale }) {
  const t = home[locale];
  return (
    <Shell locale={locale}>
      <Act
        id="act-1"
        field
        bubble={t.hero.booSays}
        chapters={[
          { id: "hero", chapter: "hero", kind: "free" },
          { id: "invite", chapter: "invite" },
          { id: "dht", chapter: "dht" },
        ]}
      >
        <Hero t={t.hero} />
        <div id="story">
          <InviteScene eyebrow={t.invite.eyebrow} label={t.invite.label} steps={t.invite.steps} card={t.invite.card} />
          <DhtScene eyebrow={t.dht.eyebrow} label={t.dht.label} steps={t.dht.steps} tags={t.dht.tags} />
        </div>
      </Act>
      <Statement before={t.statement.before} accent={t.statement.accent} after={t.statement.after} />
      <Act
        id="act-2"
        chapters={[
          { id: "agree", chapter: "agree" },
          { id: "alive", chapter: "alive" },
        ]}
      >
        <AgreeScene eyebrow={t.agree.eyebrow} label={t.agree.label} steps={t.agree.steps} labels={t.agree} />
        <AliveScene eyebrow={t.alive.eyebrow} label={t.alive.label} steps={t.alive.steps} labels={t.alive} />
      </Act>
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
