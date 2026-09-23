import Link from "next/link";
import { Icon } from "@/components/site/icons";
import { LevelBadge } from "@/components/site/Level";
import { NEXT_VERSION } from "@/lib/status";
import type { Locale } from "@/lib/i18n";
import type { HomeCopy } from "@/content/home";
import { Reveal } from "./Reveal";

type Shot = { src: string; alt: string; from: "dev" | "old"; mobile?: string };

// Real screens. Current ones are from the development build; two come from an
// earlier release because this build can't show them from the web client.
const SHOTS: Record<string, Shot> = {
  chat: { src: "/screenshots/current/chat.webp", alt: "A paired chat between Boo and Casper with delivery receipts", from: "dev", mobile: "/screenshots/current/chat-mobile.webp" },
  files: { src: "/screenshots/current/file.webp", alt: "An image sent in a chat, with its preview and a download button", from: "dev" },
  calls: { src: "/screenshots/current/app-audio-call.webp", alt: "An audio call in progress in the desktop app", from: "old" },
  sats: { src: "/screenshots/current/wallet-mainnet.webp", alt: "The wallet with Cashu, Lightning, Ark and USDT cards", from: "dev" },
  services: { src: "/screenshots/current/app-friend-app.webp", alt: "A contact's photo gallery, served from their computer, opened in the desktop app", from: "old" },
};

// Commands from docs/CLI.md; the watch line has the shape of the CLI's WatchEvent.
const CLI = `$ ghostly-cli identity new > ~/.ghostly-identity.json
$ ghostly-cli invite new --seed "$SEED"
$ ghostly-cli send --seed "$SEED" --peer "$PEER" --key "$KEY" "Boo! 👻"
$ ghostly-cli watch --seed "$SEED" --peer "$PEER" --key "$KEY"
{"from":"…","text":"deploy?","timestamp":1790000000,"nick":"Casper"}`;

export function NextSection({ t, locale }: { t: HomeCopy["next"]; locale: Locale }) {
  return (
    <section className="section next" id="next">
      <div className="wrap">
        <Reveal className="section-head">
          <span className="eyebrow">{t.eyebrow}</span>
          <h2 className="h-section">{t.title}</h2>
          <p className="lead">{t.lead}</p>
        </Reveal>
        <div className="next-rows">
          {t.items.map((item, i) => {
            const shot = SHOTS[item.id];
            return (
              <Reveal key={item.id} className={`next-row ${i % 2 ? "next-row--flip" : ""}`} id={`next-${item.id}`}>
                <div className="next-copy">
                  <span className="next-icon">
                    <Icon name={item.icon} />
                  </span>
                  <h3 className="h-card">{item.title}</h3>
                  <p className="muted">{item.body}</p>
                  <div className="next-badges">
                    <LevelBadge level={item.level} locale={locale} />
                    {"extraLevel" in item && item.extraLevel && <LevelBadge level={item.extraLevel} locale={locale} />}
                  </div>
                  {item.extra && <p className="next-extra">{item.extra}</p>}
                  {"link" in item && item.link && (
                    <Link className="link-arrow" href={item.link.href}>
                      {item.link.label} →
                    </Link>
                  )}
                </div>
                <figure className="next-media">
                  {shot ? (
                    <>
                      <div className="frame">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={shot.src} alt={shot.alt} loading="lazy" decoding="async" width={1280} height={820} />
                        {shot.mobile && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img className="frame-phone" src={shot.mobile} alt="" loading="lazy" decoding="async" width={390} height={844} />
                        )}
                      </div>
                      <figcaption>{shot.from === "dev" ? t.fromDev.replace("{n}", NEXT_VERSION) : t.fromOld}</figcaption>
                    </>
                  ) : (
                    <>
                      <pre className="terminal" aria-label="Example CLI session">
                        <code>{CLI}</code>
                      </pre>
                      <figcaption>{t.illustration}</figcaption>
                    </>
                  )}
                </figure>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
