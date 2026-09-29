import { Ghost } from "@/components/ghost/Ghost";
import { Icon } from "@/components/site/icons";
import { NEXT_VERSION } from "@/lib/status";
import type { HomeCopy } from "@/content/home";
import { Reveal } from "./Reveal";
import { WalletDeck } from "./WalletDeck";
import "@/app/space.css";

const PROFILE_COLORS = ["#22d3ee", "#a78bfa", "#4ade80"];
const THEMES = [
  { name: "Classic", c: ["#00a884", "#0b141a"] },
  { name: "Monochrome", c: ["#e5e7eb", "#111"] },
  { name: "Cyan", c: ["#22d3ee", "#060a10"] },
  { name: "Purple", c: ["#a78bfa", "#130d24"] },
];

/**
 * The chapter's one idea, then my things laid out on a desk: the Profile page
 * in a window on the left, three features on a quiet rail on the right (one
 * sentence, a visual, a caption-sized honesty note), and the wallet deck as a
 * set piece on a full-bleed band below.
 */
export function SpaceSection({ t, w, shotLabel }: { t: HomeCopy["space"]; w: HomeCopy["wallets"]; shotLabel: string }) {
  return (
    <section className="sp-section" id="space">
      <div className="wrap">
        <Reveal>
          <div className="sp-head">
            <span className="eyebrow">{t.eyebrow}</span>
            <h2 className="h-display">{t.title}</h2>
            <p className="lead">{t.lead}</p>
          </div>

          <div className="sp-desk">
            <figure className="sp-shot">
              <div className="sp-window">
                <div className="sp-window-bar" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="sp-window-body">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/screenshots/current/profiles.webp" alt="The Profile page with three profiles, Personal, Work and Club, and backups above them" loading="lazy" width={1280} height={820} />
                </div>
              </div>
              <figcaption className="caption">{shotLabel.replace("{n}", NEXT_VERSION)}</figcaption>
            </figure>

            <div className="sp-rail">
              <article className="sp-feature">
                <div className="sp-feature-head">
                  <h3 className="h-card">{t.profiles.title}</h3>
                </div>
                <div className="sp-chips" aria-hidden="true">
                  {t.profiles.names.map((name, i) => (
                    <div key={name} className="sp-chip" style={{ "--c": PROFILE_COLORS[i], "--i": i } as React.CSSProperties}>
                      <span className="sp-avatar">
                        <Ghost color={PROFILE_COLORS[i]} mood={i === 0 ? "happy" : i === 1 ? "calm" : "wink"} size={30} float={false} />
                      </span>
                      <span>{name}</span>
                    </div>
                  ))}
                </div>
                <p className="caption sp-note">{t.profiles.note}</p>
              </article>

              <article className="sp-feature">
                <div className="sp-feature-head">
                  <h3 className="h-card">{t.backup.title}</h3>
                </div>
                <div className="sp-flow">
                  <div className="sp-box">
                    <strong>
                      <Icon name="lock" /> {t.backup.what}
                    </strong>
                    <ul>
                      {t.backup.whatItems.map((x) => (
                        <li key={x}>{x}</li>
                      ))}
                    </ul>
                  </div>
                  <span className="sp-arrow" aria-hidden="true">
                    →
                  </span>
                  <div className="sp-box sp-box--where">
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
                <p className="caption sp-note">{t.backup.note}</p>
              </article>

              <article className="sp-feature">
                <div className="sp-feature-head">
                  <h3 className="h-card">{t.look.title}</h3>
                </div>
                <div className="sp-look" aria-hidden="true">
                  <span className="sp-swatches">
                    {THEMES.map((th) => (
                      <span key={th.name} className="sp-swatch" style={{ background: `linear-gradient(135deg, ${th.c[0]} 0 50%, ${th.c[1]} 50%)` }} title={th.name} />
                    ))}
                  </span>
                  <span className="sp-langs mono">EN · PT · ES · FR · IT · 日本語 · 中文 · العربية</span>
                </div>
                <p className="caption sp-note">{t.look.note}</p>
              </article>
            </div>
          </div>
        </Reveal>

        <Reveal className="sp-band">
          <div className="wrap">
            <div className="sp-band-head">
              <h3 className="h-section">{w.title}</h3>
              <p className="lead">{w.lead}</p>
            </div>
            <WalletDeck t={w} />
            <p className="note sp-testnet">{w.testnet}</p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
