import { Ghost } from "@/components/ghost/Ghost";
import { Icon } from "@/components/site/icons";
import { LevelBadge } from "@/components/site/Level";
import type { Locale } from "@/lib/i18n";
import { NEXT_VERSION } from "@/lib/status";
import type { HomeCopy } from "@/content/home";
import { Reveal } from "./Reveal";
import { WalletDeck } from "./WalletDeck";

const PROFILE_COLORS = ["#22d3ee", "#a78bfa", "#4ade80"];
const THEMES = [
  { name: "Classic", c: ["#00a884", "#0b141a"] },
  { name: "Monochrome", c: ["#e5e7eb", "#111"] },
  { name: "Cyan", c: ["#22d3ee", "#060a10"] },
  { name: "Purple", c: ["#a78bfa", "#130d24"] },
];

export function SpaceSection({ t, w, locale, shotLabel }: { t: HomeCopy["space"]; w: HomeCopy["wallets"]; locale: Locale; shotLabel: string }) {
  return (
    <section className="section space" id="space">
      <div className="wrap">
        <Reveal className="section-head">
          <span className="eyebrow">{t.eyebrow}</span>
          <h2 className="h-section">{t.title}</h2>
          <p className="lead">{t.lead}</p>
        </Reveal>

        <div className="space-grid">
          <Reveal className="card space-card space-profiles">
            <div className="space-card-head">
              <h3 className="h-card">{t.profiles.title}</h3>
              <LevelBadge level={t.profiles.level} locale={locale} />
            </div>
            <p className="muted">{t.profiles.body}</p>
            <div className="profile-stack" aria-hidden="true">
              {t.profiles.names.map((name, i) => (
                <div key={name} className="profile-chip" style={{ "--c": PROFILE_COLORS[i], "--i": i } as React.CSSProperties}>
                  <span className="profile-avatar">
                    <Ghost color={PROFILE_COLORS[i]} mood={i === 0 ? "happy" : i === 1 ? "calm" : "wink"} size={34} float={false} />
                  </span>
                  <span>{name}</span>
                </div>
              ))}
            </div>
            <p className="space-note">{t.profiles.note}</p>
          </Reveal>

          <Reveal className="card space-card space-backup">
            <div className="space-card-head">
              <h3 className="h-card">{t.backup.title}</h3>
              <LevelBadge level={t.backup.level} locale={locale} />
            </div>
            <p className="muted">{t.backup.body}</p>
            <div className="backup-flow">
              <div className="backup-box">
                <strong>
                  <Icon name="lock" /> {t.backup.what}
                </strong>
                <ul>
                  {t.backup.whatItems.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
              <span className="backup-arrow" aria-hidden="true">
                →
              </span>
              <div className="backup-box backup-box--where">
                <strong>
                  <Icon name="box" /> {t.backup.where}
                </strong>
                <ul>
                  {t.backup.whereItems.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="space-note">{t.backup.note}</p>
          </Reveal>

          <Reveal className="card space-card space-look">
            <div className="space-card-head">
              <h3 className="h-card">{t.look.title}</h3>
              <LevelBadge level={t.look.level} locale={locale} />
            </div>
            <p className="muted">{t.look.body}</p>
            <div className="theme-row" aria-hidden="true">
              {THEMES.map((th) => (
                <span key={th.name} className="theme-swatch" style={{ background: `linear-gradient(135deg, ${th.c[0]} 0 50%, ${th.c[1]} 50%)` }} title={th.name} />
              ))}
              <span className="theme-langs mono">EN · PT · ES · FR · IT · 日本語 · 中文 · العربية</span>
            </div>
          </Reveal>

          <Reveal className="space-shot">
            <figure>
              <div className="frame">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/screenshots/current/profiles.webp" alt="The Profile page listing two profiles, Boo and Haunted House, with backups above" loading="lazy" width={1280} height={820} />
              </div>
              <figcaption>{shotLabel.replace("{n}", NEXT_VERSION)}</figcaption>
            </figure>
          </Reveal>
        </div>

        <Reveal className="wallet-wrap">
          <div className="section-head wallet-head">
            <h3 className="h-section" style={{ fontSize: "clamp(28px,3.6vw,46px)" }}>
              {w.title}
            </h3>
            <p className="lead">{w.lead}</p>
          </div>
          <WalletDeck t={w} locale={locale} />
          <p className="space-note">{w.testnet}</p>
        </Reveal>
      </div>
    </section>
  );
}
